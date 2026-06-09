import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  globalShortcut,
  Notification
} from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { SessionMonitor } from './sessionMonitor'
import { UsageProvider } from './usageProvider'
import { BurnRateTracker } from './burnRate'
import { CostAccumulator } from './costAccumulator'
import { installHook, uninstallHook, isHookInstalled } from './hookInstaller'
import {
  Channels,
  type SessionInfo,
  type SessionState,
  type UsageSnapshot,
  type UsageWindow,
  type BurnSnapshot,
  type CostSnapshot
} from '../shared/types'

let win: BrowserWindow | null = null
let tray: Tray | null = null

const sessions = new SessionMonitor()
const usage = new UsageProvider()
const burn = new BurnRateTracker()
const cost = new CostAccumulator()

let lastSessions: SessionInfo[] = []
let lastUsage: UsageSnapshot | null = null
let lastBurn: BurnSnapshot | null = null
let lastCost: CostSnapshot | null = null

/** Push the latest cached snapshots to the renderer (idempotent, safe to repeat). */
function replaySnapshots(): void {
  if (lastSessions.length) send<SessionInfo[]>(Channels.sessions, lastSessions)
  if (lastUsage) send<UsageSnapshot>(Channels.usage, lastUsage)
  if (lastBurn) send<BurnSnapshot>(Channels.burn, lastBurn)
  if (lastCost) send<CostSnapshot>(Channels.cost, lastCost)
}

const WIDTH = 320
const INITIAL_HEIGHT = 160 // small; the renderer reports its real content height
const MIN_H = 70
const MAX_H = 460

interface WidgetState {
  x?: number
  y?: number
  autoLaunch?: boolean
  /** notify when a session enters the blocking `asking` state (default on) */
  notifyAsking?: boolean
  /** notify when a session finishes a turn / goes idle (default on) */
  notifyDone?: boolean
  /** notify when a usage window crosses 90% or is projected to run out (default on) */
  notifyLimits?: boolean
}

type NotifyKey = 'notifyAsking' | 'notifyDone' | 'notifyLimits'

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadState(): WidgetState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as WidgetState
  } catch {
    return {}
  }
}

/** Read-modify-write the state file so position and prefs never clobber each other. */
function saveState(partial: WidgetState): void {
  try {
    writeFileSync(statePath(), JSON.stringify({ ...loadState(), ...partial }))
  } catch {
    // best effort
  }
}

function loadPosition(): { x: number; y: number } | null {
  const s = loadState()
  if (typeof s.x === 'number' && typeof s.y === 'number') return { x: s.x, y: s.y }
  return null
}

function savePosition(): void {
  if (!win) return
  const [x, y] = win.getPosition()
  saveState({ x, y })
}

/** Auto-launch defaults to on; the tray checkbox flips it. */
function autoLaunchEnabled(): boolean {
  return loadState().autoLaunch ?? true
}

function applyAutoLaunch(): void {
  // Only manage the hook for the installed app — a dev run's exe path is electron.exe.
  if (!app.isPackaged) return
  if (autoLaunchEnabled()) installHook(app.getPath('exe'))
  else uninstallHook()
}

function toggleAutoLaunch(): void {
  saveState({ autoLaunch: !autoLaunchEnabled() })
  applyAutoLaunch()
  refreshTray()
}

/** Each notification category defaults on; the tray checkboxes flip them. */
function notifyEnabled(key: NotifyKey): boolean {
  return loadState()[key] ?? true
}

function toggleNotify(key: NotifyKey): void {
  saveState({ [key]: !notifyEnabled(key) })
  refreshTray()
}

/** Show an OS notification (no-op if unsupported); clicking reveals the widget. */
function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    if (!win) createWindow()
    else {
      win.show()
      win.focus()
    }
  })
  n.show()
}

// --- proactive alert state (edge detection across snapshots) ----------------

/** last-seen state per live sessionId, to fire only on transitions */
const lastStates = new Map<string, SessionState>()
/** which {window}:{threshold} alerts already fired; re-armed when the window drops back */
const firedLimits = new Set<string>()
/** hysteresis: re-arm the 90% alert only after utilization falls back below this */
const LIMIT_REARM = 85

const DONE_STATES = new Set<SessionState>(['awaiting', 'idle'])

/** Notify on session transitions: → asking (needs you), or active → done. */
function checkSessionAlerts(next: SessionInfo[]): void {
  const live = new Set<string>()
  for (const s of next) {
    live.add(s.sessionId)
    const prev = lastStates.get(s.sessionId)
    lastStates.set(s.sessionId, s.state)
    if (prev === undefined || prev === s.state) continue
    if (s.state === 'asking' && notifyEnabled('notifyAsking')) {
      notify(`🟠 Needs ${s.detail ?? 'your input'}`, s.project)
    } else if (DONE_STATES.has(s.state) && !DONE_STATES.has(prev) && prev !== 'asking') {
      if (notifyEnabled('notifyDone')) notify('Claude finished', s.project)
    }
  }
  // Drop ended sessions so their ids don't leak (and can re-fire if restarted).
  for (const id of [...lastStates.keys()]) if (!live.has(id)) lastStates.delete(id)
}

/** Notify once when a usage window crosses 90% or is first projected to run out. */
function checkUsageAlerts(snap: UsageSnapshot): void {
  if (!notifyEnabled('notifyLimits')) return
  const windows: Array<[string, string, UsageWindow | null]> = [
    ['fiveHour', '5-hour', snap.fiveHour],
    ['sevenDay', 'Weekly', snap.sevenDay]
  ]
  for (const [key, label, win] of windows) {
    if (!win) continue
    // Re-arm on the values that define each crossing, not on resetsAt. The 5-hour
    // window is rolling, so its resetsAt drifts forward every poll — keying the
    // re-arm on that re-fired the 90% alert every 180s. A genuine window reset
    // instead drops utilization (and clears the projection), which is what we watch.
    if (win.utilization < LIMIT_REARM) firedLimits.delete(`${key}:90`)
    if (!win.projectedExhaustAt) firedLimits.delete(`${key}:eta`)
    if (win.utilization >= 90 && !firedLimits.has(`${key}:90`)) {
      firedLimits.add(`${key}:90`)
      const resets = win.resetsAt ? ` — resets in ${countdown(win.resetsAt)}` : ''
      notify(`${label} limit at ${win.utilization.toFixed(0)}%`, `Approaching your cap${resets}.`)
    }
    if (win.projectedExhaustAt && !firedLimits.has(`${key}:eta`)) {
      firedLimits.add(`${key}:eta`)
      notify(`${label} limit on track to run out`, `Projected full in ${countdown(win.projectedExhaustAt)}.`)
    }
  }
}

/** Compact "1h 4m" / "2d 3h" countdown to an ISO timestamp (mirrors the renderer). */
function countdown(iso: string): string {
  const ms = Date.parse(iso) - Date.now()
  if (Number.isNaN(ms) || ms <= 0) return 'soon'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay()
  const saved = loadPosition()
  win = new BrowserWindow({
    width: WIDTH,
    height: INITIAL_HEIGHT,
    useContentSize: true,
    x: saved?.x ?? workArea.x + workArea.width - WIDTH - 16,
    y: saved?.y ?? workArea.y + 16,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win?.show())
  // Re-hydrate on every (re)load, e.g. dev Ctrl+R, in case a push was missed.
  win.webContents.on('did-finish-load', replaySnapshots)
  win.on('moved', savePosition)
  win.on('closed', () => (win = null))
}

function trayIcon(): Electron.NativeImage {
  // Draw a 16x16 rounded accent square as a dependency-free tray icon.
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  const [r, g, b] = [218, 119, 86] // Anthropic terracotta
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < 2 || y < 2 || x > size - 3 || y > size - 3
      const i = (y * size + x) * 4
      buf[i] = r
      buf[i + 1] = g
      buf[i + 2] = b
      buf[i + 3] = edge ? 0 : 255
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

function createTray(): void {
  tray = new Tray(trayIcon())
  refreshTray()
  tray.on('click', toggleWindow)
}

function refreshTray(): void {
  if (!tray) return
  const active = lastSessions.filter((s) => s.state !== 'idle').length
  const week = lastUsage?.sevenDay?.utilization
  const parts = [`${lastSessions.length} session(s), ${active} active`]
  if (typeof week === 'number') parts.push(`weekly ${week.toFixed(0)}%`)
  tray.setToolTip(`Claude Activity — ${parts.join(' · ')}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: parts.join('  ·  '), enabled: false },
      { type: 'separator' },
      { label: 'Show / Hide', click: toggleWindow },
      { type: 'separator' },
      {
        label: 'Notify when a session needs me',
        type: 'checkbox',
        checked: notifyEnabled('notifyAsking'),
        click: () => toggleNotify('notifyAsking')
      },
      {
        label: 'Notify when a session finishes',
        type: 'checkbox',
        checked: notifyEnabled('notifyDone'),
        click: () => toggleNotify('notifyDone')
      },
      {
        label: 'Notify near usage limits',
        type: 'checkbox',
        checked: notifyEnabled('notifyLimits'),
        click: () => toggleNotify('notifyLimits')
      },
      { type: 'separator' },
      {
        label: 'Launch on Claude session',
        type: 'checkbox',
        checked: app.isPackaged ? isHookInstalled() : autoLaunchEnabled(),
        enabled: app.isPackaged,
        click: toggleAutoLaunch
      },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}

function toggleWindow(): void {
  if (!win) {
    createWindow()
    return
  }
  if (win.isVisible()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

function send<T>(channel: string, payload: T): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Resize the window's content area to the renderer-reported height (top anchored). */
function resizeWindowTo(height: number): void {
  if (!win || win.isDestroyed()) return
  const target = Math.round(Math.max(MIN_H, Math.min(MAX_H, height)))
  const [, current] = win.getContentSize()
  if (current === target) return
  win.setContentSize(WIDTH, target)
}

// Single instance: a 2nd launch (e.g. another Claude session firing the SessionStart
// hook) fails the lock and quits below; the running widget is left untouched.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  /* do nothing — leave the running widget exactly as it is */
})

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return // duplicate launch; primary owns the widget

  createWindow()
  createTray()
  applyAutoLaunch()

  sessions.onUpdate((s) => {
    checkSessionAlerts(s)
    lastSessions = s
    burn.setSessions(s)
    send<SessionInfo[]>(Channels.sessions, s)
    refreshTray()
  })
  usage.onUpdate((u) => {
    lastUsage = u
    checkUsageAlerts(u)
    cost.setWindows(u.fiveHour, u.sevenDay)
    send<UsageSnapshot>(Channels.usage, u)
    refreshTray()
  })
  burn.onUpdate((b) => {
    lastBurn = b
    send<BurnSnapshot>(Channels.burn, b)
  })
  cost.onUpdate((c) => {
    lastCost = c
    send<CostSnapshot>(Channels.cost, c)
  })

  // Replay latest state once the renderer has subscribed and asked for it.
  ipcMain.on('renderer:ready', replaySnapshots)

  // Renderer reports its live content height (e.g. during collapse animation).
  ipcMain.on('widget:resize', (_e, height: number) => resizeWindowTo(height))

  sessions.start()
  usage.start()
  burn.start()
  cost.start()

  // Global hotkey to show/hide the widget from anywhere.
  if (!globalShortcut.register('Alt+Shift+A', toggleWindow)) {
    console.warn('Could not register Alt+Shift+A (another app may own it)')
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Keep running in the tray; do not quit when the window closes.
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  void sessions.stop()
  usage.stop()
  burn.stop()
  cost.stop()
})
