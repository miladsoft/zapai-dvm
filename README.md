# ZapAI

ZapAI Data Vending Machine - A specialized DVM (Data Vending Machine) built exclusively for the ZapAI platform. This DVM provides AI-powered responses using Gemini integration over the Nostr protocol.

## What is a DVM?

A Data Vending Machine (DVM) is a specialized Nostr service that provides on-demand data processing and responses. This DVM is specifically designed to serve ZapAI's AI capabilities.

## Quick Start

### Installation
```bash
npm install
```

### Configuration
Create a `.env` file:
```env
# Required
BOT_PRIVATE_KEY=your_private_key_here
GEMINI_API_KEY=your_gemini_api_key_here
GOOGLE_GENERATIVE_AI_API_KEY=your_gemini_api_key_here
NOSTR_RELAYS=wss://relay.nostr.band,wss://relay.damus.io,wss://nos.lol

# Optional - Scalability Settings
MAX_CONCURRENT=10          # Process 10 messages simultaneously
MAX_QUEUE_SIZE=10000       # Hold up to 10k messages in queue
RATE_LIMIT_MAX_TOKENS=50   # 50 requests per user per minute
RATE_LIMIT_REFILL_RATE=5   # 5 tokens refilled per second

WEB_PORT=8080
```

### Start the Bot
```bash
./start.sh
```
This will:
- Start the bot in background
- Launch web dashboard at http://localhost:8080
- Save logs to `bot.log`

### Stop the Bot
```bash
./stop.sh
```

### View Logs
```bash
tail -f bot.log
```

## Features

### Core Features
- 🚀 **Production-grade scalability** - Handle thousands of users
- 🤖 **Gemini AI Integration** - Powered by Google's latest AI (gemini-2.5-flash)
- 🔄 **Auto-reconnect** to relays with exponential backoff
- 🔐 **NIP-04 encryption** for private DMs
- 📡 **Multiple relay support** with health monitoring (12 relays)
- 💾 **LMDB database** for persistent conversation history
- 🧠 **Conversation memory** - Bot remembers context (50 messages stored, 10 used)
- 💬 **Dual mode messaging**:
  - Encrypted DMs (kind 4) for private conversations
  - Public replies (kind 1) for mentions and replies

### Scalability Features
- ⚡ **Message Queue** - Process 10 messages concurrently with 10k buffer
- 🛡️ **Rate Limiting** - Per-user limits (50 req/min) with token bucket algorithm
- � **Circuit Breaker** - Automatic fault tolerance and API protection
- 📊 **Comprehensive Monitoring** - Real-time stats and health checks
- ⏱️ **Timeout Protection** - Prevents hanging requests (45s timeout)
- 🎯 **Graceful Degradation** - Friendly error messages when overloaded
- ♻️ **Retry Logic** - 3 automatic retries with exponential backoff
- 🔍 **Duplicate Prevention** - Smart deduplication by content fingerprint

## Web Dashboard

Access the monitoring dashboard at http://localhost:8080

- View bot statistics (uptime, messages, errors)
- Monitor relay status
- See recent messages
