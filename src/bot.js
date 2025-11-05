import { NRelay1, NSecSigner } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { logger } from './logger.js';
import { Database } from './database.js';
import { ZapDatabase } from './zapdb.js';
import { GeminiAI } from './gemini.js';
import { MessageQueue } from './queue.js';
import { RateLimiter } from './ratelimiter.js';

/**
 * Scalable Nostr AI Bot with queue system, rate limiting, and Zap support
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
    this.zapDb = new ZapDatabase('./data/zaps');
    
    // Initialize Gemini AI
    this.gemini = new GeminiAI(config.geminiApiKey, config.botName);
    
    // Initialize message queue
    this.queue = new MessageQueue({
      maxConcurrent: config.maxConcurrent || 10, // Process 10 messages simultaneously
      maxQueueSize: config.maxQueueSize || 10000,
      retryAttempts: 3,
      retryDelay: 1000,
      timeout: config.queueTimeout || 60000, // 60 seconds per message
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
    
    // Track failed relay connections
    this.failedRelays = new Set();
    this.maxReconnectAttempts = 5; // Maximum reconnection attempts per relay
    this.reconnectAttempts = new Map(); // Track attempts per relay
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

    // Initialize databases
    await this.db.init();
    await this.zapDb.init();

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

    // Subscribe to multiple event types:
    // 1. Kind 4: Encrypted DMs
    // 2. Kind 1: Public mentions and replies  
    // 3. Kind 9735: Zap receipts
    // 4. Kind 1006: Balance requests
    const filters = [
      {
        kinds: [4], // Encrypted DMs
        '#p': [this.pubkey],
        since: Math.floor(Date.now() / 1000),
      },
      {
        kinds: [1], // Public posts mentioning or replying to bot
        '#p': [this.pubkey],
        since: Math.floor(Date.now() / 1000),
      },
      {
        kinds: [9735], // Zap receipts
        '#p': [this.pubkey],
        since: Math.floor(Date.now() / 1000),
      },
      {
        kinds: [1006], // Balance requests
        '#p': [this.pubkey],
        since: Math.floor(Date.now() / 1000),
      },
    ];

    logger.info('Bot is now listening for:');
    logger.info('  • Encrypted DMs (kind 4)');
    logger.info('  • Public mentions & replies (kind 1)');
    logger.info('  • Zap receipts (kind 9735)');
    logger.info('  • Balance requests (kind 1006)');
    logger.info('Send a DM or mention @ZapAI to start chatting!');

    // Listen to each relay
    for (const { url, relay } of this.relays) {
      const controller = new AbortController();
      this.controllers.push(controller);

      this.listenToRelay(relay, url, filters, controller.signal).catch(error => {
        logger.error(`Error listening to ${url}:`, error);
      });
    }
  }

  /**
   * Listen to a relay for incoming messages
   */
  async listenToRelay(relay, relayUrl, filters, signal) {
    // Initialize reconnect attempts counter
    if (!this.reconnectAttempts.has(relayUrl)) {
      this.reconnectAttempts.set(relayUrl, 0);
    }
    
    while (!signal.aborted) {
      // Check if relay has failed too many times
      if (this.failedRelays.has(relayUrl)) {
        logger.warn(`Relay ${relayUrl} is marked as failed, skipping...`);
        break;
      }
      
      try {
        logger.debug(`Starting subscription to ${relayUrl}`);
        
        for await (const msg of relay.req(filters, { signal })) {
          if (msg[0] === 'EVENT') {
            const event = msg[2];
            // Reset reconnect attempts on successful message
            this.reconnectAttempts.set(relayUrl, 0);
            
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
          const attempts = this.reconnectAttempts.get(relayUrl) || 0;
          
          if (attempts >= this.maxReconnectAttempts) {
            logger.error(`Relay ${relayUrl} failed ${attempts} times, marking as permanently failed`);
            this.failedRelays.add(relayUrl);
            this.relayStatus.get(relayUrl).connected = false;
            break;
          }
          
          this.reconnectAttempts.set(relayUrl, attempts + 1);
          const delay = Math.min(5000 * Math.pow(2, attempts), 60000); // Exponential backoff, max 60s
          logger.info(`Reconnecting to ${relayUrl} in ${delay/1000} seconds... (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
          await this.sleep(delay);
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          logger.debug(`Subscription to ${relayUrl} aborted`);
          break;
        }
        logger.error(`Relay ${relayUrl} error:`, error.message);
        
        const attempts = this.reconnectAttempts.get(relayUrl) || 0;
        
        if (attempts >= this.maxReconnectAttempts) {
          logger.error(`Relay ${relayUrl} failed ${attempts} times, marking as permanently failed`);
          this.failedRelays.add(relayUrl);
          this.relayStatus.get(relayUrl).connected = false;
          break;
        }
        
        // Wait before reconnecting
        if (!signal.aborted) {
          this.reconnectAttempts.set(relayUrl, attempts + 1);
          const delay = Math.min(5000 * Math.pow(2, attempts), 60000); // Exponential backoff
          logger.info(`Reconnecting to ${relayUrl} in ${delay/1000} seconds... (attempt ${attempts + 1}/${this.maxReconnectAttempts})`);
          await this.sleep(delay);
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

    // Handle different event kinds
    if (event.kind === 9735) {
      // Zap receipt
      await this.handleZapReceipt(event, relayUrl);
      return;
    } else if (event.kind === 1006) {
      // Balance request
      await this.handleBalanceRequest(event, relayUrl);
      return;
    }

    const eventType = event.kind === 4 ? 'DM' : 'mention/reply';
    logger.info(`Received ${eventType} from ${event.pubkey.substring(0, 8)}... on ${relayUrl}`);
    
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
      
      // Send rate limit message (only for DMs)
      if (event.kind === 4) {
        try {
          await this.sendDM(
            event.pubkey, 
            rateLimitResult.reason + ` (Retry in ${rateLimitResult.retryAfter} seconds)`
          );
        } catch (error) {
          logger.error('Failed to send rate limit message:', error);
        }
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
        
        // Send queue full message (only for DMs)
        if (event.kind === 4) {
          try {
            await this.sendDM(
              event.pubkey, 
              "I'm currently very busy processing many requests. Please try again in a few minutes."
            );
          } catch (sendError) {
            logger.error('Failed to send queue full message:', sendError);
          }
        }
      }
    }
  }

  /**
   * Process a message (called by queue)
   */
  async processMessage(event, relayUrl) {
    try {
      let messageContent;
      let sessionId = null;
      
      // Extract session ID from tags (for kind 4 DMs)
      if (event.kind === 4) {
        const sessionTag = event.tags.find(tag => tag[0] === 'session');
        if (sessionTag && sessionTag[1]) {
          sessionId = sessionTag[1];
          logger.info(`[Session: ${sessionId}] Processing DM from ${event.pubkey.substring(0, 8)}...`);
        } else {
          logger.warn(`DM from ${event.pubkey.substring(0, 8)}... received without session tag - creating new conversation`);
        }
      }
      
      // Handle different event kinds
      if (event.kind === 4) {
        // Encrypted DM - decrypt the message
        if (this.signer.nip04) {
          messageContent = await this.signer.nip04.decrypt(event.pubkey, event.content);
        } else {
          logger.error('NIP-04 encryption not supported by signer');
          return;
        }
      } else if (event.kind === 1) {
        // Public post - content is already plain text
        messageContent = event.content;
      } else {
        logger.warn(`Unsupported event kind: ${event.kind}`);
        return;
      }

      // Handle empty messages
      if (!messageContent || messageContent.trim().length === 0) {
        logger.warn('Received empty message - skipping response');
        return;
      }

      // Create message fingerprint based on actual content
      const messageFingerprint = `${event.pubkey}:${messageContent}`;
      
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

      logger.debug(`Processing: ${messageContent.substring(0, 50)}...`);

      // Save user message to database with metadata including session
      const userMessageRecord = await this.db.saveMessage(
        event.pubkey, 
        messageContent, 
        false,
        {
          eventId: event.id,
          eventKind: event.kind,
          messageType: 'question',
          sessionId: sessionId
        }
      );
      if (!userMessageRecord) {
        logger.error('Failed to persist user message, aborting processing');
        return;
      }

      if (userMessageRecord.sessionId) {
        sessionId = userMessageRecord.sessionId;
      }

      if (userMessageRecord.duplicate) {
        logger.info(`Duplicate message ignored for ${event.pubkey.substring(0, 8)}... (eventId=${event.id})`);
        return;
      }

      // =============================================
      // CHECK BALANCE AND DEDUCT BEFORE GENERATING RESPONSE
      // =============================================
      const cost = event.kind === 4 ? 20 : 50;
      const currentBalance = await this.zapDb.getBalance(event.pubkey);
      
      logger.info(`User ${event.pubkey.substring(0, 8)}... balance: ${currentBalance} sats, required: ${cost} sats`);
      
      if (currentBalance < cost) {
        logger.warn(`Insufficient balance for ${event.pubkey.substring(0, 8)}...: has ${currentBalance} sats, needs ${cost} sats`);
        
        const insufficientBalanceMsg = `❌ Insufficient balance!\n\n` +
          `💰 Your balance: ${currentBalance} sats\n` +
          `💸 Required: ${cost} sats (${event.kind === 4 ? 'DM' : 'Public mention/reply'})\n\n` +
          `Please send a Zap to top up your balance and continue using ZapAI. Thank you! ⚡`;
        
        if (event.kind === 4) {
          await this.sendDM(event.pubkey, insufficientBalanceMsg, sessionId);
        } else if (event.kind === 1) {
          await this.sendReply(event, insufficientBalanceMsg);
        }

        await this.db.saveMessage(
          event.pubkey,
          insufficientBalanceMsg,
          true,
          {
            eventKind: event.kind,
            messageType: 'system',
            sessionId: sessionId,
          }
        );
        
        return; // Stop processing
      }
      
      // Deduct the cost from user's balance
      const newBalance = await this.zapDb.deductFromBalance(event.pubkey, cost);
      
      if (newBalance === false) {
        logger.error(`Failed to deduct balance for ${event.pubkey.substring(0, 8)}...`);
        
        const errorMsg = "⚠️ An error occurred while processing your payment. Please try again.";
        if (event.kind === 4) {
          await this.sendDM(event.pubkey, errorMsg, sessionId);
        } else if (event.kind === 1) {
          await this.sendReply(event, errorMsg);
        }

        await this.db.saveMessage(
          event.pubkey,
          errorMsg,
          true,
          {
            eventKind: event.kind,
            messageType: 'system',
            sessionId: sessionId,
          }
        );
        
        return;
      }
      
      logger.info(`✓ Deducted ${cost} sats from ${event.pubkey.substring(0, 8)}..., new balance: ${newBalance} sats`);
      // =============================================

      // Get conversation history from database (filtered by session if available)
      const conversationHistory = sessionId 
        ? await this.db.getConversationBySession(event.pubkey, sessionId)
        : await this.db.getConversation(event.pubkey);

      logger.info(`[Session: ${sessionId || 'none'}] Retrieved ${conversationHistory.length} messages from history for ${event.pubkey.substring(0, 8)}...`);

      // Generate AI response using Gemini (with circuit breaker protection)
      const response = await this.gemini.generateResponse(messageContent, conversationHistory);

      // Add balance footer to response
      const balanceFooter = `\n\n💰 Balance: ${newBalance} sats | 💸 Cost: ${cost} sats`;
      const fullResponse = response + balanceFooter;

      // Add delay to seem more natural
      await this.sleep(this.config.responseDelay);

      // Send response based on event kind
      let responseEventId = null;
      if (event.kind === 4) {
        // Reply with encrypted DM - include session tag
        const dmEvent = await this.sendDM(event.pubkey, fullResponse, sessionId);
        responseEventId = dmEvent?.id;
      } else if (event.kind === 1) {
        // Reply with public post
        const replyEvent = await this.sendReply(event, fullResponse);
        responseEventId = replyEvent?.id;
      }

      // Publish balance update event (kind 1006) for real-time balance tracking
      await this.publishBalanceResponse(event.pubkey, newBalance);

      // Save bot response to database with metadata linking to user message
      await this.db.saveMessage(
        event.pubkey, 
        fullResponse, 
        true,
        {
          eventId: responseEventId,
          eventKind: event.kind,
          messageType: 'response',
          replyTo: userMessageRecord.messageId, // Link to the user's question
          sessionId: sessionId // Include session for tracking
        }
      );

      const replyType = event.kind === 4 ? 'DM' : 'public reply';
      logger.info(`✓ ${replyType} sent to ${event.pubkey.substring(0, 8)}... (Balance: ${newBalance} sats)`);
    } catch (error) {
      logger.error('Failed to process message:', error);
      this.stats.errors++;
      
      // Send error message to user (only for DMs)
      if (event.kind === 4) {
        try {
          await this.sendDM(
            event.pubkey, 
            "I encountered an error processing your message. Please try again."
          );
        } catch (sendError) {
          logger.error('Failed to send error message:', sendError);
        }
      }
      
      throw error; // Re-throw for queue retry logic
    }
  }

  /**
   * Send an encrypted DM to a user
   */
  async sendDM(recipientPubkey, content, sessionId = null) {
    try {
      // Encrypt the content using NIP-04
      let encryptedContent;
      if (this.signer.nip04) {
        encryptedContent = await this.signer.nip04.encrypt(recipientPubkey, content);
      } else {
        throw new Error('NIP-04 encryption not supported by signer');
      }

      // Create tags array with required p tag
      const tags = [['p', recipientPubkey]];
      
      // Add session tag if sessionId is provided
      if (sessionId) {
        tags.push(['session', sessionId]);
        logger.debug(`Adding session tag: ${sessionId}`);
      }

      // Create the event
      const eventTemplate = {
        kind: 4,
        content: encryptedContent,
        tags: tags,
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
      logger.info(`DM sent to ${successCount}/${this.relays.length} relays`);
      
      // Update stats
      if (successCount > 0) {
        this.stats.messagesSent++;
      }
      
      if (successCount === 0) {
        logger.error('Failed to publish DM to any relay!');
      }
      
      return signedEvent; // Return the event for database storage
    } catch (error) {
      logger.error('Failed to send DM:', error);
      throw error;
    }
  }

  /**
   * Send a public reply to a post
   */
  async sendReply(originalEvent, content) {
    try {
      // Create reply event (kind 1)
      const eventTemplate = {
        kind: 1,
        content: content,
        tags: [
          ['e', originalEvent.id, '', 'reply'], // Reply to event
          ['p', originalEvent.pubkey], // Mention original author
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      // Sign the event
      const signedEvent = await this.signer.signEvent(eventTemplate);

      // Publish to all relays
      const publishPromises = this.relays.map(({ relay, url }) => {
        return relay.event(signedEvent)
          .then(() => {
            logger.debug(`✓ Published reply to ${url}`);
            return { url, success: true };
          })
          .catch(error => {
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
      logger.info(`Public reply sent to ${successCount}/${this.relays.length} relays`);
      
      // Update stats
      if (successCount > 0) {
        this.stats.messagesSent++;
      }
      
      if (successCount === 0) {
        logger.error('Failed to publish reply to any relay!');
      }
      
      return signedEvent; // Return the event for database storage
    } catch (error) {
      logger.error('Failed to send reply:', error);
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

  /**
   * Handle Zap receipt (kind 9735)
   */
  async handleZapReceipt(event, relayUrl) {
    try {
      logger.info(`Zap receipt received from ${event.pubkey.substring(0, 8)}... on ${relayUrl}`);
      logger.info(`Zap event tags: ${JSON.stringify(event.tags)}`);
      logger.info(`Zap event content: ${event.content}`);
      
      // Extract zap details from event
      // Find bolt11 invoice in tags
      const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
      const bolt11 = bolt11Tag ? bolt11Tag[1] : null;
      logger.info(`bolt11: ${bolt11 ? bolt11.substring(0, 20) + '...' : 'NOT FOUND'}`);
      
      // Find description tag (contains zap request)
      const descTag = event.tags.find(tag => tag[0] === 'description');
      let zapRequest = null;
      let sender = event.pubkey;
      let amount = 0;
      
      if (descTag && descTag[1]) {
        try {
          zapRequest = JSON.parse(descTag[1]);
          sender = zapRequest.pubkey || event.pubkey;
          logger.info(`Zap request parsed. Sender: ${sender.substring(0, 8)}...`);
          
          // Extract amount from zap request tags (inside description)
          if (zapRequest.tags && Array.isArray(zapRequest.tags)) {
            const amountTag = zapRequest.tags.find(tag => Array.isArray(tag) && tag[0] === 'amount');
            logger.info(`Amount tag found in zapRequest: ${amountTag ? amountTag[1] : 'NOT FOUND'}`);
            if (amountTag && amountTag[1]) {
              amount = Math.floor(parseInt(amountTag[1]) / 1000); // Convert millisats to sats
              logger.info(`Amount extracted: ${amount} sats (from ${amountTag[1]} millisats)`);
            }
          }
          
          // Fallback: Try to find amount tag in receipt event itself
          if (amount === 0) {
            const receiptAmountTag = event.tags.find(tag => tag[0] === 'amount');
            if (receiptAmountTag && receiptAmountTag[1]) {
              amount = Math.floor(parseInt(receiptAmountTag[1]) / 1000);
              logger.info(`Amount extracted from receipt: ${amount} sats`);
            }
          }
        } catch (e) {
          logger.warn('Failed to parse zap request:', e);
        }
      } else {
        logger.warn('Description tag not found in zap receipt');
      }
      
      if (amount === 0) {
        logger.warn('Zap amount is zero or could not be extracted');
        return;
      }
      
      // Save zap to database
      const zapId = await this.zapDb.saveZap({
        sender: sender,
        amount: amount,
        zapRequest: zapRequest?.id,
        zapReceipt: event.id,
        bolt11: bolt11,
        description: JSON.stringify(zapRequest),
      });
      
      // Get updated balance
      const balance = await this.zapDb.getBalance(sender);
      
      logger.info(`Zap processed: ${amount} sats from ${sender.substring(0, 8)}..., new balance: ${balance} sats`);
      
      // Publish balance update event (kind 1 notification)
      await this.publishBalanceUpdate(sender, balance, amount);
      
    } catch (error) {
      logger.error('Failed to handle zap receipt:', error);
    }
  }

  /**
   * Handle balance request (kind 1006)
   */
  async handleBalanceRequest(event, relayUrl) {
    try {
      logger.info(`Balance request from ${event.pubkey.substring(0, 8)}... on ${relayUrl}`);
      
      // Get user's balance
      const balance = await this.zapDb.getBalance(event.pubkey);
      
      // Publish balance response as kind 1006 event
      await this.publishBalanceResponse(event.pubkey, balance);
      
      logger.info(`Balance response published for ${event.pubkey.substring(0, 8)}...: ${balance} sats`);
      
    } catch (error) {
      logger.error('Failed to handle balance request:', error);
    }
  }

  /**
   * Publish balance update notification (kind 1)
   */
  async publishBalanceUpdate(pubkey, balance, zapAmount) {
    try {
      // Publish kind 1 notification
      const eventTemplate = {
        kind: 1,
        content: `⚡ Zap received! +${zapAmount} sats\n💰 New balance: ${balance} sats\n\nThank you for supporting ZapAI! 🙏`,
        tags: [
          ['p', pubkey], // Tag the user
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signedEvent = await this.signer.signEvent(eventTemplate);

      // Publish to all relays
      const publishPromises = this.relays.map(({ relay, url }) => {
        return relay.event(signedEvent).catch(error => {
          logger.debug(`Failed to publish balance update to ${url}: ${error.message}`);
        });
      });

      await Promise.allSettled(publishPromises);
      logger.info(`Balance update (kind 1) published for ${pubkey.substring(0, 8)}...`);
      
      // Also publish kind 1006 balance response for subscribers
      await this.publishBalanceResponse(pubkey, balance);
      
    } catch (error) {
      logger.error('Failed to publish balance update:', error);
    }
  }

  /**
   * Publish balance response (kind 1006)
   * This allows clients to subscribe and get real-time balance updates
   */
  async publishBalanceResponse(pubkey, balance) {
    try {
      const eventTemplate = {
        kind: 1006,
        content: JSON.stringify({
          balance: balance,
          currency: 'sats',
          timestamp: Date.now()
        }),
        tags: [
          ['p', pubkey], // Tag the user
          ['balance', balance.toString()], // Balance tag for easy filtering
        ],
        created_at: Math.floor(Date.now() / 1000),
      };

      const signedEvent = await this.signer.signEvent(eventTemplate);

      // Publish to all relays
      const publishPromises = this.relays.map(({ relay, url }) => {
        return relay.event(signedEvent)
          .then(() => {
            logger.debug(`✓ Balance response (kind 1006) published to ${url}`);
            return { url, success: true };
          })
          .catch(error => {
            logger.debug(`Failed to publish balance response to ${url}: ${error.message}`);
            return { url, success: false };
          });
      });

      const results = await Promise.allSettled(publishPromises);
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      
      logger.info(`Balance response (kind 1006) published to ${successCount}/${this.relays.length} relays for ${pubkey.substring(0, 8)}...`);
      
    } catch (error) {
      logger.error('Failed to publish balance response:', error);
    }
  }
}
