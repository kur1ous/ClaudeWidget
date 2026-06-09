import type { SessionState } from '../shared/types'
import type { TranscriptEvent } from './transcriptReader'

// Map a tool name to the activity state it represents.
const TOOL_STATES: Array<[Set<string>, SessionState]> = [
  [new Set(['Agent', 'Task', 'Workflow']), 'spawning'],
  [new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']), 'editing'],
  [new Set(['Read', 'NotebookRead']), 'reading'],
  [new Set(['Grep', 'Glob', 'ToolSearch']), 'searching'],
  [new Set(['Bash', 'PowerShell']), 'running'],
  [new Set(['WebSearch', 'WebFetch']), 'browsing']
]
// Tools that mean the assistant has handed control back to the user.
const FEEDBACK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

function toolState(name: string): SessionState {
  for (const [names, state] of TOOL_STATES) if (names.has(name)) return state
  return 'working'
}

// What the user is being asked for by a blocking feedback tool.
function feedbackDetail(tool: string): string {
  return tool === 'ExitPlanMode' ? 'plan approval' : 'your answer'
}

export interface DerivedState {
  state: SessionState
  detail: string | null
  model: string | null
  subAgents: number
  lastActivity: number
}

/**
 * Derive what a session is doing from its session-registry status and the
 * tail of its transcript. `busy` comes from sessions/{pid}.json.
 */
export function deriveState(
  events: TranscriptEvent[],
  busy: boolean,
  updatedAt: number
): DerivedState {
  let model: string | null = null
  let subAgents = 0
  let lastActivity = updatedAt
  let permissionMode: string | null = null

  // Track latest model, permission mode, and unresolved sidechain (sub-agent) activity.
  for (const e of events) {
    if (e.message?.model) model = e.message.model
    if (e.type === 'permission-mode' && e.permissionMode) permissionMode = e.permissionMode
    if (e.timestamp) {
      const t = Date.parse(e.timestamp)
      if (!Number.isNaN(t)) lastActivity = Math.max(lastActivity, t)
    }
    if (e.isSidechain) subAgents++
  }

  const last = lastMeaningful(events)
  const lastTool = last?.type === 'assistant' ? lastToolUse(last) : null
  const done = (state: SessionState, detail: string | null, agents = subAgents): DerivedState => ({
    state,
    detail,
    model,
    subAgents: agents,
    lastActivity
  })

  // Not busy => the turn has ended. (Trust the `status` flag: Claude Code doesn't bump
  // `updatedAt` during a long turn, so a stale timestamp must NOT override busy — dead
  // sessions are already filtered out by isAlive(pid) in sessionMonitor.)
  if (!busy) {
    // A pending question / plan approval is a blocking prompt — it never goes
    // stale, so show it no matter how long the user takes to answer (no recency cut).
    if (lastTool && FEEDBACK_TOOLS.has(lastTool)) {
      return done('asking', feedbackDetail(lastTool), 0)
    }
    // Otherwise: recently ended => awaiting input; long since => plain idle.
    const recentlyEnded = Date.now() - lastActivity < 60_000
    if (recentlyEnded && last?.type === 'assistant' && !hasToolUse(last)) {
      return done('awaiting', 'your input', 0)
    }
    return done('idle', null, 0)
  }

  // --- busy ---------------------------------------------------------------

  // A pending question / plan approval (Claude is blocked on the user) wins over all.
  if (lastTool && FEEDBACK_TOOLS.has(lastTool)) {
    return done('asking', feedbackDetail(lastTool))
  }

  // A tool just returned (tool_results are written back as `user` events): Claude is
  // processing the result, not "thinking". Keep showing the in-flight tool's activity.
  if (last?.type === 'user' && hasToolResult(last)) {
    const tool = lastAssistantTool(events)
    if (tool) {
      const state = toolState(tool)
      if (state === 'spawning') {
        const detail = subAgents > 0 ? `${subAgents} sub-agent${subAgents > 1 ? 's' : ''}` : tool
        return done('spawning', detail)
      }
      if (permissionMode === 'plan') return done('planning', tool)
      return done(state, tool)
    }
    return done('working', null)
  }

  // A genuine fresh human turn (or empty transcript) => thinking.
  if (!last || last.type === 'user') {
    return done(permissionMode === 'plan' ? 'planning' : 'thinking', null)
  }

  if (last.type === 'assistant') {
    if (lastTool) {
      const state = toolState(lastTool)
      if (state === 'spawning') {
        const detail = subAgents > 0 ? `${subAgents} sub-agent${subAgents > 1 ? 's' : ''}` : lastTool
        return done('spawning', detail)
      }
      // In plan mode, research tools still read as "planning" (show the tool).
      if (permissionMode === 'plan') return done('planning', lastTool)
      return done(state, lastTool)
    }
    if (hasThinking(last)) {
      return done(permissionMode === 'plan' ? 'planning' : 'thinking', null)
    }
    return done('responding', null)
  }

  return done('unknown', null)
}

function lastMeaningful(events: TranscriptEvent[]): TranscriptEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type
    if (t === 'user' || t === 'assistant') return events[i]
  }
  return undefined
}

function contentBlocks(e: TranscriptEvent): Array<{ type?: string; name?: string }> {
  const c = e.message?.content
  return Array.isArray(c) ? c : []
}

function hasToolUse(e: TranscriptEvent): boolean {
  return contentBlocks(e).some((b) => b.type === 'tool_use')
}

function hasThinking(e: TranscriptEvent): boolean {
  return contentBlocks(e).some((b) => b.type === 'thinking')
}

function hasToolResult(e: TranscriptEvent): boolean {
  return contentBlocks(e).some((b) => b.type === 'tool_result')
}

// Scan backward for the tool the most recent assistant tool_use invoked.
function lastAssistantTool(events: TranscriptEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'assistant') {
      const t = lastToolUse(e)
      if (t) return t
    }
  }
  return null
}

function lastToolUse(e: TranscriptEvent): string | null {
  const tools = contentBlocks(e).filter((b) => b.type === 'tool_use')
  if (tools.length === 0) return null
  return tools[tools.length - 1].name || 'tool'
}
