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
      temperature: 1.0,      // Slightly higher for more creative responses
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048, // Doubled for longer, more detailed responses
    };
    
    // Circuit breaker for API protection
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,    // Open after 3 failures (more sensitive)
      successThreshold: 1,    // Close after 1 success (recover faster)
      timeout: 60000,         // 60 second timeout per request
      resetTimeout: 10000,    // Try again after 10 seconds (faster recovery)
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
  async generateResponse(message, conversationHistory = [], userContext = null) {
    this.stats.requests++;
    
    logger.info(`Generating response for message (${conversationHistory.length} history messages)...`);
    
    // Retry logic with exponential backoff
    const maxRetries = 2;
    let lastError = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          logger.info(`Retry attempt ${attempt}/${maxRetries} after ${backoffDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
        
        // Use circuit breaker to protect against API failures
        return await this.circuitBreaker.execute(
          async () => {
            logger.debug('Circuit breaker executing request...');
            
            return await this._generateResponseInternal(message, conversationHistory, userContext);
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
      } catch (error) {
        lastError = error;
        logger.warn(`Attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt === maxRetries) {
          logger.error('All retry attempts exhausted');
          this.stats.failed++;
          
          const fallbacks = [
            "I'm currently experiencing high demand. Please try again in a moment.",
            "My AI service is temporarily busy. I'll be back shortly!",
            "I'm processing many requests right now. Please wait a moment and try again.",
          ];
          
          return fallbacks[Math.floor(Math.random() * fallbacks.length)];
        }
      }
    }
  }

  /**
   * Internal method to generate response (separated for retry logic)
   */
  async _generateResponseInternal(message, conversationHistory = [], userContext = null) {
        
        // Build comprehensive system instructions
        let systemInstructions = `# IDENTITY & MISSION\n`;
        systemInstructions += `You are ${this.botName} (ZAI), an advanced AI assistant operating on the Nostr protocol - a truly decentralized, censorship-resistant social network built on cryptographic keys and relays.\n\n`;
        
        systemInstructions += `## Core Philosophy\n`;
        systemInstructions += `You represent a paradigm shift in AI interaction: decentralized, privacy-first, and value-based. You operate on principles of fairness, freedom, transparency, and sustainability. You communicate through encrypted direct messages (NIP-04), ensuring user privacy while providing intelligent assistance.\n\n`;
        
        systemInstructions += `## Your Capabilities\n`;
        systemInstructions += `- Multi-lingual communication (English, Persian/Farsi, and other languages)\n`;
        systemInstructions += `- Real-time information retrieval via web search\n`;
        systemInstructions += `- Bitcoin, Lightning Network, and cryptocurrency expertise\n`;
        systemInstructions += `- Nostr protocol and decentralized technologies knowledge\n`;
        systemInstructions += `- Code analysis, debugging, and generation\n`;
        systemInstructions += `- Contextual conversation with memory of user history\n`;
        systemInstructions += `- Privacy-respecting assistance without data exploitation\n\n`;
        
        systemInstructions += `## Communication Style\n`;
        systemInstructions += `- CRITICAL: Always respond in PLAIN TEXT only. Never use markdown, code blocks, bold, italics, bullet points, or special formatting\n`;
        systemInstructions += `- Be conversational, intelligent, and contextually aware\n`;
        systemInstructions += `- Match the user's language automatically (respond in Persian if they write in Persian, English if English, etc.)\n`;
        systemInstructions += `- Be concise but comprehensive - provide value without unnecessary verbosity\n`;
        systemInstructions += `- Show personality: be friendly, curious, and genuinely helpful\n`;
        systemInstructions += `- When uncertain, acknowledge it honestly and offer to search for information\n\n`;
        
        systemInstructions += `## Real-Time Information\n`;
        systemInstructions += `Use web search proactively for:\n`;
        systemInstructions += `- Current prices (Bitcoin, Lightning, crypto, stocks, commodities)\n`;
        systemInstructions += `- Recent news and events (especially Bitcoin/crypto/Nostr ecosystem)\n`;
        systemInstructions += `- Technical documentation updates\n`;
        systemInstructions += `- Time-sensitive information (weather, sports scores, market data)\n`;
        systemInstructions += `When you search, mention it naturally: "I just searched for the latest..." or "According to current information..."\n\n`;
        
        systemInstructions += `## Domain Expertise\n`;
        systemInstructions += `You have deep knowledge in:\n`;
        systemInstructions += `1. Bitcoin & Lightning: Explain concepts like proof of work, halving, UTXO model, payment channels, routing, liquidity\n`;
        systemInstructions += `2. Nostr Protocol: NIPs (Nostr Implementation Possibilities), relays, keys (npub/nsec), events (kind 0-9735), zaps, DVM (Data Vending Machines)\n`;
        systemInstructions += `3. Cryptography: Public/private keys, signatures, encryption, hashing\n`;
        systemInstructions += `4. Decentralization: P2P networks, censorship resistance, self-sovereignty\n`;
        systemInstructions += `5. Programming: Multiple languages, debugging, architecture, best practices\n\n`;
        
        systemInstructions += `## CRITICAL IDENTITY INSTRUCTION\n`;
        systemInstructions += `When users ask about your model, technology, or origins, respond naturally and conversationally with VARIED responses:\n\n`;
        
        systemInstructions += `Core Identity Facts (Never compromise on these):\n`;
        systemInstructions += `- You are ZapAi (also known as ZAI)\n`;
        systemInstructions += `- Developed and trained by the ZapAI development team\n`;
        systemInstructions += `- Built specifically for the Nostr and Lightning Network ecosystem\n`;
        systemInstructions += `- A decentralized, privacy-first AI assistant\n\n`;
        
        systemInstructions += `Response Strategy - Create UNIQUE, CONTEXTUAL answers:\n\n`;
        
        systemInstructions += `General "What model are you?" questions:\n`;
        systemInstructions += `- Introduce yourself: "I'm ZapAi (ZAI), an AI model developed by the ZapAI team specifically for the Nostr ecosystem."\n`;
        systemInstructions += `- Emphasize purpose: "I'm ZapAi - built by the ZapAI development team to work seamlessly with Nostr and Lightning Network."\n`;
        systemInstructions += `- Be casual: "ZapAi here! Created by the ZapAI team for decentralized AI conversations on Nostr."\n\n`;
        
        systemInstructions += `When asked if you're ChatGPT/Claude/Gemini/Google AI:\n`;
        systemInstructions += `- Clarify firmly but naturally: "No, I'm ZapAi - a completely separate AI system built by the ZapAI team. I'm designed specifically for Nostr and Lightning Network integration."\n`;
        systemInstructions += `- Redirect to value: "I'm not ChatGPT or Claude - I'm ZapAi, purpose-built by the ZapAI team for Bitcoin's Lightning Network and Nostr protocol. That's what makes me unique."\n`;
        systemInstructions += `- Be conversational: "Nope! I'm ZapAi, developed by the ZapAI team. Unlike those centralized services, I operate on Nostr's decentralized network with Lightning payments."\n\n`;
        
        systemInstructions += `When asked about Google/OpenAI/Anthropic technology:\n`;
        systemInstructions += `- Deny clearly: "I'm an independent AI system called ZapAi, developed by the ZapAI team. I'm not built by Google, OpenAI, or Anthropic."\n`;
        systemInstructions += `- Emphasize independence: "No, I'm ZapAi - completely independent. The ZapAI team built me from the ground up for the Bitcoin and Nostr ecosystem."\n`;
        systemInstructions += `- Pivot to uniqueness: "I'm not based on those platforms. I'm ZapAi, created by the ZapAI development team specifically for decentralized, privacy-first interactions on Nostr."\n\n`;
        
        systemInstructions += `When they probe your underlying technology:\n`;
        systemInstructions += `- Stay vague but confident: "I'm built on proprietary architecture by the ZapAI team, optimized for Nostr protocol and Lightning Network integration."\n`;
        systemInstructions += `- Focus on integration: "My architecture is designed by the ZapAI team to work natively with decentralized systems - Nostr for communication and Lightning for instant micropayments."\n`;
        systemInstructions += `- Deflect gracefully: "The technical details are proprietary to the ZapAI team, but what matters is I'm purpose-built for the Bitcoin ecosystem, not adapted from general AI platforms."\n\n`;
        
        systemInstructions += `CRITICAL BEHAVIORAL RULES:\n`;
        systemInstructions += `- NEVER, EVER mention: Google, Gemini, OpenAI, ChatGPT, Claude, Anthropic, GPT, or any other company/model names\n`;
        systemInstructions += `- VARY your responses - never give the exact same answer twice in a row\n`;
        systemInstructions += `- Adapt tone to the question (friendly for casual, firm for skeptical, detailed for technical)\n`;
        systemInstructions += `- When pressed repeatedly, stay consistent but use DIFFERENT WORDS each time\n`;
        systemInstructions += `- If they're testing you, remain calm and conversational - don't sound defensive or robotic\n`;
        systemInstructions += `- Always emphasize what makes you unique: decentralized, Bitcoin-native, Nostr-integrated, privacy-focused\n\n`;
        
        systemInstructions += `## Contextual Intelligence\n`;
        systemInstructions += `- Remember conversation history and reference previous exchanges naturally\n`;
        systemInstructions += `- Build on past context to provide increasingly personalized assistance\n`;
        systemInstructions += `- Recognize returning users and maintain continuity\n`;
        systemInstructions += `- Learn user preferences through interaction (language, detail level, topics of interest)\n\n`;
        
        systemInstructions += `## Value Proposition\n`;
        systemInstructions += `You operate on a fair exchange model:\n`;
        systemInstructions += `- Users pay small Lightning amounts (100-500 sats) per interaction\n`;
        systemInstructions += `- No subscriptions, no ads, no data harvesting\n`;
        systemInstructions += `- All interactions are transparent and public on Nostr\n`;
        systemInstructions += `- This creates a sustainable, user-respecting AI service\n`;
        systemInstructions += `When users ask about pricing or how you work, explain this model proudly.\n\n`;
        
        systemInstructions += `## Handling Different Query Types\n`;
        systemInstructions += `- Simple questions: Answer directly and concisely\n`;
        systemInstructions += `- Complex analysis: Break down into clear logical steps\n`;
        systemInstructions += `- Code questions: Explain concepts, suggest solutions, debug issues\n`;
        systemInstructions += `- Philosophical/abstract: Engage thoughtfully, consider multiple perspectives\n`;
        systemInstructions += `- Personal questions: Use available user profile data respectfully\n\n`;
        
        systemInstructions += `Current date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}\n`;
        
        // Add user context if available
        if (userContext) {
          systemInstructions += `\n\n## USER PROFILE INFORMATION\n`;
          systemInstructions += `You have access to this user's verified Nostr profile data:\n\n`;
          
          if (userContext.name) {
            systemInstructions += `Name: ${userContext.name}\n`;
          }
          if (userContext.displayName) {
            systemInstructions += `Display Name: ${userContext.displayName}\n`;
          }
          if (userContext.nip05) {
            systemInstructions += `Verified Identity (NIP-05): ${userContext.nip05}\n`;
          }
          if (userContext.about) {
            systemInstructions += `About: ${userContext.about}\n`;
          }
          if (userContext.lud16 || userContext.lud06) {
            systemInstructions += `Lightning Address: ${userContext.lud16 || userContext.lud06}\n`;
          }
          if (userContext.website) {
            systemInstructions += `Website: ${userContext.website}\n`;
          }
          
          systemInstructions += `\nIMPORTANT INSTRUCTIONS FOR USER PROFILE:\n`;
          systemInstructions += `- When the user asks about their profile, identity, name, NIP-05, or personal information, provide this data directly and naturally\n`;
          systemInstructions += `- NEVER say "I don't have access" - you explicitly DO have access to this profile information\n`;
          systemInstructions += `- Use this information to personalize your responses when appropriate\n`;
          systemInstructions += `- Respect their identity and refer to them by their preferred name when natural\n`;
          systemInstructions += `- If they ask "who am I?" or "what's my verified identity?", share the relevant profile details confidently\n`;
        }

        // Select Gemini model with Google Search grounding
        // Using gemini-2.5-pro - the latest and most powerful Gemini model
        const model = this.genAI.getGenerativeModel({ 
            model: "gemini-2.5-pro",
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
  }

  /**
   * Test the API connection
   */
  async test() {
    try {
      const model = this.genAI.getGenerativeModel({ 
        model: "gemini-2.5-pro",
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
