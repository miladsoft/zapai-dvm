import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';
import { CircuitBreaker } from './circuitbreaker.js';

/**
 * Gemini AI integration with Google Search grounding and circuit breaker protection
 */
export class GeminiAI {
  constructor(apiKey, botName = 'ZapAI') {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.botName = botName;
    this.modelConfig = {
      temperature: 0.9,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 1024,
    };
    
    // Circuit breaker for API protection
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,    // Open after 5 failures
      successThreshold: 2,    // Close after 2 successes
      timeout: 50000,         // 50 second timeout per request (increased from 30)
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
   * Generate a concise memory summary from conversation history.
   * Returns a short plain-text summary that the model can use as persistent context.
   */
  async summarizeMemory(conversationHistory = [], model) {
    try {
      if (!conversationHistory || conversationHistory.length === 0) return '';

      // Compose a compact representation of the recent history
      const recent = conversationHistory.slice(-40).map(m => `${m.isFromBot ? 'Assistant' : 'User'}: ${m.message}`).join('\n');

      const prompt = `You are an assistant that extracts a short, useful "memory" from a conversation to help future replies.\n` +
        `From the conversation below, produce a JSON object with the following keys:\n` +
        `- summary: one or two short sentences that capture the user's goals and the current conversation state.\n` +
        `- facts: an array of short facts (name, location, ongoing tasks, important dates) that should be remembered.\n` +
        `- preferences: an array of user preferences (style, tone, dislikes) observed.\n` +
        `Return only valid JSON. Conversation:\n\n${recent}`;

      // Use a lightweight generation config for summarization
      const summarizationModel = model;
      const chat = summarizationModel.startChat();
      const result = await chat.sendMessage(prompt, { temperature: 0.2, maxOutputTokens: 256 });
      const response = await result.response;
      const text = response.text();

      // Try to parse the JSON; if parsing fails, return the raw text trimmed
      try {
        const parsed = JSON.parse(text);
        // Build a short human-readable memory summary from parsed fields
        const summaryParts = [];
        if (parsed.summary) summaryParts.push(parsed.summary.trim());
        if (Array.isArray(parsed.facts) && parsed.facts.length) summaryParts.push('Facts: ' + parsed.facts.join(', '));
        if (Array.isArray(parsed.preferences) && parsed.preferences.length) summaryParts.push('Preferences: ' + parsed.preferences.join(', '));

        return summaryParts.join(' | ');
      } catch (e) {
        // Not valid JSON - fallback to trimming the model output
        return text.split('\n').slice(0,4).join(' ').trim();
      }
    } catch (error) {
      logger.warn('summarizeMemory failed:', error.message || error);
      return '';
    }
  }

  /**
   * Generate a response to a message with circuit breaker protection and Google Search grounding
   */
  async generateResponse(message, conversationHistory = []) {
    this.stats.requests++;
    
    logger.info(`Generating response for message (${conversationHistory.length} history messages)...`);
    
    // Use circuit breaker to protect against API failures
    return this.circuitBreaker.execute(
      async () => {
        logger.debug('Circuit breaker executing request...');
        
        // Build system instructions
        let systemInstructions = `You are ${this.botName}, a helpful AI assistant on Nostr (a decentralized social network). `;
        systemInstructions += 'You communicate via encrypted direct messages. ';
        systemInstructions += 'Be friendly, concise, and helpful. ';
        systemInstructions += 'You can speak English fluently. ';
        systemInstructions += 'IMPORTANT: Always respond in plain text only. Do not use markdown formatting, code blocks, bold, italics, lists, or any special formatting. Just use simple, natural text.\n\n';
        systemInstructions += 'Use Google Search to find real-time data when needed. If the question is about current prices, events, news, or time-sensitive information, search for the latest information from reliable sources. Include that you searched for current information when relevant.';

        // Select Gemini model with Google Search grounding
        const model = this.genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash-exp",
            generationConfig: this.modelConfig,
            safetySettings: [
                {
                    category: "HARM_CATEGORY_HARASSMENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE",
                },
                {
                    category: "HARM_CATEGORY_HATE_SPEECH", 
                    threshold: "BLOCK_MEDIUM_AND_ABOVE",
                },
                {
                    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE",
                },
                {
                    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                    threshold: "BLOCK_MEDIUM_AND_ABOVE",
                },
            ],
            tools: [
                {
                    googleSearch: {}
                }
            ]
        });

        // Build conversation history for chat (keep it bounded)
        const chatHistory = [];
        const recentHistory = conversationHistory.slice(-40); // keep up to last 40 messages for context
        
        logger.info(`🔄 Processing ${conversationHistory.length} messages, using last ${recentHistory.length} for AI context`);
        
        if (recentHistory.length > 0) {
          // Add messages in chronological order
          recentHistory.forEach((msg, index) => {
            chatHistory.push({
              role: msg.isFromBot ? 'model' : 'user',
              parts: [{ text: msg.message }],
            });
            const preview = msg.message.substring(0, 50).replace(/\n/g, ' ');
            logger.info(`  📨 [${index + 1}] ${msg.isFromBot ? 'MODEL' : 'USER'}: "${preview}${msg.message.length > 50 ? '...' : ''}"`);
          });
          logger.info(`✅ Built chat history with ${chatHistory.length} messages for Gemini API`);
        } else {
          logger.warn(`⚠️  Empty chat history! Starting fresh conversation.`);
        }

        // Build a short memory summary from the conversation history to provide persistent context
        let memorySummary = '';
        try {
          memorySummary = await this.summarizeMemory(recentHistory, model);
          if (memorySummary) {
            logger.info(`🧠 Memory summary created: "${memorySummary.substring(0, 100)}${memorySummary.length > 100 ? '...' : ''}"`);
            systemInstructions += `\n\nMEMORY SUMMARY: ${memorySummary}`;
          } else {
            logger.info(`ℹ️  No memory summary created (empty or first conversation)`);
          }
        } catch (e) {
          logger.warn('Failed to create memory summary:', e.message || e);
        }

        // Create enhanced prompt for better search results
        const enhancedPrompt = `${systemInstructions}\n\nUser question: ${message}`;

        logger.info(`🚀 Sending to Gemini: ${chatHistory.length} history messages + current question`);
        
        // Start chat with history
        const chat = model.startChat({
          history: chatHistory,
        });

        const result = await chat.sendMessage(enhancedPrompt);
        const response = await result.response;
        const answer = response.text();

        logger.info(`Gemini response generated successfully (${answer.length} characters)`);
        this.stats.successful++;
        return answer;
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
      const model = this.genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash-exp",
        tools: [{ googleSearch: {} }]
      });
      const result = await model.generateContent('Hello! Please respond with "OK"');
      const response = await result.response;
      const text = response.text();
      logger.info('Gemini API test successful:', text);
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
