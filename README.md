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

- 🚀 Lightweight and fast 
- 🔄 Auto-reconnect to relays
- 🔐 NIP-04 encryption for DMs
- 📡 Multiple relay support
- � Web dashboard for monitoring
- 💾 LMDB database for message storage

## Web Dashboard

Access the monitoring dashboard at http://localhost:8080

- View bot statistics (uptime, messages, errors)
- Monitor relay status
- See recent messages
