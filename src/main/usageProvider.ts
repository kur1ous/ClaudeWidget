import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { credentialsPath } from './claudeHome'
import type { UsageSnapshot, UsageWindow } from '../shared/types'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const BETA_HEADER = 'oauth-2025-04-20'
// Mirrors Claude Code's public OAuth client id used for token refresh.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const POLL_MS = 180_000 // documented safe interval; do not go lower
const CC_VERSION = process.env.CLAUDE_CODE_VERSION || '2.1.168'

interface OAuthCreds {
  accessToken: string
  refreshToken: string
  expiresAt: number // ms epoch
}

interface CredFile {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

type Listener = (snap: UsageSnapshot) => void

/** utilization samples kept per window for trend projection */
const HISTORY_MS = 30 * 60_000 // ~10 samples at the 180s cadence
const MIN_SAMPLES = 3
const SLOPE_EPS = 1e-9 // %/ms; below this the window isn't meaningfully rising

interface Sample {
  t: number // ms
  u: number // utilization 0..100
}

/** Keys of UsageSnapshot whose values are UsageWindow | null. */
type WindowKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet'

export class UsageProvider {
  private listeners = new Set<Listener>()
  private timer: NodeJS.Timeout | null = null
  private last: UsageSnapshot | null = null
  /** rolling utilization samples per window, for ETA-to-limit projection */
  private history = new Map<WindowKey, Sample[]>()
  /** resetsAt seen per window; a change means the window rolled over → drop history */
  private lastReset = new Map<WindowKey, string | null>()

  onUpdate(cb: Listener): () => void {
    this.listeners.add(cb)
    if (this.last) cb(this.last)
    return () => this.listeners.delete(cb)
  }

  private stopped = false

  start(): void {
    this.stopped = false
    void this.bootstrap()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * Get the first good snapshot quickly. The steady cadence is 180s, but if the
   * first poll fails (e.g. a momentarily stale token at launch) we retry after a
   * few seconds rather than leaving the bars empty for a full interval. Retries
   * stop as soon as we have a successful snapshot.
   */
  private async bootstrap(): Promise<void> {
    if (await this.poll()) return
    for (const delay of [5_000, 20_000]) {
      await sleep(delay)
      if (this.stopped || (this.last && !this.last.error)) return
      if (await this.poll()) return
    }
  }

  /** Returns true if a successful (error-free) snapshot was fetched. */
  private async poll(): Promise<boolean> {
    if (this.stopped) return false
    try {
      const token = await this.accessToken()
      const snap = await this.fetchUsage(token, /*allowRefresh*/ true)
      this.annotateProjections(snap)
      this.last = snap
      this.emit(snap)
      return true
    } catch (err) {
      const snap: UsageSnapshot = {
        ...(this.last ?? emptySnapshot()),
        fetchedAt: Date.now(),
        error: (err as Error).message
      }
      this.last = snap
      this.emit(snap)
      return false
    }
  }

  private async fetchUsage(token: string, allowRefresh: boolean): Promise<UsageSnapshot> {
    const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': BETA_HEADER,
        'User-Agent': `claude-code/${CC_VERSION}`,
        'Content-Type': 'application/json'
      }
    })
    if (res.status === 401 && allowRefresh) {
      const refreshed = await this.refresh()
      return this.fetchUsage(refreshed, false)
    }
    if (!res.ok) {
      throw new Error(`usage ${res.status}: ${(await res.text()).slice(0, 120)}`)
    }
    return parseUsage(await res.json())
  }

  // --- token handling -------------------------------------------------------

  private async readCreds(): Promise<OAuthCreds> {
    const raw = JSON.parse(await fs.readFile(credentialsPath(), 'utf8')) as CredFile
    const o = raw.claudeAiOauth
    if (!o?.accessToken || !o.refreshToken) {
      throw new Error('no OAuth credentials found (.credentials.json)')
    }
    return {
      accessToken: o.accessToken,
      refreshToken: o.refreshToken,
      expiresAt: o.expiresAt ?? 0
    }
  }

  private async accessToken(): Promise<string> {
    const creds = await this.readCreds()
    if (creds.expiresAt && creds.expiresAt - Date.now() < 60_000) {
      return this.refresh()
    }
    return creds.accessToken
  }

  private async refresh(): Promise<string> {
    const creds = await this.readCreds()
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID
      })
    })
    if (!res.ok) {
      throw new Error(`token refresh ${res.status}`)
    }
    const data = (await res.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }
    await this.persist({
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
    })
    return data.access_token
  }

  /** Write the refreshed token back atomically, preserving other fields. */
  private async persist(next: OAuthCreds): Promise<void> {
    const path = credentialsPath()
    let existing: CredFile = {}
    try {
      existing = JSON.parse(await fs.readFile(path, 'utf8'))
    } catch {
      // start fresh if unreadable
    }
    const merged: CredFile = {
      ...existing,
      claudeAiOauth: {
        ...existing.claudeAiOauth,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: next.expiresAt
      }
    }
    const tmp = join(dirname(path), `.credentials.${process.pid}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 })
    await fs.rename(tmp, path)
  }

  private emit(snap: UsageSnapshot): void {
    for (const cb of this.listeners) cb(snap)
  }

  /**
   * For each rate-limit window, trend its utilization and set `projectedExhaustAt`
   * when the recent slope puts it at 100% *before* the window resets. We trend the
   * utilization signal directly (rather than mapping tokens→%) because the endpoint
   * gives no unit for the underlying limit. Mutates the windows on `snap` in place.
   */
  private annotateProjections(snap: UsageSnapshot): void {
    const keys: WindowKey[] = ['fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDaySonnet']
    for (const key of keys) {
      const win = snap[key]
      if (!win) continue
      // A new window (resetsAt changed) invalidates the old slope — start fresh.
      if (this.lastReset.get(key) !== win.resetsAt) {
        this.history.set(key, [])
        this.lastReset.set(key, win.resetsAt)
      }
      const hist = this.history.get(key) ?? []
      hist.push({ t: snap.fetchedAt, u: win.utilization })
      const cutoff = snap.fetchedAt - HISTORY_MS
      const trimmed = hist.filter((s) => s.t >= cutoff)
      this.history.set(key, trimmed)
      win.projectedExhaustAt = project(trimmed, win.utilization, win.resetsAt, snap.fetchedAt)
    }
  }
}

/**
 * Least-squares slope of utilization over time; extrapolate to 100%. Returns the
 * projected ISO timestamp only when it's a meaningful rise that lands before reset.
 */
function project(samples: Sample[], util: number, resetsAt: string | null, now: number): string | null {
  if (util >= 100 || samples.length < MIN_SAMPLES) return null
  const n = samples.length
  let st = 0
  let su = 0
  let stt = 0
  let stu = 0
  for (const s of samples) {
    st += s.t
    su += s.u
    stt += s.t * s.t
    stu += s.t * s.u
  }
  const denom = n * stt - st * st
  if (denom === 0) return null
  const slope = (n * stu - st * su) / denom // %/ms
  if (slope <= SLOPE_EPS) return null
  const eta = now + (100 - util) / slope
  if (resetsAt) {
    const reset = Date.parse(resetsAt)
    if (!Number.isNaN(reset) && eta >= reset) return null // resets before we'd run out
  }
  return new Date(eta).toISOString()
}

function parseWindow(w: unknown): UsageWindow | null {
  if (!w || typeof w !== 'object') return null
  const o = w as { utilization?: number; resets_at?: string }
  if (typeof o.utilization !== 'number') return null
  return { utilization: o.utilization, resetsAt: o.resets_at ?? null }
}

function parseUsage(json: unknown): UsageSnapshot {
  const o = (json ?? {}) as Record<string, unknown>
  const extra = (o.extra_usage ?? null) as {
    is_enabled?: boolean
    utilization?: number | null
    monthly_limit?: number | null
    used_credits?: number | null
  } | null
  return {
    fiveHour: parseWindow(o.five_hour),
    sevenDay: parseWindow(o.seven_day),
    sevenDayOpus: parseWindow(o.seven_day_opus),
    sevenDaySonnet: parseWindow(o.seven_day_sonnet),
    monthly: extra
      ? {
          enabled: !!extra.is_enabled,
          utilization: extra.utilization ?? null,
          monthlyLimit: extra.monthly_limit ?? null,
          usedCredits: extra.used_credits ?? null
        }
      : null,
    fetchedAt: Date.now(),
    error: null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function emptySnapshot(): UsageSnapshot {
  return {
    fiveHour: null,
    sevenDay: null,
    sevenDayOpus: null,
    sevenDaySonnet: null,
    monthly: null,
    fetchedAt: 0,
    error: null
  }
}
