import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';

/**
 * Gemini AI integration
 */
export class GeminiAI {
  constructor(apiKey, botName = 'ZapAI DVM') {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.9,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 1024,
      },
    });
    this.botName = botName;
  }

  /**
   * Generate a response to a message
   */
  async generateResponse(message, conversationHistory = []) {
    try {
      // Build context from conversation history
      let context = `You are ${this.botName}, a helpful AI assistant on Nostr (a decentralized social network). `;
      context += 'You communicate via encrypted direct messages. ';
      context += 'Be friendly, concise, and helpful. ';
      context += 'You can speak Persian (Farsi) and English fluently.\n\n';

      if (conversationHistory.length > 0) {
        context += 'Previous conversation:\n';
        conversationHistory.slice(-10).forEach((msg) => {
          const role = msg.isFromBot ? 'Assistant' : 'User';
          context += `${role}: ${msg.message}\n`;
        });
        context += '\n';
      }

      context += `User: ${message}\nAssistant:`;

      const result = await this.model.generateContent(context);
      const response = result.response;
      const text = response.text();

      logger.debug('Gemini response:', text);
      return text;
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
      const result = await this.model.generateContent('Hello! Please respond with "OK"');
      const response = result.response.text();
      logger.info('Gemini API test successful:', response);
      return true;
    } catch (error) {
      logger.error('Gemini API test failed:', error);
      return false;
    }
  }
}
