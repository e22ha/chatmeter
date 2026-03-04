# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
mise run test          # Run Jest tests once
mise run test:watch    # Run tests in watch mode
```

For local web app development (no build step required):
```bash
mise exec -- npx serve .   # Serve project locally
docker compose up -d        # Run via Docker on port 8086
```

To load the Chrome extension: Open `chrome://extensions/`, enable Developer mode, click "Load unpacked", select repo root.

## Architecture

**Shared engine pattern** — one core module drives two separate UIs:

```
core/ChatStatsEngine.js     ← IRC WebSocket client + stats computation
├── extension/content.js    ← Injects badge into Twitch's header DOM
└── webapp/app.js           ← Standalone full-page dashboard
```

The project has **zero runtime dependencies** and no build step. All files are plain ES modules loaded directly by browser/extension.

### ChatStatsEngine.js

Connects anonymously to Twitch IRC (`wss://irc-ws.chat.twitch.tv`) using a random `justinfan{nnnnn}` nickname. Emits `'update'` (with computed stats object), `'message'`, and `'roomstate'` events.

Key design choices:
- **Bot filtering is selective**: speed/totalMessages are always unfiltered (raw traffic is a meaningful signal); active/unique/engaged/topChatters are filtered when bot filter is enabled.
- **`_recentMsgs` array** drives time-windowed metrics (active chatters in last 5 min, msgs/min in last 60s). Stale entries are purged on each message.
- Emote-only detection: checks IRCv3 `emote-only` tag first, then falls back to heuristic (all tokens match known 3rd-party emote names or start with uppercase).
- Reconnection: exponential backoff starting at 1s, capped at 30s, max 5 attempts.

### extension/content.js

Watches `location.pathname` for Twitch SPA navigation changes. Handles both regular streams (`/:channel`) and mod view (`/moderator/:channel`). On channel change, tears down the old engine instance and reinjects the badge.

### webapp/app.js

- Fetches 3rd-party emotes from BTTV, 7TV, FFZ APIs via `Promise.allSettled()` (graceful degradation).
- Samples speed + active chatters every 30s into a history array for canvas charts.
- Persists custom bot lists to `localStorage['chatmeter_bots']`.
- Chat feed capped at 200 entries; auto-scrolls unless user has scrolled up.

## Testing

Tests are in `tests/ChatStatsEngine.test.js` using Jest with ES modules. Tests mock `WebSocket` globally and drive the engine by calling `ws.onopen()` / `ws.onmessage()` directly. When adding tests, follow this pattern — no network calls, no async timers beyond what's already established.
