# Chatmeter — Twitch Chat Stats

Real-time Twitch chat engagement metrics — as a **Chrome extension** that injects stats directly into Twitch, and a **standalone web app**.

No Twitch login required. Connects anonymously via IRC WebSocket.

**Live demo:** [dev.ezzha.ru/chatmeter](https://dev.ezzha.ru/chatmeter/)  
**Source:** [github.com/e22ha/chatmeter](https://github.com/e22ha/chatmeter)

---

## What it shows

| Metric | Description |
|--------|-------------|
| 💬 Messages | Total messages since you opened the stream |
| ⚡ Speed | Messages per minute (last 60s) |
| 👥 Active | Unique chatters in the last 5 minutes |
| Unique | Total unique chatters |
| Engaged | Chatters with ≥ 3 messages |
| Peak | Highest msgs/min recorded |
| Top chatters | Top 25 by message count (searchable) |
| Commands | % of messages starting with `!` |
| Emote-only | % of emote-only messages (Twitch + 7TV + BTTV + FFZ) |

---

## Chrome Extension

Injects a stats badge directly into the Twitch header — works on regular streams and **Mod View**.

```
💬 1 204   ⚡ 47/м   👥 312   👤 5 977 ...
```

Hover the badge for a full breakdown popup with top 10 chatters.

### Install

1. Clone the repo
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the repo folder
5. Open any Twitch stream

---

## Web App

Full-page dashboard with speed/active charts, stats cards, top chatters, bot filter, and live chat feed.

### Run with Docker

```bash
cp docker-compose.example.yml docker-compose.yml
# edit docker-compose.yml to set your port if needed
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080), enter a channel name, click Connect.

### Run without Docker

Serve the project root with any static file server:

```bash
npx serve .
```

---

## Project structure

```
chatmeter/
├── core/
│   └── ChatStatsEngine.js   # Shared IRC engine (extension + web app)
├── extension/
│   ├── content.js           # DOM injection into Twitch
│   └── styles.css
├── webapp/
│   ├── index.html
│   ├── app.js
│   └── nginx.conf
├── tests/
│   └── ChatStatsEngine.test.js
├── manifest.json            # Chrome extension manifest (MV3)
└── docker-compose.example.yml
```

---

## Development

```bash
node --experimental-vm-modules node_modules/.bin/jest
```

After editing extension files — reload in `chrome://extensions/`.

---

## How it works

`ChatStatsEngine` opens an anonymous WebSocket to `wss://irc-ws.chat.twitch.tv` using a `justinfan` nick, requests IRCv3 tags (`CAP REQ :twitch.tv/tags twitch.tv/commands`), joins the channel, and parses `PRIVMSG` + `ROOMSTATE` lines. Stats are recomputed on every message and emitted via a simple event emitter. Reconnects with exponential backoff.

Third-party emotes (7TV, BTTV, FFZ) are fetched via public APIs using the channel `room-id` from `ROOMSTATE`.
