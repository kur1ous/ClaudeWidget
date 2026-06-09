import { homedir } from 'os'
import { join } from 'path'

/** Root of Claude Code's local data directory (~/.claude). */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function sessionsDir(): string {
  return join(claudeHome(), 'sessions')
}

export function projectsDir(): string {
  return join(claudeHome(), 'projects')
}

export function credentialsPath(): string {
  return join(claudeHome(), '.credentials.json')
}

export function settingsPath(): string {
  return join(claudeHome(), 'settings.json')
}
