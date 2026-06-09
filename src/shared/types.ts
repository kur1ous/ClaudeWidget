// Types shared between the Electron main process and the renderer.

export type SessionState =
  | 'planning'
  | 'thinking'
  | 'editing'
  | 'reading'
  | 'searching'
  | 'running'
  | 'browsing'
  | 'spawning'
  | 'working'
  | 'responding'
  | 'asking'
  | 'awaiting'
  | 'idle'
  | 'unknown'

export interface SessionInfo {
  pid: number
  sessionId: string
  cwd: string
  /** basename of cwd, for display */
  project: string
  /** model id from the latest assistant message, if known */
  model: string | null
  state: SessionState
  /** human label of what it's doing, e.g. tool name or "Bash" */
  detail: string | null
  /** number of active sub-agents (sidechains) */
  subAgents: number
  startedAt: number
  updatedAt: number
  /** ms timestamp of the most recent transcript event */
  lastActivity: number
}

export interface UsageWindow {
  utilization: number // 0..100
  resetsAt: string | null // ISO 8601
  /** projected ISO time utilization reaches 100% at the recent trend, only if before resetsAt */
  projectedExhaustAt?: string | null
}

export interface UsageSnapshot {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  sevenDayOpus: UsageWindow | null
  sevenDaySonnet: UsageWindow | null
  monthly: {
    enabled: boolean
    utilization: number | null
    monthlyLimit: number | null
    usedCredits: number | null
  } | null
  /** ms timestamp of when this snapshot was fetched */
  fetchedAt: number
  /** present when the last fetch failed */
  error: string | null
}

export interface ModelBurn {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  estCostUsd: number
}

export interface BurnSnapshot {
  /** tokens per minute over the rolling window (input+output) */
  tokensPerMin: number
  /** total est. cost over the rolling window */
  windowCostUsd: number
  perModel: ModelBurn[]
  windowMinutes: number
}

/**
 * Estimated equivalent cost over the same windows the usage bars show, summed
 * across *all* transcripts (live + ended). Aligned to the live `resetsAt`
 * boundaries so each figure sits next to the utilization bar it corresponds to.
 */
export interface CostSnapshot {
  /** est. cost since the current 5-hour window started */
  fiveHourCostUsd: number
  /** est. cost since the current 7-day window started */
  sevenDayCostUsd: number
  /** per-model breakdown over the 7-day window */
  perModel?: ModelBurn[]
  /** ms timestamp of when this snapshot was computed */
  computedAt: number
}

// IPC channel names (main -> renderer push).
export const Channels = {
  sessions: 'sessions:update',
  usage: 'usage:update',
  burn: 'burn:update',
  cost: 'cost:update'
} as const

export interface WidgetApi {
  onSessions: (cb: (s: SessionInfo[]) => void) => () => void
  onUsage: (cb: (u: UsageSnapshot) => void) => () => void
  onBurn: (cb: (b: BurnSnapshot) => void) => () => void
  onCost: (cb: (c: CostSnapshot) => void) => () => void
  /** Tell main the renderer has subscribed and wants the latest snapshots replayed. */
  ready: () => void
  /** Ask main to resize the window to the given content height (px). */
  resize: (height: number) => void
}
