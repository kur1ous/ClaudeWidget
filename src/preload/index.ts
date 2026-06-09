import { contextBridge, ipcRenderer } from 'electron'
import {
  Channels,
  type SessionInfo,
  type UsageSnapshot,
  type BurnSnapshot,
  type CostSnapshot
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  onSessions: (cb: (s: SessionInfo[]) => void) => subscribe(Channels.sessions, cb),
  onUsage: (cb: (u: UsageSnapshot) => void) => subscribe(Channels.usage, cb),
  onBurn: (cb: (b: BurnSnapshot) => void) => subscribe(Channels.burn, cb),
  onCost: (cb: (c: CostSnapshot) => void) => subscribe(Channels.cost, cb),
  // Called by the renderer AFTER it has subscribed, so the replay can't be missed.
  ready: () => ipcRenderer.send('renderer:ready'),
  // Ask main to resize the window to the current content height.
  resize: (height: number) => ipcRenderer.send('widget:resize', height)
}

contextBridge.exposeInMainWorld('widget', api)
