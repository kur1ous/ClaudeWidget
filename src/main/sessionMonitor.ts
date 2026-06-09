import { promises as fs } from 'fs'
import { join, basename } from 'path'
import chokidar, { type FSWatcher } from 'chokidar'
import { sessionsDir } from './claudeHome'
import { findTranscript, tailEvents, type TranscriptEvent } from './transcriptReader'
import { deriveState } from './stateDeriver'
import type { SessionInfo } from '../shared/types'

interface RawSession {
  pid: number
  sessionId: string
  cwd: string
  status?: string
  startedAt: number
  updatedAt?: number
}

type Listener = (sessions: SessionInfo[]) => void

export class SessionMonitor {
  private watcher: FSWatcher | null = null
  private listeners = new Set<Listener>()
  private timer: NodeJS.Timeout | null = null

  onUpdate(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  start(): void {
    const dir = sessionsDir()
    // Watch the registry; any change triggers a rebuild (debounced via refresh).
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: false,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    const trigger = () => void this.refresh()
    this.watcher.on('add', trigger).on('change', trigger).on('unlink', trigger)
    // Poll as a fallback so state changes (busy->idle) surface even when the
    // registry file mtime doesn't visibly change.
    this.timer = setInterval(() => void this.refresh(), 2000)
    void this.refresh()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.watcher?.close()
    this.watcher = null
  }

  async refresh(): Promise<void> {
    const dir = sessionsDir()
    let files: string[]
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      this.emit([])
      return
    }

    const sessions = await Promise.all(
      files.map(async (f) => {
        try {
          const raw = JSON.parse(await fs.readFile(join(dir, f), 'utf8')) as RawSession
          if (!isAlive(raw.pid)) return null
          return await this.build(raw)
        } catch {
          return null
        }
      })
    )

    this.emit(sessions.filter((s): s is SessionInfo => s !== null).sort((a, b) => a.startedAt - b.startedAt))
  }

  private async build(raw: RawSession): Promise<SessionInfo> {
    const transcript = await findTranscript(raw.sessionId)
    const events = transcript ? await tailEvents(transcript) : []
    // CLI sessions carry a `status` flag; claude-desktop sessions don't — for those,
    // infer busy-ness from how recently the transcript was appended to.
    const busy = typeof raw.status === 'string' ? raw.status === 'busy' : inferBusy(events)
    const d = deriveState(events, busy, raw.updatedAt ?? 0)
    return {
      pid: raw.pid,
      sessionId: raw.sessionId,
      cwd: raw.cwd,
      project: basename(raw.cwd) || raw.cwd,
      model: d.model,
      state: d.state,
      detail: d.detail,
      subAgents: d.subAgents,
      startedAt: raw.startedAt,
      updatedAt: raw.updatedAt ?? d.lastActivity,
      lastActivity: d.lastActivity
    }
  }

  private emit(sessions: SessionInfo[]): void {
    for (const cb of this.listeners) cb(sessions)
  }
}

const ACTIVE_WINDOW_MS = 15_000 // tune if state flickers during long model think-gaps

/**
 * Infer busy-ness for sessions whose registry has no `status` field (claude-desktop):
 * a Claude Code turn appends transcript events while working and goes quiet when it hands
 * control back, so a recently-touched transcript means the session is active.
 */
function inferBusy(events: TranscriptEvent[]): boolean {
  let newest = 0
  for (const e of events) {
    if (!e.timestamp) continue
    const t = Date.parse(e.timestamp)
    if (!Number.isNaN(t)) newest = Math.max(newest, t)
  }
  return newest > 0 && Date.now() - newest < ACTIVE_WINDOW_MS
}

/** True if a process with this pid exists. */
function isAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but we can't signal it -> still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
