import { app, BrowserWindow, components, session, ipcMain, screen } from 'electron'
import path from 'node:path'
import http from 'node:http'
import dns from 'node:dns'
import { readFileSync, existsSync, appendFileSync } from 'node:fs'

// Prefer IPv4: the Steam runtime / gamescope network namespace often has broken IPv6, so Node's default
// "try IPv6 first" makes every auth/profiles/home request stall on a timeout -> minute-long launches.
dns.setDefaultResultOrder('ipv4first')
import { registerIpc } from './ipc.js'
import { initUpdater } from './updater.js'
import { killTreeAndExit } from './lifecycle.js'
import { CR } from './cr/client.js'
import { rewriteRendererRequestHeaders } from './cr/requestHeaders.js'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// Boot timing — surfaces where launch time goes (Steam reports ~1min sometimes). T0 ≈ main start.
const T0 = Date.now()
const boot = (stage: string) => console.log(`[boot] ${stage} +${Date.now() - T0}ms`)

// Gaming Mode runs under gamescope; Desktop Mode is plain KDE Wayland. Detect it once — the two fixes
// below are needed ONLY under gamescope and actively BREAK the Desktop launch (blank window).
const onGamescope = !!(
  process.env.GAMESCOPE_WAYLAND_DISPLAY ||
  /gamescope/i.test(process.env.XDG_CURRENT_DESKTOP ?? '') ||
  /gamescope/i.test(process.env.XDG_SESSION_DESKTOP ?? '')
)

// Capture Chromium/GPU-process failures too. These can occur before the JS logger is installed and are
// otherwise invisible when Steam starts the packaged app without a terminal.
app.commandLine.appendSwitch('enable-logging', 'file')

// Steam Gaming Mode is an XWayland client inside gamescope. Electron 38+ may auto-select native Wayland,
// which is a materially different compositor path from Desktop Mode and can produce a black window or
// renderer exit. Keep Gaming Mode on the mature XWayland path and retain the gamescope-only sandbox
// workaround; Desktop Mode keeps Electron's automatic platform selection and normal sandbox.
if (onGamescope) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('ozone-platform', 'x11')
}

// Keep the normal accelerated compositor under gamescope. Disabling it changes video/compositing behavior
// and has caused black windows on Deck-class systems. CR_NO_GPU remains an explicit recovery switch, while
// CR_GL=<gl|gles|vulkan> lets diagnostics select a specific ANGLE backend. Must run before app ready.
function tuneGpuForGamescope() {
  const env = process.env
  if (env.CR_GL) {
    app.commandLine.appendSwitch('use-gl', 'angle')
    app.commandLine.appendSwitch('use-angle', env.CR_GL) // experiment with a real backend (e.g. vulkan)
    app.commandLine.appendSwitch('disable-gpu-sandbox')
  } else if (env.CR_NO_GPU) {
    app.disableHardwareAcceleration()
  }
}
tuneGpuForGamescope()

// Dynamically scale the UI based on current screen resolution relative to the 800p baseline.
// Tunable via CR_UI_SCALE environment variable for manual overrides.
function calculateUiScale(win?: BrowserWindow): number {
  const envScale = Number(process.env.CR_UI_SCALE)
  if (Number.isFinite(envScale) && envScale > 0) return envScale

    try {
      const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
      const { height } = display.bounds
      // Baseline ratio: 800p baseline -> scale 1.5. Scales linearly with screen height.
      const calculatedScale = (height / 800) * 1.5
      return Math.max(1.0, Math.min(Number(calculatedScale.toFixed(2)), 4.0))
    } catch {
      return 1.5 // Safe fallback before screen module is initialized
    }
}

// Mirror console output to a file so the packaged (windowed, no-stdout) app is debuggable.
function installFileLogger() {
  try {
    const logPath = path.join(app.getPath('userData'), 'app.log')
    const orig = console.log.bind(console)
    const write = (...a: any[]) => {
      orig(...a)
      try {
        appendFileSync(logPath, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n')
      } catch {
        /* ignore */
      }
    }
    console.log = write
    console.error = write
  } catch {
    /* ignore */
  }
}

// Serve the built SvelteKit SPA over localhost.
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}

const STABLE_PORT = 43547
let staticServer: import('node:http').Server | null = null

function serveStatic(dir: string): Promise<number> {
  const server = http.createServer((req, res) => {
    let pathname = '/'
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
  } catch {
    /* default */
  }
  let file = path.join(dir, pathname)
  if (!existsSync(file) || pathname === '/') file = path.join(dir, 'index.html')
    if (!existsSync(file)) file = path.join(dir, 'index.html')
      try {
        const data = readFileSync(file)
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
  })
  staticServer = server
  return new Promise((resolve) => {
    const onUp = () => resolve((server.address() as { port: number }).port)
    server.once('error', (e: NodeJS.ErrnoException) => {
      console.log('[serve] fixed port unavailable:', e.code, '— using a random port (settings may reset this run)')
      server.listen(0, '127.0.0.1', onUp)
    })
    server.listen(STABLE_PORT, '127.0.0.1', onUp)
  })
}

function installMediaHeaderRules() {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.crunchyrollcdn.com/*',
        '*://*.gccrunchyroll.com/*',
        '*://*.vrv.co/*',
        '*://*.akamaized.net/*',
        '*://*.crunchyrollsvc.com/*',
        '*://*.crunchyroll.com/*'
      ]
    },
    (details, cb) => {
      cb({ requestHeaders: rewriteRendererRequestHeaders(details.url, details.requestHeaders) })
    }
  )
  session.defaultSession.webRequest.onSendHeaders({ urls: ['*://*.crunchyrollsvc.com/*'] }, (details) => {
    if (!details.url.includes('license')) return
      const hs = Object.entries(details.requestHeaders)
      .map(([k, v]) => `${k}=${String(v).slice(0, 28)}`)
      .join(' | ')
      console.log('[lic-req]', details.method, hs)
  })
}

function createWindow(loadUrl: string) {
  // Dynamically match current display resolution instead of hardcoded 1280x800
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.bounds

  const win = new BrowserWindow({
    width,
    height,
    title: 'Crunchy Deck',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    fullscreen: !onGamescope,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
                                contextIsolation: true,
                                nodeIntegration: false,
                                webSecurity: false
    }
  })

  const applyZoom = () => {
    if (!win.isDestroyed()) {
      win.webContents.setZoomFactor(calculateUiScale(win))
    }
  }

  win.webContents.setUserAgent(CR.UA)
  win.on('page-title-updated', (e) => e.preventDefault())

  // Scale UI according to resolution on page load
  win.webContents.on('did-finish-load', () => {
    boot('did-finish-load')
    win.webContents.setVisualZoomLevelLimits(1, 1)
    applyZoom()
  })

  // Recalculate zoom on window resize or move (e.g. when docking/undocking SteamOS)
  win.on('resize', applyZoom)
  win.on('move', applyZoom)

  win.webContents.on('did-start-loading', () => boot('did-start-loading'))
  win.webContents.on('dom-ready', () => boot('dom-ready'))
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) =>
  console.log('[did-fail-load]', code, desc, url, 'main=' + isMainFrame)
  )
  win.webContents.on('render-process-gone', (_e, d) => console.log('[render-gone]', JSON.stringify(d)))
  win.webContents.on('unresponsive', () => console.log('[unresponsive]'))
  win.webContents.on('console-message', (_e, level, message, line, sourceId) =>
  console.log('[rconsole]', level, (sourceId || '') + ':' + line, String(message).slice(0, 280))
  )
  win.loadURL(loadUrl).catch((err) => console.log('[loadURL] rejected', String(err)))
  return win
}

app.whenReady().then(async () => {
  installFileLogger()
  boot('app-ready')

  // Listen for screen resolution changes (e.g., plugging into 1080p/4K TVs in SteamOS Gaming Mode)
  screen.on('display-metrics-changed', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.setZoomFactor(calculateUiScale(win))
      }
    }
  })

  app.on('child-process-gone', (_e, d) => console.log('[child-gone]', JSON.stringify(d)))

  const e = process.env
  console.log(
    '[env]',
    JSON.stringify({
      sessionType: e.XDG_SESSION_TYPE,
      desktop: e.XDG_CURRENT_DESKTOP,
      sessionDesktop: e.XDG_SESSION_DESKTOP,
      gamescope: e.GAMESCOPE_WAYLAND_DISPLAY,
      wayland: e.WAYLAND_DISPLAY,
      display: e.DISPLAY,
      steam: !!(e.SteamEnv || e.SteamGameId || e.SteamAppId),
                   ozone: app.commandLine.getSwitchValue('ozone-platform') || '(auto)',
                   angle: app.commandLine.getSwitchValue('use-angle') || '(default)',
                   hardwareAcceleration: app.isHardwareAccelerationEnabled()
    })
  )
  app
  .getGPUInfo('basic')
  .then((i) => {
    console.log('[gpu]', JSON.stringify(i))
    console.log('[gpu-features]', JSON.stringify(app.getGPUFeatureStatus()))
  })
  .catch((err) => console.log('[gpu] info error', String(err)))

  try {
    await components.whenReady()
    console.log('[cdm] components ready:', components.status())
  } catch (err) {
    console.error('[cdm] init error:', err)
  }
  boot('components-ready')
  installMediaHeaderRules()
  registerIpc()
  const url = isDev
  ? process.env.ELECTRON_RENDERER_URL!
  : `http://127.0.0.1:${await serveStatic(path.join(__dirname, '../build'))}/`
  boot('served')
  let win = createWindow(url)
  boot('window-created')
  initUpdater(win)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow(url)
  })
}).catch((err) => {
  console.error('[boot-fatal]', err)
  app.exit(1)
})

function doQuit(reason: string) {
  try {
    staticServer?.close()
  } catch {
    /* ignore */
  }
  try {
    ipcMain.removeAllListeners()
  } catch {
    /* ignore */
  }
  killTreeAndExit(reason)
}
ipcMain.on('app:quit', () => doQuit('ipc'))
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') doQuit('window-all-closed')
})
process.on('SIGTERM', () => doQuit('sigterm'))
process.on('SIGINT', () => doQuit('sigint'))
