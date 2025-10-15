import { NRelay1, NSecSigner } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { logger } from './logger.js';
import { Database } from './database.js';
import { GeminiAI } from './gemini.js';

/**
 * Simple Nostr AI Bot using Nostrify
 */
export class NostrBot {
  constructor(config) {
    this.config = config;
    this.relays = [];
    this.signer = null;
    this.pubkey = null;
    this.processedEvents = new Set();
    this.controllers = [];
    this.db = new Database('./data/conversations');
    
    // Initialize Gemini AI
    this.gemini = new GeminiAI(config.geminiApiKey, config.botName);
    
    // Statistics
    this.stats = {
      startTime: Date.now(),
      messagesReceived: 0,
      messagesSent: 0,
      errors: 0,
    };
    
    // Relay status tracking
    this.relayStatus = new Map();
  }

  /**
   * Initialize signer and get public key
   */
  async init() {
    // Convert hex or nsec to Uint8Array
    let secretKey;
    if (this.config.privateKey.startsWith('nsec1')) {
      const decoded = nip19.decode(this.config.privateKey);
      secretKey = decoded.data;
    } else {
      // Convert hex to Uint8Array
      const hex = this.config.privateKey;
      secretKey = new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }

    this.signer = new NSecSigner(secretKey);
    this.pubkey = await this.signer.getPublicKey();
    
    logger.info(`Bot public key: ${this.pubkey}`);
    logger.info(`Bot npub: ${nip19.npubEncode(this.pubkey)}`);
  }

  /**
   * Start the bot
   */
  async start() {
    logger.info('Starting ZapAI (Data Vending Machine) specialized for ZapAI platform...');

    // Initialize database
    await this.db.init();

    // Initialize signer
    await this.init();

    // Connect to each relay
    for (const relayUrl of this.config.relays) {
      try {
        const relay = new NRelay1(relayUrl);
        this.relays.push({ url: relayUrl, relay });
        
        // Initialize relay status
        this.relayStatus.set(relayUrl, {
          url: relayUrl,
          connected: true,
          lastSeen: Date.now(),
          messagesReceived: 0,
          messagesSent: 0,
          errors: 0,
          lastError: null,
        });
        
        logger.info(`Connected to relay: ${relayUrl}`);
      } catch (error) {
        logger.error(`Failed to connect to relay ${relayUrl}:`, error);
        
        this.relayStatus.set(relayUrl, {
          url: relayUrl,
          connected: false,
          lastSeen: null,
          messagesReceived: 0,
          messagesSent: 0,
          errors: 1,
          lastError: error.message,
        });
      }
    }

    if (this.relays.length === 0) {
      throw new Error('Failed to connect to any relays');
    }

    // Subscribe to DMs for this bot (only new messages from now)
    const filter = {
      kinds: [4],
      '#p': [this.pubkey],
      since: Math.floor(Date.now() / 1000), // Only new messages from now
    };

    logger.info('Bot is now listening for encrypted messages...');
    logger.info('Send a DM to start chatting!');

    // Listen to each relay
    for (const { url, relay } of this.relays) {
      const controller = new AbortController();
      this.controllers.push(controller);

      this.listenToRelay(relay, url, filter, controller.signal).catch(error => {
        logger.error(`Error listening to ${url}:`, error);
      });
    }
  }

  /**
   * Listen to a relay for incoming messages
   */
  async listenToRelay(relay, relayUrl, filter, signal) {
    while (!signal.aborted) {
      try {
        logger.debug(`Starting subscription to ${relayUrl}`);
        
        for await (const msg of relay.req([filter], { signal })) {
          if (msg[0] === 'EVENT') {
            const event = msg[2];
            // Handle event without blocking the loop
            this.handleEvent(event, relayUrl).catch(error => {
              logger.error(`Error handling event from ${relayUrl}:`, error);
            });
          } else if (msg[0] === 'EOSE') {
            logger.debug(`EOSE received from ${relayUrl}`);
          } else if (msg[0] === 'CLOSED') {
            logger.warn(`Subscription closed by ${relayUrl}: ${msg[1]}`);
            break; // Exit the for loop to reconnect
          }
        }
        
        // If we exit the loop and not aborted, wait before reconnecting
        if (!signal.aborted) {
          logger.info(`Reconnecting to ${relayUrl} in 5 seconds...`);
          await this.sleep(5000);
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          logger.debug(`Subscription to ${relayUrl} aborted`);
          break;
        }
        logger.error(`Relay ${relayUrl} error:`, error);
        
        // Wait before reconnecting
        if (!signal.aborted) {
          logger.info(`Reconnecting to ${relayUrl} in 5 seconds...`);
          await this.sleep(5000);
        }
      }
    }
  }

  /**
   * Handle incoming event
   */
  async handleEvent(event, relayUrl) {
    // Skip if already processed
    if (this.processedEvents.has(event.id)) {
      return;
    }
    this.processedEvents.add(event.id);

    // Keep only recent 1000 events in memory
    if (this.processedEvents.size > 1000) {
      const first = this.processedEvents.values().next().value;
      this.processedEvents.delete(first);
    }

    // Skip messages from the bot itself
    if (event.pubkey === this.pubkey) {
      return;
    }

    logger.info(`Received message from ${event.pubkey.substring(0, 8)}... on ${relayUrl}`);
    
    // Update stats
    this.stats.messagesReceived++;
    
    // Update relay status
    const relayStatus = this.relayStatus.get(relayUrl);
    if (relayStatus) {
      relayStatus.messagesReceived++;
      relayStatus.lastSeen = Date.now();
      relayStatus.connected = true;
    }

    try {
      // Decrypt the message using NIP-04
      let decryptedContent;
      if (this.signer.nip04) {
        decryptedContent = await this.signer.nip04.decrypt(event.pubkey, event.content);
      } else {
        logger.error('NIP-04 encryption not supported by signer');
        return;
      }

      // Handle empty messages
      if (!decryptedContent || decryptedContent.trim().length === 0) {
        logger.warn('Received empty message - skipping response');
        return;
      }

      logger.debug(`Decrypted message: ${decryptedContent}`);

      // Save user message to database
      await this.db.saveMessage(event.pubkey, decryptedContent, false);

      // Get conversation history from database
      const conversationHistory = await this.db.getConversation(event.pubkey);

      // Generate AI response using Gemini
      const response = await this.gemini.generateResponse(decryptedContent, conversationHistory);

      // Add delay to seem more natural
      await this.sleep(this.config.responseDelay);

      // Send encrypted response
      await this.sendMessage(event.pubkey, response);

      // Save bot response to database
      await this.db.saveMessage(event.pubkey, response, true);

      logger.info(`Sent response to ${event.pubkey.substring(0, 8)}...`);
    } catch (error) {
      logger.error('Failed to handle event:', error);
    }
  }

  /**
   * Send an encrypted message to a user
   */
  async sendMessage(recipientPubkey, content) {
    try {
      // Encrypt the content using NIP-04
      let encryptedContent;
      if (this.signer.nip04) {
        encryptedContent = await this.signer.nip04.encrypt(recipientPubkey, content);
      } else {
        throw new Error('NIP-04 encryption not supported by signer');
      }

      // Create the event
      const eventTemplate = {
        kind: 4,
        content: encryptedContent,
        tags: [['p', recipientPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      };

      // Sign the event
      const signedEvent = await this.signer.signEvent(eventTemplate);

      // Publish to all relays (ignore individual failures)
      const publishPromises = this.relays.map(({ relay, url }) => {
        return relay.event(signedEvent)
          .then(() => {
            logger.debug(`✓ Published to ${url}`);
            return { url, success: true };
          })
          .catch(error => {
            // Only log once per relay per message
            if (!error.message.includes('pow:') && !error.message.includes('restricted:') && !error.message.includes('Policy violated')) {
              logger.warn(`✗ ${url}: ${error.message}`);
            }
            return { url, success: false, error: error.message };
          });
      });

      const results = await Promise.allSettled(publishPromises);
      
      // Update relay stats
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const { url, success } = result.value;
          const relayStatus = this.relayStatus.get(url);
          if (relayStatus) {
            if (success) {
              relayStatus.messagesSent++;
              relayStatus.lastSeen = Date.now();
            } else {
              relayStatus.errors++;
              relayStatus.lastError = result.value.error || 'Unknown error';
            }
          }
        }
      });
      
      // Count successful publishes
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      logger.info(`Message sent to ${successCount}/${this.relays.length} relays`);
      
      // Update stats
      if (successCount > 0) {
        this.stats.messagesSent++;
      }
      
      if (successCount === 0) {
        logger.error('Failed to publish to any relay!');
      }
    } catch (error) {
      logger.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Stop the bot
   */
  async stop() {
    logger.info('Stopping bot...');

    // Abort all subscriptions
    for (const controller of this.controllers) {
      controller.abort();
    }

    this.controllers = [];
    this.relays = [];

    logger.info('Bot stopped');
  }

  /**
   * Get bot statistics
   */
  getStats() {
    const uptime = Date.now() - (this.stats?.startTime || Date.now());
    
    return {
      uptime,
      uptimeFormatted: this.formatUptime(uptime),
      messagesReceived: this.stats?.messagesReceived || 0,
      messagesSent: this.stats?.messagesSent || 0,
      errors: this.stats?.errors || 0,
      relays: Array.from(this.relayStatus?.values() || []),
    };
  }

  /**
   * Format uptime
   */
  formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
}
