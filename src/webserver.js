import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';
import { ConversationDatabase } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Web UI Server for monitoring the bot
 */
export class WebServer {
  constructor(bot, port = 3000) {
    this.bot = bot;
    this.port = port;
    this.app = express();
    this.server = null;
    this.db = new ConversationDatabase('./data/conversations');
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup middleware
   */
  setupMiddleware() {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  /**
   * Setup routes
   */
  setupRoutes() {
    // API Routes
    this.app.get('/api/status', (req, res) => {
      const stats = this.bot.getStats();
      res.json({
        status: 'running',
        pubkey: this.bot.pubkey,
        stats: {
          ...stats,
          performance: {
            queueSize: stats.queue?.queueSize || 0,
            processing: stats.queue?.processing || 0,
            avgProcessTime: stats.queue?.avgProcessTime || 0,
            successRate: stats.queue?.successRate || 'N/A',
          },
          rateLimiting: {
            activeBuckets: stats.rateLimiter?.activeBuckets || 0,
            globalTokens: stats.rateLimiter?.globalTokens || 0,
            maxTokens: stats.rateLimiter?.maxTokens || 0,
          },
          geminiAI: {
            requests: stats.gemini?.requests || 0,
            successful: stats.gemini?.successful || 0,
            failed: stats.gemini?.failed || 0,
            fallbacks: stats.gemini?.fallbacks || 0,
            successRate: stats.gemini?.successRate || 'N/A',
            circuitBreakerState: stats.gemini?.circuitBreaker?.state || 'UNKNOWN',
          },
        },
      });
    });

    this.app.get('/api/relays', (req, res) => {
      const relays = Array.from(this.bot.relayStatus.values()).map(relay => ({
        ...relay,
        lastSeenFormatted: relay.lastSeen ? new Date(relay.lastSeen).toLocaleString('en-US') : 'Never',
      }));
      res.json(relays);
    });

    this.app.get('/api/messages', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        const messages = await this.db.getRecentMessages(limit);
        res.json(messages);
      } catch (error) {
        logger.error('Failed to get messages:', error);
        res.status(500).json({ error: 'Failed to get messages' });
      }
    });

    this.app.get('/api/conversations', async (req, res) => {
      try {
        const conversations = await this.db.getAllConversations();
        res.json(conversations);
      } catch (error) {
        logger.error('Failed to get conversations:', error);
        res.status(500).json({ error: 'Failed to get conversations' });
      }
    });

    this.app.get('/api/conversation/:pubkey', async (req, res) => {
      try {
        const { pubkey } = req.params;
        const messages = await this.db.getConversation(pubkey);
        res.json(messages);
      } catch (error) {
        logger.error('Failed to get conversation:', error);
        res.status(500).json({ error: 'Failed to get conversation' });
      }
    });

    // Health check with detailed status
    this.app.get('/health', (req, res) => {
      const stats = this.bot.getStats();
      const isHealthy = stats.queue?.queueSize < 9000 && // Queue not near full
                       stats.gemini?.circuitBreaker?.state !== 'OPEN'; // Circuit not open
      
      res.status(isHealthy ? 200 : 503).json({ 
        status: isHealthy ? 'ok' : 'degraded',
        queueSize: stats.queue?.queueSize || 0,
        circuitBreaker: stats.gemini?.circuitBreaker?.state || 'UNKNOWN',
      });
    });

    // Serve HTML
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });
  }

  /**
   * Start the server
   */
  async start() {
    // Initialize database
    await this.db.init();
    
    return new Promise((resolve, reject) => {
      logger.info(`Attempting to start web server on port ${this.port}...`);
      
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        logger.info(`Web UI server started on http://0.0.0.0:${this.port}`);
        resolve();
      });
      
      this.server.on('error', (error) => {
        logger.error(`Web server error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Stop the server
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Web UI server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
