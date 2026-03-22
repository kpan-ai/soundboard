const { ipcRenderer } = require('electron')
const path = require('path')

// ── State ─────────────────────────────────────────────────────────
let sounds = []
let discordOutputId = ''
let monitorOutputId = ''
let masterVolume = 80
let activeSounds = new Map()   // id → { discord: Audio, monitor: Audio }
let searchQuery = ''
let activeTag = 'all'
let pendingHotkey = null       // for hotkey modal
let pendingRenameId = null
let contextMenuEl = null

const EMOJIS = ['🔊','💥','😂','🔔','👏','🚨','🐸','🥁','💀','🎵','🎤','🎸','🦆','🐱','👾','🎮','💣','🔥','⚡','🎉','🤖','🎯','🎲','🌀']

// ── Boot ──────────────────────────────────────────────────────────
async function init() {
  const { autoSelectedId } = await loadAudioDevices()
  const config = await ipcRenderer.invoke('load-config')
  applyConfig(config)
  if (!discordOutputId && autoSelectedId) {
    discordOutputId = autoSelectedId
    document.getElementById('discord-out').value = autoSelectedId
    saveState()
  }
  ipcRenderer.send('reload-hotkeys', sounds)
  render()
}

function applyConfig(config) {
  sounds = (config.sounds || []).map(s => ({ emoji: '🔊', ...s }))
  masterVolume = config.volume ?? 80
  discordOutputId = config.discordOutputId || ''
  monitorOutputId = config.monitorOutputId || ''

  document.getElementById('master-volume').value = masterVolume
  document.getElementById('vol-display').textContent = masterVolume + '%'
  document.getElementById('discord-out').value = discordOutputId
  document.getElementById('monitor-out').value = monitorOutputId
}

function saveState() {
  ipcRenderer.send('save-config', {
    sounds,
    discordOutputId,
    monitorOutputId,
    volume: masterVolume
  })
}

// ── Audio Devices ─────────────────────────────────────────────────

// Keywords that identify Voicemeeter virtual inputs (outputs from our perspective)
const VOICEMEETER_INPUT_KEYWORDS = [
  'voicemeeter input',
  'voicemeeter aux input',
  'voicemeeter vaio',
  'voicemeeter aux vaio',
  'vb-audio voicemeeter'
]

function isVoicemeeterInput(label) {
  const l = label.toLowerCase()
  return VOICEMEETER_INPUT_KEYWORDS.some(k => l.includes(k))
}

function isVoicemeeterAux(label) {
  const l = label.toLowerCase()
  return l.includes('aux') && l.includes('voicemeeter')
}

function deviceDisplayLabel(label) {
  if (!label) return null
  const l = label.toLowerCase()
  if (l.includes('voicemeeter aux input') || (l.includes('aux') && l.includes('voicemeeter'))) {
    return '⭐ Voicemeeter AUX Input (recommended)'
  }
  if (l.includes('voicemeeter input') || (l.includes('voicemeeter') && l.includes('vaio') && !l.includes('aux'))) {
    return '⭐ Voicemeeter Input'
  }
  if (l.includes('cable input') || l.includes('vb-audio virtual cable')) {
    return 'VB-Cable Input'
  }
  return label
}

async function loadAudioDevices() {
  try { await navigator.mediaDevices.getUserMedia({ audio: true }) } catch (e) {}
  const devices = await navigator.mediaDevices.enumerateDevices()
  const outputs = devices.filter(d => d.kind === 'audiooutput')

  const discordSel = document.getElementById('discord-out')
  const monitorSel = document.getElementById('monitor-out')

  discordSel.innerHTML = '<option value="">— Select output —</option>'
  monitorSel.innerHTML = '<option value="">None</option>'

  // Sort: Voicemeeter inputs first in discord dropdown
  const sorted = [...outputs].sort((a, b) => {
    const aVM = isVoicemeeterInput(a.label || '')
    const bVM = isVoicemeeterInput(b.label || '')
    if (aVM && !bVM) return -1
    if (!aVM && bVM) return 1
    return 0
  })

  let autoSelectedId = null

  sorted.forEach(d => {
    const rawLabel = d.label || `Device (${d.deviceId.slice(0, 6)}...)`
    const displayLabel = deviceDisplayLabel(rawLabel) || rawLabel

    const opt1 = new Option(displayLabel, d.deviceId)
    const opt2 = new Option(rawLabel, d.deviceId)
    discordSel.appendChild(opt1)
    monitorSel.appendChild(opt2)

    // Auto-select Voicemeeter AUX Input for Discord if nothing saved yet
    if (!autoSelectedId && isVoicemeeterInput(rawLabel)) {
      // Prefer AUX input, fall back to main input
      if (isVoicemeeterAux(rawLabel) || !autoSelectedId) {
        autoSelectedId = d.deviceId
      }
    }
  })

  // Show a hint if Voicemeeter devices were found
  const vmFound = outputs.some(d => isVoicemeeterInput(d.label || ''))
  const hint = document.getElementById('vm-hint')
  if (hint) hint.style.display = vmFound ? 'block' : 'none'

  return { autoSelectedId, vmFound }
}

// ── Sound Playback ────────────────────────────────────────────────
async function playSound(id) {
  const sound = sounds.find(s => s.id === id)
  if (!sound) return

  // Stop any currently playing instance of this sound
  stopSound(id)

  const vol = masterVolume / 100
  const active = {}

  async function makeAudio(deviceId) {
    const audio = new Audio()
    audio.src = sound.path
    audio.volume = vol
    if (deviceId) {
      try { await audio.setSinkId(deviceId) } catch (e) {}
    }
    return audio
  }

  // Play to Discord output
  if (discordOutputId) {
    const a = await makeAudio(discordOutputId)
    active.discord = a
    a.play().catch(() => {})
  }

  // Play to monitor output (if different from discord)
  if (monitorOutputId && monitorOutputId !== discordOutputId) {
    const a = await makeAudio(monitorOutputId)
    active.monitor = a
    a.play().catch(() => {})
  } else if (!discordOutputId && monitorOutputId) {
    const a = await makeAudio(monitorOutputId)
    active.discord = a
    a.play().catch(() => {})
  } else if (!discordOutputId && !monitorOutputId) {
    // fallback: default device
    const a = await makeAudio('')
    active.discord = a
    a.play().catch(() => {})
  }

  activeSounds.set(id, active)
  updateCardPlaying(id, true)
  setStatus(`Playing: ${sound.name}`, 'playing')

  // Cleanup on end
  const primaryAudio = active.discord || active.monitor
  if (primaryAudio) {
    primaryAudio.onended = () => {
      activeSounds.delete(id)
      updateCardPlaying(id, false)
      if (activeSounds.size === 0) setStatus('Ready', '')
    }
  }
}

function stopSound(id) {
  const active = activeSounds.get(id)
  if (!active) return
  if (active.discord) { active.discord.pause(); active.discord.currentTime = 0 }
  if (active.monitor) { active.monitor.pause(); active.monitor.currentTime = 0 }
  activeSounds.delete(id)
  updateCardPlaying(id, false)
}

function stopAll() {
  for (const [id] of activeSounds) stopSound(id)
  setStatus('Ready', '')
}

function updateCardPlaying(id, playing) {
  const card = document.querySelector(`.sound-card[data-id="${id}"]`)
  if (!card) return
  card.classList.toggle('playing', playing)
}

// ── Rendering ─────────────────────────────────────────────────────
function render() {
  const grid = document.getElementById('sound-grid')
  const empty = document.getElementById('empty-state')

  let filtered = sounds.filter(s => {
    const matchSearch = s.name.toLowerCase().includes(searchQuery.toLowerCase())
    const matchTag = activeTag === 'all' || (s.tags || []).includes(activeTag)
    return matchSearch && matchTag
  })

  grid.innerHTML = ''

  if (sounds.length === 0) {
    empty.classList.add('visible')
    grid.style.display = 'none'
    return
  }

  empty.classList.remove('visible')
  grid.style.display = 'grid'

  filtered.forEach(sound => {
    const card = document.createElement('div')
    card.className = 'sound-card'
    card.dataset.id = sound.id
    if (activeSounds.has(sound.id)) card.classList.add('playing')

    const hotkeyLabel = sound.hotkey
      ? `<span class="sound-hotkey">${sound.hotkey}</span>`
      : `<span class="sound-hotkey none">no key</span>`

    card.innerHTML = `
      <div class="sound-emoji">${sound.emoji || '🔊'}</div>
      <div class="sound-name" title="${sound.name}">${sound.name}</div>
      <div class="sound-meta">
        ${hotkeyLabel}
        <button class="sound-menu-btn" data-id="${sound.id}" title="Options">···</button>
      </div>
      <div class="playing-bar"></div>
    `

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('sound-menu-btn')) return
      if (activeSounds.has(sound.id)) stopSound(sound.id)
      else playSound(sound.id)
    })

    card.querySelector('.sound-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      showContextMenu(e, sound)
    })

    grid.appendChild(card)
  })
}

// ── Context Menu ──────────────────────────────────────────────────
function showContextMenu(e, sound) {
  removeContextMenu()

  contextMenuEl = document.createElement('div')
  contextMenuEl.className = 'context-menu'
  contextMenuEl.innerHTML = `
    <div class="ctx-item" data-action="rename">✎ &nbsp;Rename</div>
    <div class="ctx-item" data-action="emoji">◈ &nbsp;Change emoji</div>
    <div class="ctx-item" data-action="hotkey">⌨ &nbsp;Set hotkey</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" data-action="remove">✕ &nbsp;Remove</div>
  `

  document.body.appendChild(contextMenuEl)

  // Position
  let x = e.clientX, y = e.clientY
  const rect = contextMenuEl.getBoundingClientRect()
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 6
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 6
  contextMenuEl.style.left = x + 'px'
  contextMenuEl.style.top = y + 'px'

  contextMenuEl.addEventListener('click', (ev) => {
    const action = ev.target.closest('.ctx-item')?.dataset.action
    if (!action) return
    removeContextMenu()
    if (action === 'rename') openRenameModal(sound)
    if (action === 'emoji') cycleEmoji(sound.id)
    if (action === 'hotkey') openHotkeyModal(sound)
    if (action === 'remove') removeSound(sound.id)
  })

  setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 10)
}

function removeContextMenu() {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null }
}

// ── Add Sounds ────────────────────────────────────────────────────
async function addSounds() {
  const files = await ipcRenderer.invoke('pick-audio-files')
  for (const filePath of files) {
    const name = path.basename(filePath, path.extname(filePath))
    if (sounds.find(s => s.path === filePath)) continue
    sounds.push({
      id: Date.now() + Math.random().toString(36).slice(2),
      name,
      path: filePath,
      emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
      hotkey: null,
      tags: []
    })
  }
  saveState()
  render()
}

function removeSound(id) {
  stopSound(id)
  ipcRenderer.send('unregister-hotkey', sounds.find(s => s.id === id)?.hotkey)
  sounds = sounds.filter(s => s.id !== id)
  saveState()
  render()
}

function cycleEmoji(id) {
  const sound = sounds.find(s => s.id === id)
  if (!sound) return
  const idx = (EMOJIS.indexOf(sound.emoji) + 1) % EMOJIS.length
  sound.emoji = EMOJIS[idx]
  saveState()
  render()
}

// ── Rename Modal ──────────────────────────────────────────────────
function openRenameModal(sound) {
  pendingRenameId = sound.id
  document.getElementById('rename-input').value = sound.name
  document.getElementById('rename-modal').style.display = 'flex'
  setTimeout(() => document.getElementById('rename-input').focus(), 50)
}

function closeRenameModal() {
  document.getElementById('rename-modal').style.display = 'none'
  pendingRenameId = null
}

function saveRename() {
  const name = document.getElementById('rename-input').value.trim()
  if (!name || !pendingRenameId) return closeRenameModal()
  const sound = sounds.find(s => s.id === pendingRenameId)
  if (sound) sound.name = name
  saveState()
  render()
  closeRenameModal()
}

// ── Hotkey Modal ──────────────────────────────────────────────────
function openHotkeyModal(sound) {
  pendingHotkey = { id: sound.id, keys: null }
  document.getElementById('modal-sound-name').textContent = sound.name
  document.getElementById('hotkey-display').textContent = sound.hotkey || 'Press a key...'
  document.getElementById('hotkey-modal').style.display = 'flex'
  document.addEventListener('keydown', captureHotkey)
}

function closeHotkeyModal() {
  document.getElementById('hotkey-modal').style.display = 'none'
  document.removeEventListener('keydown', captureHotkey)
  pendingHotkey = null
}

function captureHotkey(e) {
  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape') {
    pendingHotkey.keys = null
    document.getElementById('hotkey-display').textContent = '— cleared —'
    return
  }

  const parts = []
  if (e.ctrlKey) parts.push('CommandOrControl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  const ignored = ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock']
  if (!ignored.includes(e.key)) {
    let key = e.key
    if (key.length === 1) key = key.toUpperCase()
    else {
      // Map special keys to Electron accelerator format
      const keyMap = {
        'F1':'F1','F2':'F2','F3':'F3','F4':'F4','F5':'F5','F6':'F6',
        'F7':'F7','F8':'F8','F9':'F9','F10':'F10','F11':'F11','F12':'F12',
        'ArrowLeft':'Left','ArrowRight':'Right','ArrowUp':'Up','ArrowDown':'Down',
        'Delete':'Delete','Backspace':'Backspace','Enter':'Return','Tab':'Tab',
        'Insert':'Insert','Home':'Home','End':'End','PageUp':'PageUp','PageDown':'PageDown'
      }
      key = keyMap[e.key] || e.key
    }
    parts.push(key)
  }

  const accelerator = parts.join('+')
  pendingHotkey.keys = accelerator
  document.getElementById('hotkey-display').textContent = accelerator
}

function saveHotkey() {
  if (!pendingHotkey) return closeHotkeyModal()

  const sound = sounds.find(s => s.id === pendingHotkey.id)
  if (!sound) return closeHotkeyModal()

  // Unregister old hotkey
  if (sound.hotkey) ipcRenderer.send('unregister-hotkey', sound.hotkey)

  sound.hotkey = pendingHotkey.keys || null

  if (sound.hotkey) {
    ipcRenderer.send('register-hotkey', { id: sound.id, accelerator: sound.hotkey })
  }

  saveState()
  render()
  closeHotkeyModal()
}

// ── IPC: hotkey triggered from main process ───────────────────────
ipcRenderer.on('hotkey-triggered', (_e, id) => {
  const sound = sounds.find(s => s.id === id)
  if (!sound) return
  if (activeSounds.has(id)) stopSound(id)
  else playSound(id)
})

// ── Status ────────────────────────────────────────────────────────
function setStatus(text, type) {
  document.getElementById('status-text').textContent = text
  const dot = document.getElementById('status-dot')
  dot.className = 'status-dot'
  if (type) dot.classList.add(type)
}

// ── Event Listeners ───────────────────────────────────────────────
document.getElementById('btn-add').addEventListener('click', addSounds)
document.getElementById('btn-add-empty').addEventListener('click', addSounds)
document.getElementById('btn-stop-all').addEventListener('click', stopAll)

document.getElementById('master-volume').addEventListener('input', function () {
  masterVolume = parseInt(this.value)
  document.getElementById('vol-display').textContent = masterVolume + '%'
  // Update volume on active sounds
  for (const [, active] of activeSounds) {
    if (active.discord) active.discord.volume = masterVolume / 100
    if (active.monitor) active.monitor.volume = masterVolume / 100
  }
  saveState()
})

document.getElementById('discord-out').addEventListener('change', function () {
  discordOutputId = this.value
  saveState()
})

document.getElementById('monitor-out').addEventListener('change', function () {
  monitorOutputId = this.value
  saveState()
})

document.getElementById('search').addEventListener('input', function () {
  searchQuery = this.value
  render()
})

// Window controls
document.getElementById('btn-minimize').addEventListener('click', () => ipcRenderer.send('window-minimize'))
document.getElementById('btn-maximize').addEventListener('click', () => ipcRenderer.send('window-maximize'))
document.getElementById('btn-close').addEventListener('click', () => ipcRenderer.send('window-close'))

// Hotkey modal
document.getElementById('modal-cancel').addEventListener('click', closeHotkeyModal)
document.getElementById('modal-save').addEventListener('click', saveHotkey)

// Rename modal
document.getElementById('rename-cancel').addEventListener('click', closeRenameModal)
document.getElementById('rename-save').addEventListener('click', saveRename)
document.getElementById('rename-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveRename()
  if (e.key === 'Escape') closeRenameModal()
})

// Prevent right-click context menu on non-card areas
document.addEventListener('contextmenu', e => e.preventDefault())

// ── MyInstants ────────────────────────────────────────────────────
function openMyInstantsModal() {
  document.getElementById('myinstants-url').value = ''
  setMyInstantsStatus('', '')
  document.getElementById('myinstants-modal').style.display = 'flex'
  setTimeout(() => document.getElementById('myinstants-url').focus(), 50)
}

function closeMyInstantsModal() {
  document.getElementById('myinstants-modal').style.display = 'none'
}

function setMyInstantsStatus(msg, type) {
  const el = document.getElementById('myinstants-status')
  if (!msg) { el.style.display = 'none'; return }
  el.style.display = 'block'
  el.textContent = msg
  el.className = 'myinstants-status ' + type
}

async function importFromMyInstants() {
  const url = document.getElementById('myinstants-url').value.trim()
  if (!url) return

  const importBtn = document.getElementById('myinstants-import')
  importBtn.disabled = true
  importBtn.textContent = 'Importing...'
  setMyInstantsStatus('Fetching sound...', 'loading')

  try {
    const result = await ipcRenderer.invoke('download-myinstants', url)
    sounds.push({
      id: Date.now() + Math.random().toString(36).slice(2),
      name: result.name,
      path: result.path,
      emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
      hotkey: null,
      tags: []
    })
    saveState()
    render()
    setMyInstantsStatus('✓ Added: ' + result.name, 'success')
    document.getElementById('myinstants-url').value = ''
    setTimeout(closeMyInstantsModal, 1200)
  } catch (err) {
    setMyInstantsStatus('✕ ' + (err.message || 'Import failed'), 'error')
  } finally {
    importBtn.disabled = false
    importBtn.textContent = 'Import'
  }
}

document.getElementById('btn-myinstants').addEventListener('click', openMyInstantsModal)
document.getElementById('myinstants-cancel').addEventListener('click', closeMyInstantsModal)
document.getElementById('myinstants-import').addEventListener('click', importFromMyInstants)
document.getElementById('myinstants-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') importFromMyInstants()
  if (e.key === 'Escape') closeMyInstantsModal()
})

// ── Start ─────────────────────────────────────────────────────────
init()
