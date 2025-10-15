import { google } from '@ai-sdk/google';
import { generateText } from 'ai';
import { logger } from './logger.js';
import { CircuitBreaker } from './circuitbreaker.js';

/**
 * Gemini AI integration using AI SDK with circuit breaker protection
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
    
    // Circuit breaker for API protection
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,    // Open after 5 failures
      successThreshold: 2,    // Close after 2 successes
      timeout: 30000,         // 30 second timeout per request
      resetTimeout: 30000,    // Try again after 30 seconds
    });
    
    this.stats = {
      requests: 0,
      successful: 0,
      failed: 0,
      fallbacks: 0,
    };
  }

  /**
   * Generate a response to a message with circuit breaker protection
   */
  async generateResponse(message, conversationHistory = []) {
    this.stats.requests++;
    
    // Use circuit breaker to protect against API failures
    return this.circuitBreaker.execute(
      async () => {
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

        logger.debug('Gemini response generated successfully');
        this.stats.successful++;
        return result.text;
      },
      // Fallback function if circuit is open or request fails
      () => {
        this.stats.fallbacks++;
        logger.warn('Using fallback response due to circuit breaker');
        
        const fallbacks = [
          "I'm currently experiencing high demand. Please try again in a moment.",
          "My AI service is temporarily busy. I'll be back shortly!",
          "I'm processing many requests right now. Please wait a moment and try again.",
        ];
        
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
      }
    );
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

  /**
   * Get service statistics
   */
  getStats() {
    return {
      ...this.stats,
      successRate: this.stats.requests > 0 
        ? ((this.stats.successful / this.stats.requests) * 100).toFixed(2) + '%'
        : 'N/A',
      circuitBreaker: this.circuitBreaker.getState(),
    };
  }
}
