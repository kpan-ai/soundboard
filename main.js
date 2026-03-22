const { app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')

let mainWindow

// Path to persist soundboard config
const configPath = path.join(app.getPath('userData'), 'soundboard-config.json')

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'))
    }
  } catch (e) {}
  return { sounds: [], discordOutputId: null, monitorOutputId: null, volume: 80 }
}

function saveConfig(config) {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 720,
    minHeight: 500,
    frame: false,
    transparent: false,
    backgroundColor: '#0f0f13',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // Allow loading local audio files
      webSecurity: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  })

  mainWindow.loadFile('index.html')

  mainWindow.on('closed', () => {
    globalShortcut.unregisterAll()
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  app.quit()
})

// ── IPC Handlers ──────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window-close', () => mainWindow?.close())

// Open file picker for audio files
ipcMain.handle('pick-audio-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Sounds',
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }],
    properties: ['openFile', 'multiSelections']
  })
  if (result.canceled) return []
  return result.filePaths
})

// Load config
ipcMain.handle('load-config', () => loadConfig())

// Save config
ipcMain.on('save-config', (_e, config) => saveConfig(config))

// Register a global hotkey for a sound
ipcMain.on('register-hotkey', (_e, { id, accelerator }) => {
  try {
    globalShortcut.register(accelerator, () => {
      mainWindow?.webContents.send('hotkey-triggered', id)
    })
  } catch (err) {}
})

// Unregister a hotkey
ipcMain.on('unregister-hotkey', (_e, accelerator) => {
  try {
    globalShortcut.unregister(accelerator)
  } catch (err) {}
})

// Unregister all hotkeys and re-register from config
ipcMain.on('reload-hotkeys', (_e, sounds) => {
  globalShortcut.unregisterAll()
  for (const sound of sounds) {
    if (sound.hotkey) {
      try {
        globalShortcut.register(sound.hotkey, () => {
          mainWindow?.webContents.send('hotkey-triggered', sound.id)
        })
      } catch (err) {}
    }
  }
})

// Download a sound from MyInstants
ipcMain.handle('download-myinstants', async (_e, url) => {
  const https = require('https')
  const http = require('http')
  const fs = require('fs')
  const path = require('path')

  return new Promise((resolve, reject) => {
    // Normalize URL
    url = url.trim().replace(/\/$/, '')

    // Make sure it's a myinstants URL
    if (!url.includes('myinstants.com')) {
      return reject(new Error('Not a MyInstants URL'))
    }

    // Fetch the page HTML to find the sound file URL
    const pageUrl = url.startsWith('http') ? url : 'https://' + url
    const client = pageUrl.startsWith('https') ? https : http

    const req = client.get(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return reject(new Error('Redirected — check the URL'))
      }
      let html = ''
      res.on('data', chunk => html += chunk)
      res.on('end', () => {
        // Extract sound name from page title
        const titleMatch = html.match(/<title>([^<]+)<\/title>/i)
        let soundName = titleMatch ? titleMatch[1].replace(/ - MyInstants.*$/i, '').trim() : 'Sound'

        // Find the MP3 url — MyInstants puts it in a button's data-url or an <source> tag
        let soundUrl = null

        const dataUrlMatch = html.match(/data-url="([^"]+\.mp3[^"]*)"/i)
          || html.match(/data-sound="([^"]+\.mp3[^"]*)"/i)
          || html.match(/<source[^>]+src="([^"]+\.mp3[^"]*)"/i)
          || html.match(/\/media\/sounds\/[^\s"']+\.mp3/i)

        if (dataUrlMatch) {
          soundUrl = dataUrlMatch[1] || dataUrlMatch[0]
          if (!soundUrl.startsWith('http')) {
            soundUrl = 'https://www.myinstants.com' + soundUrl
          }
        }

        if (!soundUrl) {
          return reject(new Error('Could not find sound on this page'))
        }

        // Make sure sounds folder exists
        const soundsDir = path.join(app.getPath('userData'), 'sounds')
        if (!fs.existsSync(soundsDir)) fs.mkdirSync(soundsDir, { recursive: true })

        const safeName = soundName.replace(/[^a-z0-9\-_ ]/gi, '').trim() || 'sound'
        const destPath = path.join(soundsDir, safeName + '.mp3')

        // Download the MP3
        const dlClient = soundUrl.startsWith('https') ? https : http
        const dlReq = dlClient.get(soundUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.myinstants.com/' } }, (dlRes) => {
          if (dlRes.statusCode !== 200) {
            return reject(new Error(`Download failed (${dlRes.statusCode})`))
          }
          const fileStream = fs.createWriteStream(destPath)
          dlRes.pipe(fileStream)
          fileStream.on('finish', () => {
            fileStream.close()
            resolve({ name: soundName, path: destPath })
          })
          fileStream.on('error', reject)
        })
        dlReq.on('error', reject)
        dlReq.end()
      })
    })
    req.on('error', reject)
    req.end()
  })
})
