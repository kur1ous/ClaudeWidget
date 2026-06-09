import { useEffect, useRef, useState, type JSX } from 'react'
import type { SessionInfo, UsageSnapshot, BurnSnapshot, CostSnapshot } from '../shared/types'
import { UsageBars } from './components/UsageBars'
import { SessionList } from './components/SessionList'
import { BurnRate } from './components/BurnRate'
import { Sparkle } from './components/Sparkle'

export function App(): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [burn, setBurn] = useState<BurnSnapshot | null>(null)
  const [cost, setCost] = useState<CostSnapshot | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offs = [
      window.widget.onSessions(setSessions),
      window.widget.onUsage(setUsage),
      window.widget.onBurn(setBurn),
      window.widget.onCost(setCost)
    ]
    // Now that subscribers are registered, ask main to replay the latest snapshots.
    window.widget.ready()
    return () => offs.forEach((off) => off())
  }, [])

  // Report the live content height to main so the window hugs the content and
  // follows the collapse animation frame-by-frame (throttled to one rAF).
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let frame = 0
    const report = (): void => {
      frame = 0
      window.widget.resize(Math.ceil(el.getBoundingClientRect().height))
    }
    const ro = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(report)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  const active = sessions.filter((s) => s.state !== 'idle' && s.state !== 'unknown').length

  return (
    <div ref={rootRef} className={`widget ${collapsed ? 'collapsed' : ''}`}>
      <header className="titlebar">
        <span className="title">
          <Sparkle active={active > 0} /> Claude Activity
        </span>
        <span className="counts">
          {active}/{sessions.length} active
        </span>
        <button
          className="collapse"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▾' : '▴'}
        </button>
      </header>

      <UsageBars usage={usage} cost={cost} />

      <div className="collapsible">
        <div className="inner">
          <SessionList sessions={sessions} />
          <BurnRate burn={burn} />
        </div>
      </div>
    </div>
  )
}
