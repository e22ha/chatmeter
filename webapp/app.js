// webapp/app.js
// ChatStatsEngine loaded as classic script before this module (see index.html)

const $ = id => document.getElementById(id)
let engine = null
let timerInterval = null
let historyInterval = null
let sessionStart = null
let lastStats = null

const speedSamples = []
const speedHistory = []
const activeHistory = []

const MAX_CHAT_LINES = 200
const MAX_HISTORY = 120
const SAMPLE_INTERVAL = 30_000

// ── Bot filter ────────────────────────────────────────────

const KNOWN_BOTS = new Set([
  'streamelements', 'nightbot', 'streamlabs', 'fossabot', 'moobot',
  'botrixoficial', 'commanderroot', 'wizebot', 'phantombot', 'streamlobster',
  'kofistreambot', 'pretzelrocks', 'sery_bot', 'soundalerts', 'restreambot',
  'mixitupapp', 'logviewer', 'buttsbot', 'own3d', 'warpworldbot',
  'pokemoncommunitygame', 'dixperbadgeupdate', 'streamcords', 'creatisbot',
  'markov_chain_bot', 'statsbot',
])

function loadCustomBots() {
  try { return new Set(JSON.parse(localStorage.getItem('chatmeter_bots') || '[]')) }
  catch { return new Set() }
}

function saveCustomBots() {
  localStorage.setItem('chatmeter_bots', JSON.stringify([...customBots]))
}

let customBots = loadCustomBots()
let botsActive = false

// ── Search state ──────────────────────────────────────────

let searchQuery = ''

// ── Emote cache ───────────────────────────────────────────

let thirdPartyEmoteCache = new Set()

// ── Init ─────────────────────────────────────────────────

$('connect-btn').addEventListener('click', connect)
$('channel-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect() })
$('disconnect-btn').addEventListener('click', disconnect)

$('toggle-chat').addEventListener('click', () => {
  const feed = $('chat-feed')
  const btn = $('toggle-chat')
  const hidden = feed.style.display === 'none'
  feed.style.display = hidden ? '' : 'none'
  btn.textContent = hidden ? 'hide' : 'show'
})

$('toggle-bots').addEventListener('click', () => {
  botsActive = !botsActive
  const btn = $('toggle-bots')
  btn.classList.toggle('active', botsActive)
  btn.textContent = botsActive ? 'bots: on' : 'bots: off'
  if (engine) {
    engine.setBotFilter(botsActive ? new Set([...KNOWN_BOTS, ...customBots]) : new Set())
    engine.refresh()
  }
})

$('chatter-search').addEventListener('input', e => {
  searchQuery = e.target.value.trim().toLowerCase()
  renderTopList(lastStats ? lastStats.topChatters : [])
})

$('custom-bot-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') addCustomBot()
})
$('add-bot-btn').addEventListener('click', addCustomBot)

$('custom-bot-tags').addEventListener('click', e => {
  const btn = e.target.closest('.bot-tag-remove')
  if (btn) removeCustomBot(btn.dataset.bot)
})

window.addEventListener('resize', () => {
  if (lastStats) { drawSpeedChart(); drawActiveChart() }
})

// Render persisted custom bots on load
renderCustomBotTags()

// ── Connect / disconnect ──────────────────────────────────

async function connect() {
  const channel = $('channel-input').value.trim().toLowerCase()
  if (!channel) return

  if (engine) engine.stop()
  clearInterval(timerInterval)
  clearInterval(historyInterval)
  speedSamples.length = 0
  speedHistory.length = 0
  activeHistory.length = 0
  thirdPartyEmoteCache = new Set()
  lastStats = null
  searchQuery = ''
  $('chatter-search').value = ''
  botsActive = false
  $('toggle-bots').classList.remove('active')
  $('toggle-bots').textContent = 'bots: off'
  $('chat-feed').innerHTML = ''

  $('channel-name').textContent = '#' + channel
  $('connect-screen').style.display = 'none'
  $('app').classList.add('visible')

  sessionStart = Date.now()
  timerInterval = setInterval(updateTimer, 1000)
  historyInterval = setInterval(sampleHistory, SAMPLE_INTERVAL)

  engine = new ChatStatsEngine(channel)
  engine.on('update', render)
  engine.on('message', appendChatMsg)

  // Fetch global emotes in background — engine starts immediately
  fetchGlobalEmotes(channel).then(emotes => {
    thirdPartyEmoteCache = emotes
    if (engine) engine.setThirdPartyEmotes(new Set(thirdPartyEmoteCache))
  })

  // On roomstate, enrich with channel-specific BTTV + 7TV emotes
  engine.on('roomstate', async ({ roomId }) => {
    const merged = await fetchChannelEmotes(roomId, thirdPartyEmoteCache)
    thirdPartyEmoteCache = merged
    if (engine) engine.setThirdPartyEmotes(new Set(thirdPartyEmoteCache))
  })

  engine.start()
}

function disconnect() {
  if (engine) { engine.stop(); engine = null }
  clearInterval(timerInterval)
  clearInterval(historyInterval)
  $('connect-screen').style.display = ''
  $('app').classList.remove('visible')
  $('channel-input').value = ''
}

// ── Timer ─────────────────────────────────────────────────

function updateTimer() {
  const elapsed = Math.floor((Date.now() - sessionStart) / 1000)
  const h = Math.floor(elapsed / 3600)
  const m = Math.floor((elapsed % 3600) / 60)
  const s = elapsed % 60
  $('session-timer').textContent = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

// ── Render ────────────────────────────────────────────────

function render(s) {
  lastStats = s
  $('c-speed').textContent = s.msgsPerMin
  $('c-active').textContent = s.activeChatters
  $('c-total').textContent = s.totalMessages
  $('c-unique').textContent = s.uniqueChatters
  $('c-engaged').textContent = s.engagedChatters
  $('c-peak').textContent = s.peakMsgsPerMin
  $('c-cmds').textContent = `${(s.commandRatio * 100).toFixed(0)}%`
  $('c-emotes').textContent = `${(s.emoteOnlyRatio * 100).toFixed(0)}%`
  renderTopList(s.topChatters)
  updateHype(s.msgsPerMin)
}

function renderTopList(topChatters) {
  if (!searchQuery) {
    $('top-rows').innerHTML = topChatters
      .map(({ username, count }) =>
        `<div class="top-row"><span class="top-row-name">${escHtml(username)}</span><span class="top-row-count">${count}</span></div>`
      )
      .join('')
    return
  }

  const matches = topChatters.filter(({ username }) => username.includes(searchQuery))

  if (matches.length > 0) {
    $('top-rows').innerHTML = matches
      .map(({ username, count }) =>
        `<div class="top-row"><span class="top-row-name">${escHtml(username)}</span><span class="top-row-count">${count}</span></div>`
      )
      .join('')
    return
  }

  // Not in top 25 — live lookup from engine
  const count = engine ? engine.getChatterCount(searchQuery) : 0
  $('top-rows').innerHTML = count > 0
    ? `<div class="top-row"><span class="top-row-name">${escHtml(searchQuery)}</span><span class="top-row-count">${count}</span></div>`
    : `<div class="top-row"><span class="top-row-name" style="color:var(--muted)">${escHtml(searchQuery)}</span><span class="top-row-count" style="color:var(--muted)">0</span></div>`
}

function updateHype(current) {
  speedSamples.push(current)
  if (speedSamples.length > 10) speedSamples.shift()
  const avg = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length || 1
  const ratio = current / avg
  $('hype-bar').className = 'hype-bar ' + (
    ratio < 0.8 ? 'l1' :
    ratio < 1.5 ? 'l2' :
    ratio < 3   ? 'l3' : 'l4'
  )
}

// ── Bot filter helpers ────────────────────────────────────

function addCustomBot() {
  const val = $('custom-bot-input').value.trim().toLowerCase()
  if (!val || customBots.has(val)) return
  customBots.add(val)
  saveCustomBots()
  $('custom-bot-input').value = ''
  renderCustomBotTags()
  if (botsActive && engine) {
    engine.setBotFilter(new Set([...KNOWN_BOTS, ...customBots]))
    engine.refresh()
  }
}

function removeCustomBot(name) {
  customBots.delete(name)
  saveCustomBots()
  renderCustomBotTags()
  if (botsActive && engine) {
    engine.setBotFilter(new Set([...KNOWN_BOTS, ...customBots]))
    engine.refresh()
  }
}

function renderCustomBotTags() {
  $('custom-bot-tags').innerHTML = [...customBots]
    .map(name =>
      `<span class="bot-tag">${escHtml(name)}<button class="bot-tag-remove" data-bot="${escHtml(name)}">&times;</button></span>`
    )
    .join('')
}

// ── Emote API ─────────────────────────────────────────────

async function fetchGlobalEmotes(channel) {
  const emotes = new Set()
  await Promise.allSettled([
    fetch(`https://api.frankerfacez.com/v1/room/${channel}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.sets) for (const s of Object.values(d.sets)) for (const e of s.emoticons || []) emotes.add(e.name) })
      .catch(() => {}),

    fetch('https://api.betterttv.net/3/cached/emotes/global')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d)) for (const e of d) emotes.add(e.code) })
      .catch(() => {}),

    fetch('https://7tv.io/v3/emote-sets/global')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d?.emotes)) for (const e of d.emotes) emotes.add(e.name) })
      .catch(() => {}),
  ])
  return emotes
}

async function fetchChannelEmotes(roomId, existingEmotes) {
  const emotes = new Set(existingEmotes)
  await Promise.allSettled([
    fetch(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return
        for (const e of d.channelEmotes || []) emotes.add(e.code)
        for (const e of d.sharedEmotes || []) emotes.add(e.code)
      })
      .catch(() => {}),

    fetch(`https://7tv.io/v3/users/twitch/${roomId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (Array.isArray(d?.emote_set?.emotes)) for (const e of d.emote_set.emotes) emotes.add(e.name) })
      .catch(() => {}),
  ])
  return emotes
}

// ── History sampling ──────────────────────────────────────

function sampleHistory() {
  if (!lastStats) return
  const ts = Date.now()
  speedHistory.push({ ts, value: lastStats.msgsPerMin })
  activeHistory.push({ ts, value: lastStats.activeChatters })
  if (speedHistory.length > MAX_HISTORY) speedHistory.shift()
  if (activeHistory.length > MAX_HISTORY) activeHistory.shift()
  drawSpeedChart()
  drawActiveChart()
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
function drawSpeedChart()  { drawChart('chart-speed',  speedHistory,  cssVar('--speed')  || '#e8000b') }
function drawActiveChart() { drawChart('chart-active', activeHistory, cssVar('--active') || '#1a56e8') }

function drawChart(canvasId, data, color) {
  const canvas = $(canvasId)
  if (!canvas) return

  const dpr = window.devicePixelRatio || 1
  const W = canvas.offsetWidth || 200
  const H = canvas.offsetHeight || 58

  canvas.width  = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, W, H)

  if (data.length < 2) {
    ctx.strokeStyle = color + '28'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, H - 1); ctx.lineTo(W, H - 1); ctx.stroke()
    return
  }

  const vals = data.map(d => d.value)
  const maxVal = Math.max(...vals, 1)
  const pad = 4

  const pts = data.map((d, i) => ({
    x: (i / (data.length - 1)) * (W - pad * 2) + pad,
    y: H - pad - (d.value / maxVal) * (H - pad * 2),
  }))

  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, hexToRgba(color, 0.18))
  grad.addColorStop(1, hexToRgba(color, 0.01))
  ctx.beginPath()
  ctx.moveTo(pts[0].x, H)
  ctx.lineTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) {
    const cpx = (pts[i - 1].x + pts[i].x) / 2
    ctx.bezierCurveTo(cpx, pts[i - 1].y, cpx, pts[i].y, pts[i].x, pts[i].y)
  }
  ctx.lineTo(pts[pts.length - 1].x, H)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) {
    const cpx = (pts[i - 1].x + pts[i].x) / 2
    ctx.bezierCurveTo(cpx, pts[i - 1].y, cpx, pts[i].y, pts[i].x, pts[i].y)
  }
  ctx.strokeStyle = hexToRgba(color, 0.75)
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  ctx.stroke()

  const tip = pts[pts.length - 1]
  ctx.beginPath()
  ctx.arc(tip.x, tip.y, 2.5, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.shadowColor = color
  ctx.shadowBlur = 6
  ctx.fill()
  ctx.shadowBlur = 0
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

// ── Chart tooltips ────────────────────────────────────────

function addTooltip(canvasId, data, unit) {
  const canvas = $(canvasId)
  const tooltip = $('chart-tooltip')

  function showAt(clientX, clientY) {
    if (data.length < 2) return
    const rect = canvas.getBoundingClientRect()
    const mx = clientX - rect.left
    const pad = 4
    const idx = Math.round((mx - pad) / (rect.width - pad * 2) * (data.length - 1))
    const i = Math.max(0, Math.min(data.length - 1, idx))
    const point = data[i]
    const minAgo = Math.floor((Date.now() - point.ts) / 60000)
    const timeStr = minAgo === 0 ? 'now' : `${minAgo}m ago`
    tooltip.textContent = `${point.value} ${unit}  ·  ${timeStr}`
    tooltip.style.left = Math.min(clientX + 14, window.innerWidth - 160) + 'px'
    tooltip.style.top  = Math.max(clientY - 30, 8) + 'px'
    tooltip.hidden = false
  }

  canvas.addEventListener('mousemove', e => showAt(e.clientX, e.clientY))
  canvas.addEventListener('mouseleave', () => { tooltip.hidden = true })
  canvas.addEventListener('touchmove', e => {
    e.preventDefault(); const t = e.touches[0]; showAt(t.clientX, t.clientY)
  }, { passive: false })
  canvas.addEventListener('touchend', () => { tooltip.hidden = true })
}

addTooltip('chart-speed',  speedHistory,  'msg/min')
addTooltip('chart-active', activeHistory, 'chatters')

// ── Chat ──────────────────────────────────────────────────

function appendChatMsg({ username, text }) {
  const feed = $('chat-feed')
  const el = document.createElement('div')
  el.className = 'chat-msg'
  el.innerHTML = `<span class="chat-user">${escHtml(username)}:</span><span class="chat-text">${escHtml(text)}</span>`
  feed.appendChild(el)
  while (feed.children.length > MAX_CHAT_LINES) feed.firstChild.remove()
  if (feed.scrollHeight - feed.scrollTop < feed.clientHeight + 80) {
    feed.scrollTop = feed.scrollHeight
  }
}

function escHtml(str) {
  return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
