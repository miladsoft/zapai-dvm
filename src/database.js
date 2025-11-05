import { open } from 'lmdb';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

const MESSAGE_PREFIX = 'message';
const SESSION_PREFIX = 'session';
const HASH_PREFIX = 'hash';
const TIMESTAMP_PAD = 15;

const DEFAULT_HISTORY_LIMIT = 50;

const DM_KIND = 4;
const PUBLIC_KIND = 1;

function padTimestamp(timestamp) {
  const value = Number.isFinite(timestamp) ? timestamp : parseInt(timestamp ?? 0, 10);
  const safe = Number.isFinite(value) && value > 0 ? value : Date.now();
  return safe.toString().padStart(TIMESTAMP_PAD, '0');
}

function sanitizeSessionId(sessionId) {
  if (sessionId === null || sessionId === undefined) {
    return '';
  }
  const asString = sessionId.toString();
  const trimmed = asString.trim();
  if (!trimmed) {
    return '';
  }
  const noWhitespace = trimmed.replace(/\s+/g, '-');
  const printable = noWhitespace.replace(/[^\x21-\x7E]/g, '');
  return printable.slice(0, 120);
}

function previewContent(content, limit = 180) {
  if (typeof content !== 'string') {
    return '';
  }
  return content.length > limit ? content.slice(0, limit) : content;
}

function buildSessionKey(pubkey, sessionId) {
  return `${SESSION_PREFIX}:${pubkey}:${sessionId}`;
}

function buildMessageKey(pubkey, sessionId, timestamp, direction) {
  return `${MESSAGE_PREFIX}:${pubkey}:${sessionId}:${padTimestamp(timestamp)}:${direction}`;
}

function buildHashKey(pubkey, sessionId, timestamp, direction, eventId) {
  if (eventId) {
    return `${HASH_PREFIX}:event:${eventId}`;
  }
  return `${HASH_PREFIX}:${pubkey}:${sessionId}:${padTimestamp(timestamp)}:${direction}`;
}

/**
 * Conversation database backed by LMDB.
 */
export class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    if (this.db) {
      return;
    }

    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = open({
      path: this.dbPath,
      compression: true,
      encoding: 'json',
    });

    logger.info(`Conversation database ready at ${this.dbPath}`);
  }

  _assertInitialized() {
    if (!this.db) {
      throw new Error('Conversation database not initialized');
    }
  }

  _normalizePubkey(pubkey) {
    if (!pubkey) {
      return '';
    }
    return pubkey.toString().trim();
  }

  async ensureSession(pubkey, requestedSessionId, metadata = {}) {
    this._assertInitialized();

    const normalizedPubkey = this._normalizePubkey(pubkey);
    if (!normalizedPubkey) {
      throw new Error('pubkey is required to create a session');
    }

    const sanitized = sanitizeSessionId(requestedSessionId);
    const now = Date.now();
    const sessionId = sanitized || metadata.fallbackId || `session-${now}-${randomUUID().slice(0, 8)}`;
    const sessionKey = buildSessionKey(normalizedPubkey, sessionId);

    let sessionRecord = await this.db.get(sessionKey);
    if (!sessionRecord) {
      sessionRecord = {
        pubkey: normalizedPubkey,
        sessionId,
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
        origin: metadata.source || null,
        label: metadata.label || null,
        lastMessagePreview: null,
        lastDirection: null,
        lastEventId: null,
      };
      await this.db.put(sessionKey, sessionRecord);
      logger.info(`Created session ${sessionId} for ${normalizedPubkey.substring(0, 8)}...`);

      return { sessionId, isNew: true, session: sessionRecord };
    }

    let dirty = false;
    if (metadata.source && !sessionRecord.origin) {
      sessionRecord.origin = metadata.source;
      dirty = true;
    }
    if (metadata.label && sessionRecord.label !== metadata.label) {
      sessionRecord.label = metadata.label;
      dirty = true;
    }
    if (metadata.touch !== false) {
      sessionRecord.lastTouchedAt = now;
      dirty = true;
    }

    if (dirty) {
      await this.db.put(sessionKey, sessionRecord);
    }

    return { sessionId, isNew: false, session: sessionRecord };
  }

  async saveMessage(pubkey, message, isFromBot = false, metadata = {}) {
    this._assertInitialized();

    const normalizedPubkey = this._normalizePubkey(pubkey);
    if (!normalizedPubkey) {
      throw new Error('pubkey is required to save a message');
    }

    const content = typeof message === 'string' ? message : '';
    const timestamp = Number.isFinite(metadata.timestamp) ? metadata.timestamp : Date.now();
    const direction = isFromBot ? 'bot' : 'user';

    const { sessionId } = await this.ensureSession(normalizedPubkey, metadata.sessionId, {
      source: metadata.messageSource ||
        (metadata.eventKind === DM_KIND ? 'dm' :
         metadata.eventKind === PUBLIC_KIND ? 'public' : metadata.eventKind ? `kind-${metadata.eventKind}` : null),
      label: metadata.sessionLabel,
      touch: false,
    });

    const messageId = metadata.eventId || `${normalizedPubkey}:${sessionId}:${timestamp}:${direction}`;
    const messageRecord = {
      pubkey: normalizedPubkey,
      sessionId,
      message: content,
      isFromBot,
      timestamp,
      messageId,
      messageType: metadata.messageType || (isFromBot ? 'response' : 'question'),
      replyTo: metadata.replyTo || null,
      eventId: metadata.eventId || null,
      eventKind: metadata.eventKind || null,
      metadata: metadata.extraMetadata || null,
    };

    const messageKey = buildMessageKey(normalizedPubkey, sessionId, timestamp, direction);
    const hashKey = buildHashKey(normalizedPubkey, sessionId, timestamp, direction, metadata.eventId);

    const duplicateMarker = await this.db.get(hashKey);
    if (duplicateMarker) {
      logger.info(
        `Duplicate event detected for ${normalizedPubkey.substring(0, 8)}... (session=${sessionId}, eventId=${metadata.eventId || 'n/a'})`
      );
      return {
        messageId,
        sessionId,
        timestamp,
        duplicate: true,
      };
    }

    await this.db.put(messageKey, messageRecord);
    await this.db.put(hashKey, { messageKey, timestamp });

    await this._updateSessionAfterMessage(normalizedPubkey, sessionId, messageRecord);

    logger.debug(`Saved message ${messageKey}`);
    return {
      messageId,
      sessionId,
      timestamp,
      key: messageKey,
      duplicate: false,
    };
  }

  async _updateSessionAfterMessage(pubkey, sessionId, messageRecord) {
    const sessionKey = buildSessionKey(pubkey, sessionId);
    let session = await this.db.get(sessionKey);

    if (!session) {
      session = {
        pubkey,
        sessionId,
        createdAt: messageRecord.timestamp,
        lastMessageAt: messageRecord.timestamp,
        messageCount: 1,
        origin: messageRecord.eventKind === DM_KIND ? 'dm' :
                messageRecord.eventKind === PUBLIC_KIND ? 'public' : messageRecord.eventKind ? `kind-${messageRecord.eventKind}` : null,
        label: null,
        lastMessagePreview: previewContent(messageRecord.message),
        lastDirection: messageRecord.isFromBot ? 'bot' : 'user',
        lastEventId: messageRecord.eventId || null,
      };
      await this.db.put(sessionKey, session);
      return;
    }

    session.messageCount = (session.messageCount || 0) + 1;
    session.lastMessageAt = messageRecord.timestamp;
    session.lastMessagePreview = previewContent(messageRecord.message);
    session.lastDirection = messageRecord.isFromBot ? 'bot' : 'user';
    session.lastEventId = messageRecord.eventId || session.lastEventId || null;

    await this.db.put(sessionKey, session);
  }

  _formatMessage(record) {
    if (!record) {
      return null;
    }

    return {
      pubkey: record.pubkey,
      message: record.message,
      isFromBot: !!record.isFromBot,
      timestamp: record.timestamp,
      messageId: record.messageId || null,
      messageType: record.messageType || (record.isFromBot ? 'response' : 'question'),
      replyTo: record.replyTo || null,
      eventId: record.eventId || null,
      eventKind: record.eventKind || null,
      sessionId: record.sessionId || null,
    };
  }

  async getConversation(pubkey, limit = DEFAULT_HISTORY_LIMIT) {
    this._assertInitialized();

    const normalizedPubkey = this._normalizePubkey(pubkey);
    if (!normalizedPubkey) {
      return [];
    }

    const prefix = `${MESSAGE_PREFIX}:${normalizedPubkey}:`;
    const messages = [];

    try {
      for (const { value } of this.db.getRange({
        start: prefix,
        end: `${prefix}\xFF`,
        reverse: true,
      })) {
        if (!value?.message) {
          continue;
        }
        const formatted = this._formatMessage(value);
        if (formatted) {
          messages.push(formatted);
        }
        if (messages.length >= limit) {
          break;
        }
      }
    } catch (error) {
      logger.error('Failed to get conversation:', error);
    }

    return messages.reverse();
  }

  async getConversationBySession(pubkey, sessionId, limit = DEFAULT_HISTORY_LIMIT) {
    this._assertInitialized();

    const normalizedPubkey = this._normalizePubkey(pubkey);
    if (!normalizedPubkey) {
      return [];
    }

    const sanitizedSessionId = sanitizeSessionId(sessionId);
    if (!sanitizedSessionId) {
      return [];
    }

    const prefix = `${MESSAGE_PREFIX}:${normalizedPubkey}:${sanitizedSessionId}:`;
    const messages = [];

    try {
      for (const { value } of this.db.getRange({
        start: prefix,
        end: `${prefix}\xFF`,
        reverse: true,
      })) {
        if (!value?.message) {
          continue;
        }
        const formatted = this._formatMessage(value);
        if (formatted) {
          messages.push(formatted);
        }
        if (messages.length >= limit) {
          break;
        }
      }
    } catch (error) {
      logger.error('Failed to get conversation by session:', error);
    }

    return messages.reverse();
  }

  async getSessionMetadata(pubkey, sessionId) {
    this._assertInitialized();

    const normalizedPubkey = this._normalizePubkey(pubkey);
    const sanitizedSessionId = sanitizeSessionId(sessionId);
    if (!normalizedPubkey || !sanitizedSessionId) {
      return null;
    }

    try {
      return await this.db.get(buildSessionKey(normalizedPubkey, sanitizedSessionId));
    } catch (error) {
      logger.error('Failed to get session metadata:', error);
      return null;
    }
  }

  async getAllConversations() {
    this._assertInitialized();

    const conversations = {};

    try {
      for (const { value } of this.db.getRange({
        start: `${MESSAGE_PREFIX}:`,
        end: `${MESSAGE_PREFIX}:\xFF`,
      })) {
        if (!value?.pubkey || !value?.message) {
          continue;
        }
        const formatted = this._formatMessage(value);
        if (!formatted) {
          continue;
        }
        if (!conversations[formatted.pubkey]) {
          conversations[formatted.pubkey] = [];
        }
        conversations[formatted.pubkey].push(formatted);
      }

      for (const pubkey of Object.keys(conversations)) {
        conversations[pubkey].sort((a, b) => a.timestamp - b.timestamp);
      }
    } catch (error) {
      logger.error('Failed to get all conversations:', error);
    }

    return conversations;
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info('Conversation database closed');
    }
  }
}

/**
 * Extended conversation database with dashboard helpers.
 */
export class ConversationDatabase extends Database {
  async getRecentMessages(limit = DEFAULT_HISTORY_LIMIT) {
    this._assertInitialized();

    const messages = [];

    try {
      for (const { value } of this.db.getRange({
        start: `${MESSAGE_PREFIX}:`,
        end: `${MESSAGE_PREFIX}:\xFF`,
        reverse: true,
      })) {
        if (!value?.message) {
          continue;
        }
        messages.push({
          role: value.isFromBot ? 'bot' : 'user',
          content: value.message,
          timestamp: value.timestamp,
          pubkey: value.pubkey,
          sender: value.pubkey,
          messageId: value.messageId || null,
          messageType: value.messageType || (value.isFromBot ? 'response' : 'question'),
          replyTo: value.replyTo || null,
          eventId: value.eventId || null,
          eventKind: value.eventKind || null,
          sessionId: value.sessionId || null,
        });

        if (messages.length >= limit) {
          break;
        }
      }
    } catch (error) {
      logger.error('Failed to get recent messages:', error);
      return [];
    }

    return messages;
  }

  async getConversationSummary() {
    this._assertInitialized();

    const summary = new Map();

    try {
      for (const { value } of this.db.getRange({
        start: `${SESSION_PREFIX}:`,
        end: `${SESSION_PREFIX}:\xFF`,
      })) {
        if (!value?.pubkey) {
          continue;
        }

        const existing = summary.get(value.pubkey) || {
          pubkey: value.pubkey,
          messageCount: 0,
          lastMessage: null,
          lastTimestamp: 0,
        };

        existing.messageCount += value.messageCount || 0;
        if (value.lastMessageAt && value.lastMessageAt > existing.lastTimestamp) {
          existing.lastTimestamp = value.lastMessageAt;
          existing.lastMessage = value.lastMessagePreview || null;
        }

        summary.set(value.pubkey, existing);
      }

      return Array.from(summary.values()).map(entry => ({
        ...entry,
        lastTimestampFormatted: entry.lastTimestamp
          ? new Date(entry.lastTimestamp).toLocaleString('en-US')
          : null,
      }));
    } catch (error) {
      logger.error('Failed to get conversation summary:', error);
      return [];
    }
  }
}
