import { promises as fs } from 'fs'
import { join } from 'path'
import { projectsDir } from './claudeHome'

export interface TranscriptEvent {
  type?: string
  isSidechain?: boolean
  timestamp?: string
  /** present on `permission-mode` events: "plan" | "auto" | "normal" | ... */
  permissionMode?: string
  message?: {
    model?: string
    role?: string
    content?: Array<{ type?: string; name?: string }> | string
    usage?: Record<string, unknown>
  }
}

const pathCache = new Map<string, string>()

/**
 * Find the transcript file for a session by matching `<sessionId>.jsonl`
 * anywhere under projects/. Robust against the cwd path-encoding scheme.
 */
export async function findTranscript(sessionId: string): Promise<string | null> {
  const cached = pathCache.get(sessionId)
  if (cached) {
    try {
      await fs.access(cached)
      return cached
    } catch {
      pathCache.delete(sessionId)
    }
  }
  const root = projectsDir()
  let dirs: string[]
  try {
    dirs = await fs.readdir(root)
  } catch {
    return null
  }
  const target = `${sessionId}.jsonl`
  for (const d of dirs) {
    const candidate = join(root, d, target)
    try {
      await fs.access(candidate)
      pathCache.set(sessionId, candidate)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

const TAIL_BYTES = 128 * 1024

/** Read and parse the last events of a transcript (most recent last). */
export async function tailEvents(file: string, maxEvents = 60): Promise<TranscriptEvent[]> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(file, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const length = size - start
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    let text = buf.toString('utf8')
    // If we sliced mid-line, drop the partial first line.
    if (start > 0) {
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    const events: TranscriptEvent[] = []
    for (const line of lines.slice(-maxEvents)) {
      try {
        events.push(JSON.parse(line))
      } catch {
        // ignore malformed/partial lines
      }
    }
    return events
  } catch {
    return []
  } finally {
    await handle?.close()
  }
}
