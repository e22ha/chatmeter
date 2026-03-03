import { jest } from '@jest/globals'
import '../core/ChatStatsEngine.js'
const ChatStatsEngine = globalThis.ChatStatsEngine

// Minimal WebSocket mock
class MockWebSocket {
  constructor(url) {
    this.url = url
    this.sent = []
    MockWebSocket.instance = this
  }
  send(msg) { this.sent.push(msg) }
  close() { this.readyState = 3 }
}
MockWebSocket.OPEN = 1
MockWebSocket.CLOSED = 3

describe('ChatStatsEngine — IRC connection', () => {
  let engine

  beforeEach(() => {
    MockWebSocket.instance = null
    engine = new ChatStatsEngine('testchannel', { WebSocket: MockWebSocket })
  })

  afterEach(() => engine.stop())

  test('connects to Twitch IRC on start()', () => {
    engine.start()
    expect(MockWebSocket.instance).not.toBeNull()
    expect(MockWebSocket.instance.url).toBe('wss://irc-ws.chat.twitch.tv:443')
  })

  test('sends NICK and JOIN after open', () => {
    engine.start()
    MockWebSocket.instance.onopen()
    const sent = MockWebSocket.instance.sent
    expect(sent.some(m => /^NICK justinfan\d+$/.test(m))).toBe(true)
    expect(sent).toContain('JOIN #testchannel')
  })

  test('replies PONG to PING', () => {
    engine.start()
    MockWebSocket.instance.onopen()
    MockWebSocket.instance.sent = []
    MockWebSocket.instance.onmessage({ data: 'PING :tmi.twitch.tv\r\n' })
    expect(MockWebSocket.instance.sent).toContain('PONG :tmi.twitch.tv')
  })
})

describe('ChatStatsEngine — PRIVMSG parsing', () => {
  let engine
  let lastStats

  beforeEach(() => {
    MockWebSocket.instance = null
    engine = new ChatStatsEngine('testchannel', { WebSocket: MockWebSocket })
    engine.on('update', s => { lastStats = s })
    engine.start()
    MockWebSocket.instance.onopen()
  })

  afterEach(() => engine.stop())

  function sendMsg(username, text) {
    const line = `:${username}!${username}@${username}.tmi.twitch.tv PRIVMSG #testchannel :${text}\r\n`
    MockWebSocket.instance.onmessage({ data: line })
  }

  test('emits update on each message', () => {
    sendMsg('alice', 'hello')
    expect(lastStats).toBeDefined()
  })

  test('counts total messages', () => {
    sendMsg('alice', 'hello')
    sendMsg('bob', 'hey')
    expect(lastStats.totalMessages).toBe(2)
  })

  test('tracks unique chatters', () => {
    sendMsg('alice', 'hello')
    sendMsg('alice', 'hello again')
    sendMsg('bob', 'hey')
    expect(lastStats.uniqueChatters).toBe(2)
  })
})

describe('ChatStatsEngine — derived metrics', () => {
  let engine, lastStats

  beforeEach(() => {
    MockWebSocket.instance = null
    engine = new ChatStatsEngine('testchannel', {
      WebSocket: MockWebSocket,
      engagedThreshold: 3,
      activeWindowMs: 5 * 60 * 1000,
    })
    engine.on('update', s => { lastStats = s })
    engine.start()
    MockWebSocket.instance.onopen()
  })

  afterEach(() => engine.stop())

  function sendMsg(username, text = 'hi') {
    const line = `:${username}!${username}@${username}.tmi.twitch.tv PRIVMSG #testchannel :${text}\r\n`
    MockWebSocket.instance.onmessage({ data: line })
  }

  test('engagedChatters counts users with >= threshold messages', () => {
    sendMsg('alice'); sendMsg('alice'); sendMsg('alice') // 3 msgs
    sendMsg('bob')                                       // 1 msg
    expect(lastStats.engagedChatters).toBe(1)
  })

  test('newChatters increments on first message from user', () => {
    sendMsg('alice')
    sendMsg('alice')
    sendMsg('bob')
    expect(lastStats.newChatters).toBe(2)
  })

  test('topChatters returns top 5 by count', () => {
    for (let i = 0; i < 5; i++) sendMsg('alice')
    for (let i = 0; i < 3; i++) sendMsg('bob')
    sendMsg('carol')
    expect(lastStats.topChatters[0]).toEqual({ username: 'alice', count: 5 })
    expect(lastStats.topChatters[1]).toEqual({ username: 'bob', count: 3 })
  })

  test('commandRatio detects ! prefix', () => {
    sendMsg('alice', '!commands')
    sendMsg('bob', 'hello')
    expect(lastStats.commandRatio).toBe(0.5)
  })

  test('emoteOnlyRatio detects emote-only messages', () => {
    // emote-only heuristic: all tokens start with uppercase letter
    sendMsg('alice', 'Kappa PogChamp')
    sendMsg('bob', 'hello world')
    expect(lastStats.emoteOnlyRatio).toBe(0.5)
  })

  test('activeChatters counts unique users in active window', () => {
    sendMsg('alice')
    sendMsg('bob')
    sendMsg('alice') // alice again
    expect(lastStats.activeChatters).toBe(2)
  })

  test('msgsPerMin counts messages in last 60 seconds', () => {
    sendMsg('alice')
    sendMsg('bob')
    sendMsg('carol')
    expect(lastStats.msgsPerMin).toBe(3)
  })

  test('peakMsgsPerMin retains highest value even after msgsPerMin drops', () => {
    // Send messages to establish a peak
    for (let i = 0; i < 5; i++) sendMsg(`user${i}`)
    const peak = lastStats.peakMsgsPerMin
    expect(peak).toBeGreaterThan(0)

    // Manually age all messages past the 60s window to make msgsPerMin drop
    const now = Date.now()
    engine._recentMsgs.forEach(m => { m.ts = now - 120_000 })

    // Send one more message (triggers _updateStats with near-zero msgsPerMin)
    sendMsg('late')
    expect(lastStats.msgsPerMin).toBeLessThan(peak)
    expect(lastStats.peakMsgsPerMin).toBe(peak)
  })
})

describe('ChatStatsEngine — event emitter', () => {
  test('on() supports multiple listeners for the same event', () => {
    MockWebSocket.instance = null
    const engine = new ChatStatsEngine('testchannel', { WebSocket: MockWebSocket })
    const calls = []
    engine.on('update', s => calls.push('a'))
    engine.on('update', s => calls.push('b'))
    engine.start()
    MockWebSocket.instance.onopen()

    const line = ':alice!alice@alice.tmi.twitch.tv PRIVMSG #testchannel :hi\r\n'
    MockWebSocket.instance.onmessage({ data: line })

    expect(calls).toEqual(['a', 'b'])
    engine.stop()
  })
})

describe('ChatStatsEngine — reconnect', () => {
  test('reconnects after unexpected close with backoff', done => {
    jest.useFakeTimers()
    MockWebSocket.instance = null
    const engine = new ChatStatsEngine('testchannel', { WebSocket: MockWebSocket })
    engine.start()
    const first = MockWebSocket.instance
    MockWebSocket.instance.onopen()

    // simulate unexpected close (code 1006 = abnormal)
    MockWebSocket.instance.onclose({ code: 1006 })

    // first backoff is 1s (2^0 * 1000 = 1000ms)
    jest.advanceTimersByTime(1100)
    expect(MockWebSocket.instance).not.toBe(first)

    engine.stop()
    jest.useRealTimers()
    done()
  })

  test('does NOT reconnect after clean stop', () => {
    jest.useFakeTimers()
    MockWebSocket.instance = null
    const engine = new ChatStatsEngine('testchannel', { WebSocket: MockWebSocket })
    engine.start()
    MockWebSocket.instance.onopen()
    engine.stop()

    const after = MockWebSocket.instance
    jest.advanceTimersByTime(5000)
    // should be same instance (no new connection created)
    expect(MockWebSocket.instance).toBe(after)

    jest.useRealTimers()
  })
})
