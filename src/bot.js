import { NRelay1, NSecSigner } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { logger } from './logger.js';
import { Database } from './database.js';
import { GeminiAI } from './gemini.js';
import { MessageQueue } from './queue.js';
import { RateLimiter } from './ratelimiter.js';

/**
 * Scalable Nostr AI Bot with queue system and rate limiting
 */
export class NostrBot {
  constructor(config) {
    this.config = config;
    this.relays = [];
    this.signer = null;
    this.pubkey = null;
    this.processedEvents = new Set();
    this.processedMessages = new Map(); // Track by pubkey+content to prevent duplicate responses
    this.controllers = [];
    this.db = new Database('./data/conversations');
    
    // Initialize Gemini AI
    this.gemini = new GeminiAI(config.geminiApiKey, config.botName);
    
    // Initialize message queue
    this.queue = new MessageQueue({
      maxConcurrent: config.maxConcurrent || 10, // Process 10 messages simultaneously
      maxQueueSize: config.maxQueueSize || 10000,
      retryAttempts: 3,
      retryDelay: 1000,
      timeout: 45000, // 45 seconds per message
    });
    
    // Initialize rate limiter
    this.rateLimiter = new RateLimiter({
      maxTokens: config.rateLimit?.maxTokens || 50, // 50 requests per user
      refillRate: config.rateLimit?.refillRate || 5, // 5 tokens per second
      windowMs: 60000, // 1 minute window
    });
    
    // Statistics
    this.stats = {
      startTime: Date.now(),
      messagesReceived: 0,
      messagesSent: 0,
      messagesQueued: 0,
      messagesDropped: 0,
      rateLimited: 0,
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
   * Handle incoming event with queue system and rate limiting
   */
  async handleEvent(event, relayUrl) {
    // Skip if already processed (by event ID)
    if (this.processedEvents.has(event.id)) {
      logger.debug(`Duplicate event ${event.id} from ${relayUrl}, skipping`);
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

    // Check rate limit
    const rateLimitResult = await this.rateLimiter.checkLimit(event.pubkey);
    if (!rateLimitResult.allowed) {
      logger.warn(`Rate limit exceeded for ${event.pubkey.substring(0, 8)}...`);
      this.stats.rateLimited++;
      
      // Send rate limit message
      try {
        const decryptedContent = await this.signer.nip04.decrypt(event.pubkey, event.content);
        if (decryptedContent && decryptedContent.trim().length > 0) {
          await this.sendMessage(
            event.pubkey, 
            rateLimitResult.reason + ` (Retry in ${rateLimitResult.retryAfter} seconds)`
          );
        }
      } catch (error) {
        logger.error('Failed to send rate limit message:', error);
      }
      return;
    }

    // Add to queue for processing
    try {
      this.stats.messagesQueued++;
      await this.queue.enqueue(async () => {
        await this.processMessage(event, relayUrl);
      });
    } catch (error) {
      if (error.message === 'Queue is full') {
        this.stats.messagesDropped++;
        logger.error(`Queue full! Dropped message from ${event.pubkey.substring(0, 8)}...`);
        
        // Send queue full message
        try {
          await this.sendMessage(
            event.pubkey, 
            "I'm currently very busy processing many requests. Please try again in a few minutes."
          );
        } catch (sendError) {
          logger.error('Failed to send queue full message:', sendError);
        }
      }
    }
  }

  /**
   * Process a message (called by queue)
   */
  async processMessage(event, relayUrl) {
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

      // Create message fingerprint based on actual content
      const messageFingerprint = `${event.pubkey}:${decryptedContent}`;
      
      // Check if we already processed this exact message content
      if (this.processedMessages.has(messageFingerprint)) {
        logger.debug(`Already processed this message content from ${event.pubkey.substring(0, 8)}..., skipping`);
        return;
      }
      
      // Mark as processed
      this.processedMessages.set(messageFingerprint, Date.now());
      
      // Clean up old fingerprints (older than 5 minutes)
      const now = Date.now();
      for (const [key, timestamp] of this.processedMessages.entries()) {
        if (now - timestamp > 300000) { // 5 minutes
          this.processedMessages.delete(key);
        }
      }

      logger.debug(`Processing: ${decryptedContent.substring(0, 50)}...`);

      // Save user message to database
      await this.db.saveMessage(event.pubkey, decryptedContent, false);

      // Get conversation history from database
      const conversationHistory = await this.db.getConversation(event.pubkey);

      // Generate AI response using Gemini (with circuit breaker protection)
      const response = await this.gemini.generateResponse(decryptedContent, conversationHistory);

      // Add delay to seem more natural
      await this.sleep(this.config.responseDelay);

      // Send encrypted response
      await this.sendMessage(event.pubkey, response);

      // Save bot response to database
      await this.db.saveMessage(event.pubkey, response, true);

      logger.info(`✓ Response sent to ${event.pubkey.substring(0, 8)}...`);
    } catch (error) {
      logger.error('Failed to process message:', error);
      this.stats.errors++;
      
      // Send error message to user
      try {
        await this.sendMessage(
          event.pubkey, 
          "I encountered an error processing your message. Please try again."
        );
      } catch (sendError) {
        logger.error('Failed to send error message:', sendError);
      }
      
      throw error; // Re-throw for queue retry logic
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
   * Stop the bot gracefully
   */
  async stop() {
    logger.info('Stopping bot gracefully...');

    // Stop accepting new messages
    for (const controller of this.controllers) {
      controller.abort();
    }

    // Wait for queue to finish processing
    await this.queue.stop();
    
    // Stop rate limiter
    this.rateLimiter.stop();

    this.controllers = [];
    this.relays = [];

    logger.info('Bot stopped');
  }

  /**
   * Get comprehensive bot statistics
   */
  getStats() {
    const uptime = Date.now() - (this.stats?.startTime || Date.now());
    
    return {
      uptime,
      uptimeFormatted: this.formatUptime(uptime),
      messagesReceived: this.stats?.messagesReceived || 0,
      messagesSent: this.stats?.messagesSent || 0,
      messagesQueued: this.stats?.messagesQueued || 0,
      messagesDropped: this.stats?.messagesDropped || 0,
      rateLimited: this.stats?.rateLimited || 0,
      errors: this.stats?.errors || 0,
      queue: this.queue.getStats(),
      rateLimiter: this.rateLimiter.getStats(),
      gemini: this.gemini.getStats(),
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
