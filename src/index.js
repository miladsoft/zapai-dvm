#!/usr/bin/env node
import 'websocket-polyfill';
import dotenv from 'dotenv';
import { NostrBot } from './bot.js';
import { WebServer } from './webserver.js';
import { logger } from './logger.js';

dotenv.config();

// Validate environment variables
const requiredEnvVars = ['BOT_PRIVATE_KEY', 'GEMINI_API_KEY'];
const missing = requiredEnvVars.filter(v => !process.env[v]);

if (missing.length > 0) {
  logger.error(`Missing required environment variables: ${missing.join(', ')}`);
  logger.info('Please check .env file and set all required variables');
  process.exit(1);
}

// Initialize bot with scalability configurations
const bot = new NostrBot({
  privateKey: process.env.BOT_PRIVATE_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  botName: process.env.BOT_NAME || 'ZapAI',
  relays: process.env.NOSTR_RELAYS.split(','),
  responseDelay: parseInt(process.env.BOT_RESPONSE_DELAY) || 2000,
  
  // Queue configuration
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 10,
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE) || 10000,
  
  // Rate limiting configuration
  rateLimit: {
    maxTokens: parseInt(process.env.RATE_LIMIT_MAX_TOKENS) || 50,
    refillRate: parseInt(process.env.RATE_LIMIT_REFILL_RATE) || 5,
  },
});

// Initialize web server
const webPort = parseInt(process.env.WEB_PORT) || 3000;
const webServer = new WebServer(bot, webPort);

// Handle graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  
  await webServer.stop();
  await bot.stop();
  
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start everything
(async () => {
  try {
    // Start the bot
    await bot.start();
    
    // Start the web server
    await webServer.start();
    
    logger.info('All systems running!');
  } catch (err) {
    logger.error('Failed to start:', err);
    process.exit(1);
  }
})();
