import { open } from 'lmdb';
import { logger } from './logger.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Database manager using LMDB
 */
export class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize the database
   */
  async init() {
    try {
      // Create directory if it doesn't exist
      mkdirSync(dirname(this.dbPath), { recursive: true });

      this.db = open({
        path: this.dbPath,
        compression: true,
      });

      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * Save a conversation message
   * @param {string} pubkey - User's public key
   * @param {string} message - Message content
   * @param {boolean} isFromBot - Whether message is from bot
   * @param {object} metadata - Additional metadata (eventId, messageType, replyTo, sessionId)
   */
  async saveMessage(pubkey, message, isFromBot = false, metadata = {}) {
    try {
      const timestamp = Date.now();
      const messageId = metadata.eventId || `${pubkey}:${timestamp}`;
      
      // Create a hash to check for duplicates
      const messageHash = `${pubkey}:${message}:${isFromBot}`;
      const hashKey = `hash:${messageHash}`;
      
      // Check if this exact message already exists
      const exists = await this.db.get(hashKey);
      if (exists) {
        logger.debug('Duplicate message detected, skipping save');
        return false;
      }
      
      // Save the message with metadata
      const key = `${pubkey}:${timestamp}:${isFromBot ? 'bot' : 'user'}`;
      await this.db.put(key, {
        pubkey,
        message,
        isFromBot,
        timestamp,
        messageId,
        messageType: metadata.messageType || (isFromBot ? 'response' : 'question'),
        replyTo: metadata.replyTo || null, // ID of the message this is replying to
        eventId: metadata.eventId || null, // Nostr event ID
        eventKind: metadata.eventKind || null, // Nostr event kind (1=public, 4=DM)
        sessionId: metadata.sessionId || null, // Session ID for tracking conversations
      });
      
      // Save the hash to prevent duplicates
      await this.db.put(hashKey, { timestamp });
      
      return messageId;
    } catch (error) {
      logger.error('Failed to save message:', error);
      return false;
    }
  }

  /**
   * Get conversation history for a user
   */
  async getConversation(pubkey, limit = 50) {
    try {
      const messages = [];
      const prefix = `${pubkey}:`;

      for (const { key, value } of this.db.getRange({
        start: prefix,
        end: `${prefix}\xFF`,
        limit,
        reverse: true,
      })) {
        messages.push(value);
      }

      return messages.reverse();
    } catch (error) {
      logger.error('Failed to get conversation:', error);
      return [];
    }
  }

  /**
   * Get conversation history for a user filtered by session ID
   */
  async getConversationBySession(pubkey, sessionId, limit = 50) {
    try {
      const messages = [];
      const prefix = `${pubkey}:`;

      for (const { key, value } of this.db.getRange({
        start: prefix,
        end: `${prefix}\xFF`,
        reverse: true,
      })) {
        // Filter by session ID
        if (value.sessionId === sessionId) {
          messages.push(value);
          
          // Stop when we reach the limit
          if (messages.length >= limit) {
            break;
          }
        }
      }

      return messages.reverse();
    } catch (error) {
      logger.error('Failed to get conversation by session:', error);
      return [];
    }
  }

  /**
   * Get all conversations
   */
  async getAllConversations() {
    try {
      const conversations = {};

      for (const { value } of this.db.getRange()) {
        if (!conversations[value.pubkey]) {
          conversations[value.pubkey] = [];
        }
        conversations[value.pubkey].push(value);
      }

      return conversations;
    } catch (error) {
      logger.error('Failed to get all conversations:', error);
      return {};
    }
  }

  /**
   * Close the database
   */
  async close() {
    if (this.db) {
      await this.db.close();
      logger.info('Database closed');
    }
  }
}

/**
 * Extended database for conversation management
 */
export class ConversationDatabase extends Database {
  /**
   * Get recent messages across all conversations
   */
  async getRecentMessages(limit = 50) {
    try {
      const messages = [];
      
      for (const { key, value } of this.db.getRange({ reverse: true })) {
        // Skip hash entries used for duplicate detection
        if (key.startsWith('hash:')) {
          continue;
        }
        
        // Skip if value doesn't have message field
        if (!value.message) {
          continue;
        }
        
        messages.push({
          role: value.isFromBot ? 'bot' : 'user',
          content: value.message,
          timestamp: value.timestamp,
          pubkey: value.pubkey,
          sender: value.pubkey, // Add sender field for dashboard
          messageId: value.messageId || null,
          messageType: value.messageType || (value.isFromBot ? 'response' : 'question'),
          replyTo: value.replyTo || null,
          eventId: value.eventId || null,
          eventKind: value.eventKind || null,
          sessionId: value.sessionId || null, // Add session ID
        });
        
        // Stop when we reach the limit
        if (messages.length >= limit) {
          break;
        }
      }

      return messages;
    } catch (error) {
      logger.error('Failed to get recent messages:', error);
      return [];
    }
  }

  /**
   * Get conversation summary for all users
   */
  async getConversationSummary() {
    try {
      const summary = new Map();

      for (const { key, value } of this.db.getRange()) {
        // Skip hash entries
        if (key.startsWith('hash:')) {
          continue;
        }
        
        // Skip if value doesn't have required fields
        if (!value.pubkey || !value.message) {
          continue;
        }
        
        if (!summary.has(value.pubkey)) {
          summary.set(value.pubkey, {
            pubkey: value.pubkey,
            messageCount: 0,
            lastMessage: null,
            lastTimestamp: 0,
          });
        }

        const conv = summary.get(value.pubkey);
        conv.messageCount++;
        
        if (value.timestamp > conv.lastTimestamp) {
          conv.lastTimestamp = value.timestamp;
          conv.lastMessage = value.message;
        }
      }

      return Array.from(summary.values()).map(conv => ({
        ...conv,
        lastTimestampFormatted: new Date(conv.lastTimestamp).toLocaleString('en-US'),
      }));
    } catch (error) {
      logger.error('Failed to get conversation summary:', error);
      return [];
    }
  }
}
