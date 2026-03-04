// extension/content.js
// ChatStatsEngine is loaded as a classic script before this file (see manifest.json)

// Twitch updates their DOM — try multiple selectors in order
const VIEWER_SELECTORS = [
  '[data-a-target="animated-channel-viewers-count"]',
  '[data-a-target="channel-viewers-count"]',
  'p[data-a-target*="viewer"]',
  'span[data-a-target*="viewer"]',
]
const BADGE_ID = 'ttv-chat-stats-badge'

function findViewerEl() {
  // In mod view, prefer the lower viewer count inside the player widget, not the header
  const modContainer = document.querySelector('.modview-player-widget__viewcount')
  if (modContainer) {
    for (const sel of VIEWER_SELECTORS) {
      const el = modContainer.querySelector(sel)
      if (el) { console.log('[TTV Stats] viewer el found (modview) via:', sel); return el }
    }
  }
  for (const sel of VIEWER_SELECTORS) {
    const el = document.querySelector(sel)
    if (el) { console.log('[TTV Stats] viewer el found via:', sel); return el }
  }
  return null
}

function esc(str) {
  return String(str).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function fmt(n) {
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

let engine = null
let badge = null
let popover = null
let pendingInitObserver = null
let hideTimeout = null

function getChannel() {
  // Mod view: /moderator/<channel>
  const modMatch = location.pathname.match(/^\/moderator\/([^/]+)/)
  if (modMatch) return modMatch[1].toLowerCase()
  // Regular stream: /<channel>
  const match = location.pathname.match(/^\/([^/]+)/)
  return match ? match[1].toLowerCase() : null
}

function positionPopover() {
  if (!badge || !popover) return
  const rect = badge.getBoundingClientRect()
  const spaceAbove = rect.top
  const spaceBelow = window.innerHeight - rect.bottom
  const popH = popover.offsetHeight

  if (spaceAbove >= popH + 12 || spaceAbove >= spaceBelow) {
    // show above
    popover.style.top = 'auto'
    popover.style.bottom = (window.innerHeight - rect.top + 10) + 'px'
  } else {
    // show below
    popover.style.bottom = 'auto'
    popover.style.top = (rect.bottom + 10) + 'px'
  }

  // Clamp horizontally so popover doesn't go off-screen
  let left = rect.left
  if (left + 360 > window.innerWidth - 10) left = window.innerWidth - 370
  if (left < 10) left = 10
  popover.style.left = left + 'px'
}

function showPopover() {
  clearTimeout(hideTimeout)
  popover.hidden = false
  positionPopover()
}

function hidePopover() {
  hideTimeout = setTimeout(() => { popover.hidden = true }, 80)
}

function createBadge() {
  const wrap = document.createElement('div')
  wrap.id = BADGE_ID
  wrap.innerHTML = `
    <span class="ttv-stats-pill">
      <span class="ttv-stats-msgs">💬 –</span>
      <span class="ttv-stats-speed">⚡ –/м</span>
      <span class="ttv-stats-active">👥 –</span>
    </span>
  `
  badge = wrap.querySelector('.ttv-stats-pill')

  // Popover lives on document.body to escape all Twitch stacking contexts
  popover = document.createElement('div')
  popover.className = 'ttv-stats-popover'
  popover.hidden = true
  document.body.appendChild(popover)

  wrap.addEventListener('mouseenter', showPopover)
  wrap.addEventListener('mouseleave', hidePopover)
  popover.addEventListener('mouseenter', () => clearTimeout(hideTimeout))
  popover.addEventListener('mouseleave', hidePopover)

  return wrap
}

function updateBadge(stats) {
  if (!badge) return
  badge.querySelector('.ttv-stats-msgs').textContent = `💬 ${fmt(stats.totalMessages)}`
  badge.querySelector('.ttv-stats-speed').textContent = `⚡ ${fmt(stats.msgsPerMin)}/м`
  badge.querySelector('.ttv-stats-active').textContent = `👥 ${fmt(stats.activeChatters)}`
  updatePopover(stats)
}

function updatePopover(s) {
  if (!popover) return
  popover.innerHTML = `
    <div class="ttv-pop-header">
      <span class="ttv-pop-title">Chat Stats</span>
    </div>
    <div class="ttv-pop-sep"></div>
    <div class="ttv-pop-hero">
      <div class="ttv-pop-hero-stat">
        <div class="ttv-pop-hero-val ttv-c-speed">${s.msgsPerMin}</div>
        <div class="ttv-pop-hero-lab">MSG / MIN</div>
      </div>
      <div class="ttv-pop-hero-div"></div>
      <div class="ttv-pop-hero-stat">
        <div class="ttv-pop-hero-val ttv-c-active">${s.activeChatters}</div>
        <div class="ttv-pop-hero-lab">ACTIVE (5M)</div>
      </div>
      <div class="ttv-pop-hero-div"></div>
      <div class="ttv-pop-hero-stat">
        <div class="ttv-pop-hero-val">${s.totalMessages}</div>
        <div class="ttv-pop-hero-lab">TOTAL MSGS</div>
      </div>
    </div>
    <div class="ttv-pop-sep"></div>
    <div class="ttv-pop-meta">
      <div class="ttv-pop-meta-item"><span>Unique</span><span>${s.uniqueChatters}</span></div>
      <div class="ttv-pop-meta-item"><span>Engaged</span><span>${s.engagedChatters}</span></div>
      <div class="ttv-pop-meta-item"><span>Peak</span><span>${s.peakMsgsPerMin}/min</span></div>
      <div class="ttv-pop-meta-item"><span>Commands</span><span>${(s.commandRatio * 100).toFixed(0)}%</span></div>
      <div class="ttv-pop-meta-item"><span>Emote-only</span><span>${(s.emoteOnlyRatio * 100).toFixed(0)}%</span></div>
    </div>
    <div class="ttv-pop-sep"></div>
    <div class="ttv-pop-top-hdr">Top Chatters</div>
    ${s.topChatters.slice(0, 10).map(({ username, count }, i) =>
      `<div class="ttv-top-row">
        <span class="ttv-top-rank">${i + 1}</span>
        <span class="ttv-top-name">${esc(username)}</span>
        <span class="ttv-top-count">${count}</span>
      </div>`
    ).join('')}
    <div class="ttv-pop-footer"></div>
  `
}

function inject() {
  if (document.getElementById(BADGE_ID)) return

  const viewerEl = findViewerEl()
  if (!viewerEl) { console.log('[TTV Stats] inject: viewer el not found'); return }

  // Walk back through siblings to include the viewer icon (SVG) in the group,
  // so the badge lands before the icon, not between icon and number
  let insertBefore = viewerEl
  let sib = viewerEl.previousElementSibling
  while (sib) {
    if (sib.querySelector('svg') || sib.tagName === 'SVG') {
      insertBefore = sib
      sib = sib.previousElementSibling
    } else {
      break
    }
  }

  const wrap = createBadge()
  insertBefore.insertAdjacentElement('beforebegin', wrap)
  console.log('[TTV Stats] badge injected before:', insertBefore)
}

function startForChannel(channel) {
  if (engine) engine.stop()
  engine = new ChatStatsEngine(channel)
  engine.on('update', updateBadge)
  engine.start()
}

function init() {
  const channel = getChannel()
  console.log('[TTV Stats] init, channel:', channel)
  if (!channel || channel === 'directory') return

  // Try immediately
  if (findViewerEl()) {
    inject()
    startForChannel(channel)
    return
  }

  console.log('[TTV Stats] viewer el not ready, waiting...')
  // Otherwise wait for Twitch SPA to render the viewer count
  pendingInitObserver = new MutationObserver(() => {
    if (findViewerEl()) {
      pendingInitObserver.disconnect()
      pendingInitObserver = null
      inject()
      startForChannel(channel)
    }
  })
  pendingInitObserver.observe(document.body, { childList: true, subtree: true })
}

// Handle SPA navigation — Twitch changes URL without full page reload
let lastPath = location.pathname
new MutationObserver(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname
    const old = document.getElementById(BADGE_ID)
    if (old) old.remove()
    if (popover) { popover.remove(); popover = null }
    clearTimeout(hideTimeout)
    badge = null
    if (engine) {
      engine.stop()
      engine = null
    }
    if (pendingInitObserver) {
      pendingInitObserver.disconnect()
      pendingInitObserver = null
    }
    init()
  }
}).observe(document.body, { childList: true, subtree: true })

init()
