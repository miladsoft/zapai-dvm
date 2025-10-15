#!/usr/bin/env node
import 'dotenv/config';
import readline from 'readline';
import { GeminiAI } from './src/gemini.js';

/**
 * Interactive Chat Test with Gemini AI
 * A simple command-line chat interface to test the Gemini AI service
 */

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

// ASCII Art Banner
console.clear();
console.log(colors.cyan + colors.bright);
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║                                                            ║');
console.log('║           🤖 ZapAI - Interactive Chat Test                 ║');
console.log('║                                                            ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log(colors.reset);

// Check API key
if (!process.env.GEMINI_API_KEY) {
  console.log(colors.yellow + '⚠️  WARNING: GEMINI_API_KEY not found in .env file!' + colors.reset);
  console.log(colors.yellow + 'Please create a .env file and add your API key.' + colors.reset);
  process.exit(1);
}

// Initialize Gemini AI
console.log(colors.blue + '🔄 Initializing Gemini AI...' + colors.reset);
const gemini = new GeminiAI(process.env.GEMINI_API_KEY, 'ZapAI');

// Conversation history
const conversationHistory = [];

// Setup readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: colors.green + '💬 You: ' + colors.reset,
});

// Welcome message
console.log(colors.cyan + '\n✅ Ready to chat!' + colors.reset);
console.log(colors.blue + '📝 Type your message and press Enter' + colors.reset);
console.log(colors.blue + '🚪 Type "exit", "quit", or "bye" to end the chat' + colors.reset);
console.log(colors.blue + '🔄 Type "clear" to clear conversation history' + colors.reset);
console.log(colors.blue + '📊 Type "history" to see conversation history' + colors.reset);
console.log(colors.blue + '💡 Type "help" for commands\n' + colors.reset);

// Show prompt
rl.prompt();

// Handle user input
rl.on('line', async (input) => {
  const message = input.trim();

  // Handle empty messages
  if (!message) {
    rl.prompt();
    return;
  }

  // Handle commands
  if (message.toLowerCase() === 'exit' || message.toLowerCase() === 'quit' || message.toLowerCase() === 'bye') {
    console.log(colors.cyan + '\n👋 Thanks for chatting! Goodbye!\n' + colors.reset);
    rl.close();
    process.exit(0);
  }

  if (message.toLowerCase() === 'clear') {
    conversationHistory.length = 0;
    console.log(colors.yellow + '🗑️  Conversation history cleared!\n' + colors.reset);
    rl.prompt();
    return;
  }

  if (message.toLowerCase() === 'history') {
    console.log(colors.magenta + '\n📜 Conversation History:' + colors.reset);
    if (conversationHistory.length === 0) {
      console.log(colors.yellow + '   (empty)' + colors.reset);
    } else {
      conversationHistory.forEach((msg, index) => {
        const role = msg.isFromBot ? '🤖 AI' : '👤 You';
        console.log(colors.blue + `   ${index + 1}. ${role}: ${colors.reset}${msg.message}`);
      });
    }
    console.log('');
    rl.prompt();
    return;
  }

  if (message.toLowerCase() === 'help') {
    console.log(colors.magenta + '\n📖 Available Commands:' + colors.reset);
    console.log(colors.blue + '   • exit, quit, bye  - End the chat' + colors.reset);
    console.log(colors.blue + '   • clear            - Clear conversation history' + colors.reset);
    console.log(colors.blue + '   • history          - Show conversation history' + colors.reset);
    console.log(colors.blue + '   • help             - Show this help message' + colors.reset);
    console.log(colors.blue + '   • stats            - Show session statistics' + colors.reset);
    console.log('');
    rl.prompt();
    return;
  }

  if (message.toLowerCase() === 'stats') {
    console.log(colors.magenta + '\n📊 Session Statistics:' + colors.reset);
    console.log(colors.blue + `   • Messages sent: ${Math.ceil(conversationHistory.length / 2)}` + colors.reset);
    console.log(colors.blue + `   • Total exchanges: ${conversationHistory.length}` + colors.reset);
    console.log(colors.blue + `   • History size: ${conversationHistory.length}/10 (last 10 kept)` + colors.reset);
    console.log('');
    rl.prompt();
    return;
  }

  // Add user message to history
  conversationHistory.push({
    message: message,
    isFromBot: false,
  });

  // Show thinking indicator
  console.log(colors.yellow + '🤔 AI is thinking...' + colors.reset);

  try {
    // Get AI response
    const startTime = Date.now();
    const response = await gemini.generateResponse(message, conversationHistory);
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    // Add AI response to history
    conversationHistory.push({
      message: response,
      isFromBot: true,
    });

    // Display AI response
    console.log(colors.cyan + '🤖 AI: ' + colors.reset + response);
    console.log(colors.blue + `⏱️  (${responseTime}ms)\n` + colors.reset);
  } catch (error) {
    console.log(colors.yellow + '❌ Error: ' + error.message + colors.reset);
    console.log(colors.yellow + '🔄 Please try again.\n' + colors.reset);
  }

  // Show prompt again
  rl.prompt();
});

// Handle Ctrl+C
rl.on('SIGINT', () => {
  console.log(colors.cyan + '\n\n👋 Chat interrupted. Goodbye!\n' + colors.reset);
  rl.close();
  process.exit(0);
});

// Handle close
rl.on('close', () => {
  console.log(colors.cyan + '👋 Chat session ended.\n' + colors.reset);
  process.exit(0);
});
