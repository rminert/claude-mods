export type CacheHit = { readTokens: number; writeTokens: number }
export type KeepWarm = { until: number }
export type Ping = { at: number; isOk: boolean; note: string }
export type Handoff = {
  status: 'writing' | 'ready' | 'failed'
  startedAt: number
  text: string
  path: string | null
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-countdown': {
      lastWarmAt: number | null
      now: number
      keepWarm: KeepWarm | null
      lastPing: Ping | null
      lastHit: CacheHit | null
      handoff: Handoff | null
    }
  }
}
