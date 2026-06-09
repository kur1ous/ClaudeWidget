import { readFileSync, writeFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'
import { settingsPath } from './claudeHome'

// Marker that identifies *our* SessionStart hook so we can find/refresh/remove it
// without touching the user's other hooks. It rides in `start`'s window-title slot
// (harmless for a GUI app) and doubles as our detection token.
const MARKER = 'claude-activity-widget-autostart'
// New session + --continue/--resume/`/resume`.
const MATCHERS = ['startup', 'resume']

interface CommandHook {
  type: string
  command: string
  async?: boolean
  timeout?: number
}
interface HookGroup {
  matcher?: string
  hooks?: CommandHook[]
}
interface Settings {
  hooks?: { SessionStart?: HookGroup[]; [k: string]: unknown }
  [k: string]: unknown
}

/** Detached, instant-return launch so the (blocking) SessionStart hook never stalls. */
function launchCommand(exe: string): string {
  return `cmd /c start "${MARKER}" "${exe}"`
}

function ourEntries(exe: string): HookGroup[] {
  return MATCHERS.map((matcher) => ({
    matcher,
    hooks: [{ type: 'command', command: launchCommand(exe), async: true, timeout: 10 }]
  }))
}

function isOurs(g: HookGroup): boolean {
  return !!g.hooks?.some((h) => typeof h.command === 'string' && h.command.includes(MARKER))
}

function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

/** Write settings.json atomically (temp file + rename), preserving every other key. */
function writeSettings(settings: Settings): void {
  try {
    const path = settingsPath()
    const tmp = join(dirname(path), `.settings.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(settings, null, 2))
    renameSync(tmp, path)
  } catch {
    // best effort — never let a locked/odd settings file crash startup
  }
}

/** True if our SessionStart launch hook is currently present. */
export function isHookInstalled(): boolean {
  return (readSettings().hooks?.SessionStart ?? []).some(isOurs)
}

/**
 * Ensure exactly one up-to-date copy of our SessionStart hook exists. Idempotent and
 * safe to call on every launch — it strips any stale copies (e.g. old exe path) first.
 */
export function installHook(exe: string): void {
  const settings = readSettings()
  const hooks = (settings.hooks ??= {})
  const existing = (hooks.SessionStart ?? []).filter((g) => !isOurs(g))
  hooks.SessionStart = [...existing, ...ourEntries(exe)]
  writeSettings(settings)
}

/** Remove our SessionStart hook, cleaning up now-empty containers. */
export function uninstallHook(): void {
  const settings = readSettings()
  const groups = settings.hooks?.SessionStart
  if (!groups) return
  const kept = groups.filter((g) => !isOurs(g))
  if (kept.length === groups.length) return // nothing of ours to remove
  if (kept.length > 0) {
    settings.hooks!.SessionStart = kept
  } else {
    delete settings.hooks!.SessionStart
    if (Object.keys(settings.hooks!).length === 0) delete settings.hooks
  }
  writeSettings(settings)
}
