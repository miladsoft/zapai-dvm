import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { logger } from './logger.js';

/**
 * Gemini AI integration using AI SDK
 */
export class GeminiAI {
  constructor(apiKey, botName = 'ZapAI') {
    this.model = google('gemini-2.5-flash', {
      apiKey,
    });
    this.botName = botName;
    this.modelConfig = {
      temperature: 0.9,
      topK: 40,
      topP: 0.95,
      maxTokens: 1024,
    };
  }

  /**
   * Generate a response to a message
   */
  async generateResponse(message, conversationHistory = []) {
    try {
      // Build system instructions
      let systemInstructions = `You are ${this.botName}, a helpful AI assistant on Nostr (a decentralized social network). `;
      systemInstructions += 'You communicate via encrypted direct messages. ';
      systemInstructions += 'Be friendly, concise, and helpful. ';
      systemInstructions += 'You can speak English fluently. ';
      systemInstructions += 'IMPORTANT: Always respond in plain text only. Do not use markdown formatting, code blocks, bold, italics, lists, or any special formatting. Just use simple, natural text.';

      // Build messages array with conversation history
      const messages = [];
      
      if (conversationHistory.length > 0) {
        // Add up to last 10 messages from history
        conversationHistory.slice(-10).forEach((msg) => {
          messages.push({
            role: msg.isFromBot ? 'assistant' : 'user',
            content: msg.message,
          });
        });
      }

      // Add current message
      messages.push({
        role: 'user',
        content: message,
      });

      const result = await generateText({
        model: this.model,
        system: systemInstructions,
        messages: messages,
        temperature: this.modelConfig.temperature,
        topK: this.modelConfig.topK,
        topP: this.modelConfig.topP,
        maxTokens: this.modelConfig.maxTokens,
      });

      logger.debug('Gemini response:', result.text);
      return result.text;
    } catch (error) {
      logger.error('Failed to generate Gemini response:', error);
      
      // Fallback responses
      const fallbacks = [
        'Sorry, I cannot process your request right now. Please try again later.',
      ];
      
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }

  /**
   * Test the API connection
   */
  async test() {
    try {
      const result = await generateText({
        model: this.model,
        prompt: 'Hello! Please respond with "OK"',
      });
      logger.info('Gemini API test successful:', result.text);
      return true;
    } catch (error) {
      logger.error('Gemini API test failed:', error);
      return false;
    }
  }
}
