class ChatStatsEngine {
  constructor(channel, {
    WebSocket: WS = globalThis.WebSocket,
    engagedThreshold = 3,
    activeWindowMs = 5 * 60 * 1000,
  } = {}) {
    this._channel = channel.toLowerCase()
    this._WS = WS
    this._ws = null
    this._listeners = {}
    this._stopped = false
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._stats = this._initStats()
    this._userMsgCount = new Map()   // username -> message count (unfiltered)
    this._recentMsgs = []            // [{ ts, username }] (unfiltered)
    this._seenUsers = new Set()
    this._newChatters = 0
    this._totalMessages = 0
    this._totalCommandCount = 0
    this._totalEmoteOnlyCount = 0
    this._engagedThreshold = engagedThreshold
    this._activeWindowMs = activeWindowMs
    this._botSet = new Set()
    this._thirdPartyEmotes = new Set()
  }

  start() {
    this._stopped = false
    this._connect()
  }

  stop() {
    this._stopped = true
    clearTimeout(this._reconnectTimer)
    if (this._ws) {
      this._ws.onopen = null
      this._ws.onmessage = null
      this._ws.onclose = null
      this._ws.close()
      this._ws = null
    }
  }

  on(event, fn) {
    this._listeners[event] = this._listeners[event] || []
    this._listeners[event].push(fn)
    return this
  }

  setBotFilter(set) {
    this._botSet = set instanceof Set ? set : new Set()
  }

  setThirdPartyEmotes(set) {
    this._thirdPartyEmotes = set instanceof Set ? set : new Set()
  }

  getChatterCount(username) {
    return this._userMsgCount.get(username.toLowerCase()) || 0
  }

  refresh() {
    this._updateStats(false)
  }

  _emit(event, data) {
    for (const fn of (this._listeners[event] || [])) fn(data)
  }

  _connect() {
    const nick = `justinfan${Math.floor(Math.random() * 99999 + 1)}`
    this._ws = new this._WS('wss://irc-ws.chat.twitch.tv:443')

    this._ws.onopen = () => {
      this._reconnectAttempts = 0
      this._ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      this._ws.send(`NICK ${nick}`)
      this._ws.send(`JOIN #${this._channel}`)
    }

    this._ws.onmessage = ({ data }) => {
      for (const line of data.split('\r\n')) {
        if (line) this._handleLine(line)
      }
    }

    this._ws.onclose = ({ code } = {}) => {
      if (this._stopped) return
      if (code === 1000) return
      const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30_000)
      this._reconnectAttempts = Math.min(this._reconnectAttempts + 1, 5)
      this._reconnectTimer = setTimeout(() => this._connect(), delay)
    }
  }

  _initStats() {
    return {
      totalMessages: 0,
      uniqueChatters: 0,
      engagedChatters: 0,
      activeChatters: 0,
      msgsPerMin: 0,
      peakMsgsPerMin: 0,
      newChatters: 0,
      topChatters: [],
      commandRatio: 0,
      emoteOnlyRatio: 0,
    }
  }

  _parseTags(tagStr) {
    const tags = {}
    for (const part of tagStr.split(';')) {
      const eq = part.indexOf('=')
      if (eq !== -1) tags[part.slice(0, eq)] = part.slice(eq + 1)
    }
    return tags
  }

  _handleLine(line) {
    if (line.startsWith('PING')) {
      this._ws.send('PONG :tmi.twitch.tv')
      return
    }

    // Strip IRCv3 tags if present
    let tags = {}
    let rest = line
    if (line.startsWith('@')) {
      const spaceIdx = line.indexOf(' ')
      if (spaceIdx !== -1) {
        tags = this._parseTags(line.slice(1, spaceIdx))
        rest = line.slice(spaceIdx + 1)
      }
    }

    // ROOMSTATE — emit room-id for third-party emote lookup
    if (rest.includes(' ROOMSTATE ') && tags['room-id']) {
      this._emit('roomstate', { roomId: tags['room-id'] })
      return
    }

    // PRIVMSG
    const match = rest.match(/^:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\S+ :(.*)$/)
    if (match) {
      this._handleMessage(match[1].toLowerCase(), match[2], tags)
    }
  }

  _handleMessage(username, text, tags = {}) {
    const ts = Date.now()
    const count = (this._userMsgCount.get(username) || 0) + 1
    this._userMsgCount.set(username, count)
    this._recentMsgs.push({ ts, username })
    this._totalMessages++
    if (text.startsWith('!')) this._totalCommandCount++
    if (this._isEmoteOnly(text, tags)) this._totalEmoteOnlyCount++

    const isNew = !this._seenUsers.has(username)
    if (isNew) this._seenUsers.add(username)

    this._emit('message', { username, text })
    this._updateStats(isNew)
  }

  _updateStats(isNewUser) {
    if (isNewUser) this._newChatters++

    const now = Date.now()
    const windowStart = now - this._activeWindowMs
    const oneMinAgo = now - 60_000

    // Prune entries older than the active window (always against raw array)
    while (this._recentMsgs.length > 0 && this._recentMsgs[0].ts < windowStart) {
      this._recentMsgs.shift()
    }

    const hasFilter = this._botSet.size > 0

    // Speed: unfiltered — total IRC traffic is a meaningful signal even with bots
    const msgsPerMin = this._recentMsgs.filter(m => m.ts >= oneMinAgo).length

    // Active chatters: unique users in active window, bots excluded when filter on
    const activeWindow = hasFilter
      ? this._recentMsgs.filter(m => !this._botSet.has(m.username))
      : this._recentMsgs
    const activeChatters = new Set(activeWindow.map(m => m.username)).size

    // Engaged + unique chatters: iterate raw map, skip bots if filter on
    let engaged = 0
    let uniqueNonBot = 0
    for (const [username, count] of this._userMsgCount.entries()) {
      if (hasFilter && this._botSet.has(username)) continue
      uniqueNonBot++
      if (count >= this._engagedThreshold) engaged++
    }

    // Top 25: sort raw map, skip bots if filter on
    const topChatters = [...this._userMsgCount.entries()]
      .filter(([username]) => !hasFilter || !this._botSet.has(username))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([username, count]) => ({ username, count }))

    const total = this._totalMessages
    const peak = Math.max(this._stats.peakMsgsPerMin, msgsPerMin)

    this._stats = {
      totalMessages: total,
      uniqueChatters: hasFilter ? uniqueNonBot : this._userMsgCount.size,
      engagedChatters: engaged,
      activeChatters,
      msgsPerMin,
      peakMsgsPerMin: peak,
      newChatters: this._newChatters,
      topChatters,
      commandRatio: total ? this._totalCommandCount / total : 0,
      emoteOnlyRatio: total ? this._totalEmoteOnlyCount / total : 0,
    }

    this._emit('update', { ...this._stats })
  }

  _isEmoteOnly(text, tags = {}) {
    // Twitch IRCv3 tag: server confirmed all tokens are Twitch emotes
    if (tags['emote-only'] === '1') return true

    // Fallback: all tokens are in third-party emote set or start with uppercase
    const tokens = text.trim().split(/\s+/)
    return tokens.length > 0 && tokens.every(t =>
      this._thirdPartyEmotes.has(t) || /^[A-Z]/.test(t)
    )
  }
}

globalThis.ChatStatsEngine = ChatStatsEngine
