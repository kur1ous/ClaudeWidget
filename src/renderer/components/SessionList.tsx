import { useState, type JSX } from 'react'
import type { SessionInfo, SessionState } from '../../shared/types'

const STATE_META: Record<SessionState, { label: string; icon: string; cls: string }> = {
  planning: { label: 'Planning', icon: '✲', cls: 'st-plan' },
  thinking: { label: 'Thinking', icon: '✦', cls: 'st-think' },
  editing: { label: 'Editing', icon: '✎', cls: 'st-edit' },
  reading: { label: 'Reading', icon: '◉', cls: 'st-read' },
  searching: { label: 'Searching', icon: '⌕', cls: 'st-search' },
  running: { label: 'Running', icon: '❯', cls: 'st-run' },
  browsing: { label: 'Browsing', icon: '◍', cls: 'st-browse' },
  spawning: { label: 'Spawning', icon: '⛓', cls: 'st-spawn' },
  working: { label: 'Working', icon: '⚙', cls: 'st-work' },
  responding: { label: 'Responding', icon: '✍', cls: 'st-respond' },
  asking: { label: 'Needs you', icon: '❖', cls: 'st-ask' },
  awaiting: { label: 'Awaiting', icon: '⌯', cls: 'st-await' },
  idle: { label: 'Idle', icon: '○', cls: 'st-idle' },
  unknown: { label: '—', icon: '·', cls: 'st-idle' }
}

function shortModel(m: string | null): string {
  if (!m) return ''
  if (m.includes('opus')) return 'Opus'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('haiku')) return 'Haiku'
  return m
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

// Active = anything Claude is actually doing; idle/unknown get folded away.
const isActive = (s: SessionInfo): boolean => s.state !== 'idle' && s.state !== 'unknown'
// Sort active sessions attention-first (asking/awaiting), then most-recent.
const PRIORITY: Partial<Record<SessionState, number>> = { asking: 0, awaiting: 1 }
const prio = (s: SessionInfo): number => PRIORITY[s.state] ?? 2
const byPriority = (a: SessionInfo, b: SessionInfo): number =>
  prio(a) - prio(b) || b.lastActivity - a.lastActivity

function Row({ s }: { s: SessionInfo }): JSX.Element {
  const meta = STATE_META[s.state]
  const secondary = s.detail || shortModel(s.model)
  return (
    <li className="session" title={`${meta.label} · ${shortModel(s.model)} · ${s.cwd}`}>
      <span className={`badge ${meta.cls}`}>
        <span className="badge-icon">{meta.icon}</span>
        {meta.label}
      </span>
      <span className="session-project">{s.project}</span>
      {secondary && <span className="session-sub">· {secondary}</span>}
      {s.subAgents > 0 && <span className="subagents">+{s.subAgents}</span>}
      <span className="session-ago">{ago(s.lastActivity)}</span>
    </li>
  )
}

export function SessionList({ sessions }: { sessions: SessionInfo[] }): JSX.Element {
  const [idleOpen, setIdleOpen] = useState(false)
  if (sessions.length === 0) {
    return <section className="sessions empty">No Claude sessions running</section>
  }
  const activeS = sessions.filter(isActive).sort(byPriority)
  const idleS = sessions.filter((s) => !isActive(s)).sort((a, b) => b.lastActivity - a.lastActivity)
  return (
    <section className="sessions">
      <ul>
        {activeS.map((s) => (
          <Row key={s.sessionId} s={s} />
        ))}
        {idleS.length > 0 && (
          <li className="idle-summary" onClick={() => setIdleOpen((o) => !o)} title="Toggle idle sessions">
            <span className="st-icon st-idle">○</span>
            <span className="idle-count">{idleS.length} idle</span>
            <span className="idle-caret">{idleOpen ? '▴' : '▾'}</span>
            {!idleOpen && <span className="idle-names">{idleS.map((s) => s.project).join(', ')}</span>}
          </li>
        )}
        {idleOpen && idleS.map((s) => <Row key={s.sessionId} s={s} />)}
      </ul>
    </section>
  )
}
