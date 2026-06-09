import { promises as fs } from 'fs'
import { findTranscript } from './transcriptReader'
import { estimateCost } from './pricing'
import type { BurnSnapshot, ModelBurn, SessionInfo } from '../shared/types'

const WINDOW_MS = 5 * 60_000
const SCAN_BYTES = 512 * 1024 // larger tail than state detection, for token sums

interface UsageRow {
  ts: number
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

type Listener = (snap: BurnSnapshot) => void

export class BurnRateTracker {
  private listeners = new Set<Listener>()
  private timer: NodeJS.Timeout | null = null
  private sessions: SessionInfo[] = []

  onUpdate(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  setSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions
  }

  start(): void {
    this.timer = setInterval(() => void this.compute(), 5000)
    void this.compute()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private async compute(): Promise<void> {
    const now = Date.now()
    const rows: UsageRow[] = []
    for (const s of this.sessions) {
      const file = await findTranscript(s.sessionId)
      if (!file) continue
      rows.push(...(await scanUsage(file, s.model)))
    }

    const windowRows = rows.filter((r) => now - r.ts <= WINDOW_MS)
    const byModelWindow = aggregate(windowRows)

    const windowTokens = windowRows.reduce((n, r) => n + r.input + r.output, 0)
    const tokensPerMin = windowTokens / (WINDOW_MS / 60_000)
    const windowCost = sumCost(byModelWindow)

    this.emit({
      tokensPerMin: Math.round(tokensPerMin),
      windowCostUsd: round4(windowCost),
      perModel: byModelWindow,
      windowMinutes: WINDOW_MS / 60_000
    })
  }

  private emit(snap: BurnSnapshot): void {
    for (const cb of this.listeners) cb(snap)
  }
}

async function scanUsage(file: string, fallbackModel: string | null): Promise<UsageRow[]> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(file, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - SCAN_BYTES)
    const buf = Buffer.alloc(size - start)
    await handle.read(buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    const rows: UsageRow[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        const u = e?.message?.usage
        if (!u || e.type !== 'assistant') continue
        const ts = e.timestamp ? Date.parse(e.timestamp) : NaN
        if (Number.isNaN(ts)) continue
        rows.push({
          ts,
          model: e.message.model || fallbackModel || 'unknown',
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cache_read_input_tokens),
          cacheCreation: num(u.cache_creation_input_tokens)
        })
      } catch {
        // ignore
      }
    }
    return rows
  } catch {
    return []
  } finally {
    await handle?.close()
  }
}

function aggregate(rows: UsageRow[]): ModelBurn[] {
  const map = new Map<string, ModelBurn>()
  for (const r of rows) {
    let m = map.get(r.model)
    if (!m) {
      m = {
        model: r.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estCostUsd: 0
      }
      map.set(r.model, m)
    }
    m.inputTokens += r.input
    m.outputTokens += r.output
    m.cacheReadTokens += r.cacheRead
    m.cacheCreationTokens += r.cacheCreation
  }
  for (const m of map.values()) {
    m.estCostUsd = round4(
      estimateCost(m.model, m.inputTokens, m.outputTokens, m.cacheCreationTokens, m.cacheReadTokens)
    )
  }
  return [...map.values()].sort((a, b) => b.estCostUsd - a.estCostUsd)
}

function sumCost(models: ModelBurn[]): number {
  return models.reduce((n, m) => n + m.estCostUsd, 0)
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const round4 = (n: number): number => Math.round(n * 10000) / 10000
