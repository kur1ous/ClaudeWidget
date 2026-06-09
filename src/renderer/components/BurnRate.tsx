import type { JSX } from 'react'
import type { BurnSnapshot } from '../../shared/types'

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

function fmtUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`
}

/** Ecosystem-standard burn tiers: ok < 2k, warm 2k–5k, hot > 5k tokens/min. */
function tier(tokensPerMin: number): string {
  if (tokensPerMin > 5000) return 'burn-tier-hot'
  if (tokensPerMin >= 2000) return 'burn-tier-warn'
  return 'burn-tier-ok'
}

export function BurnRate({ burn }: { burn: BurnSnapshot | null }): JSX.Element {
  if (!burn) return <section className="burn empty">—</section>
  return (
    <section className="burn">
      <div className="burn-stat">
        <span className={`burn-num ${tier(burn.tokensPerMin)}`}>{fmtTokens(burn.tokensPerMin)}</span>
        <span className="burn-cap">tok/min</span>
      </div>
      <div className="burn-stat">
        <span className="burn-num">{fmtUsd(burn.windowCostUsd)}</span>
        <span className="burn-cap">last {burn.windowMinutes}m (est)</span>
      </div>
    </section>
  )
}
