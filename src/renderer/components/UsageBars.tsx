import type { JSX } from 'react'
import type { CostSnapshot, UsageSnapshot, UsageWindow } from '../../shared/types'

function fmtUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`
}

function Bar({
  label,
  win,
  accent,
  costUsd
}: {
  label: string
  win: UsageWindow | null | undefined
  accent: string
  costUsd: number | null | undefined
}): JSX.Element {
  const pct = win?.utilization ?? null
  const reset = win?.resetsAt ? countdown(win.resetsAt) : null
  // Projected to hit 100% before reset: warn while still below the red ≥90% line.
  const eta = win?.projectedExhaustAt ?? null
  const warn = eta != null && pct != null && pct < 90
  const fill = pct != null && pct >= 90 ? 'var(--danger)' : warn ? 'var(--warn)' : accent
  return (
    <div className="bar-row">
      <div className="bar-head">
        <span className="bar-label">{label}</span>
        {eta && <span className="bar-eta">⚠ full in {countdown(eta)}</span>}
        {reset && <span className="bar-reset">{reset}</span>}
        <span className="bar-val">{pct == null ? '—' : `${pct.toFixed(0)}%`}</span>
        {costUsd != null && <span className="bar-cost">{fmtUsd(costUsd)} est</span>}
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.min(100, pct ?? 0)}%`, background: fill }} />
      </div>
    </div>
  )
}

export function UsageBars({
  usage,
  cost
}: {
  usage: UsageSnapshot | null
  cost: CostSnapshot | null
}): JSX.Element {
  if (usage?.error && !usage.fiveHour) {
    return <div className="usage error">Usage unavailable: {usage.error}</div>
  }
  return (
    <section className="usage">
      <Bar
        label="5-hour"
        win={usage?.fiveHour}
        accent="var(--accent2)"
        costUsd={cost?.fiveHourCostUsd}
      />
      <Bar label="Weekly" win={usage?.sevenDay} accent="var(--accent)" costUsd={cost?.sevenDayCostUsd} />
    </section>
  )
}

function countdown(iso: string): string {
  const ms = Date.parse(iso) - Date.now()
  if (Number.isNaN(ms) || ms <= 0) return 'soon'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
