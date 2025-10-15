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
BOT_PRIVATE_KEY=your_private_key_here
NOSTR_RELAYS=wss://relay.nostr.band,wss://relay.damus.io,wss://nos.lol
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
