// cache-countdown: how long until this session's prompt cache goes cold, and
// an optional keep-warm ping for when you step away.
//
// The cache lives `ttlMinutes` after the main thread's last model request.
// Every main-thread request (`turn.step` with no agentId) restarts the clock.
// A keep-warm ping is `$.model.fork`: one tool-less question over the
// session's own transcript, which the API serves from the cache, so the
// cache's lifetime restarts without adding anything to the conversation.
//
// A handoff is the same kind of fork with a different question: a prompt a
// fresh session can start from, written while the cache is still warm (so it
// is cheap), shown in a pane, saved under ~/.claude/handoffs and copyable.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheHit, Handoff, KeepWarm, Ping } from '../types'

const lastWarmAt = atom({ plugin: 'cache-countdown', key: 'lastWarmAt' } as const, null)
const now = atom({ plugin: 'cache-countdown', key: 'now' } as const, 0)
const keepWarm = atom({ plugin: 'cache-countdown', key: 'keepWarm' } as const, null)
const lastPing = atom({ plugin: 'cache-countdown', key: 'lastPing' } as const, null)
const lastHit = atom({ plugin: 'cache-countdown', key: 'lastHit' } as const, null)
const handoff = atom({ plugin: 'cache-countdown', key: 'handoff' } as const, null)

const HANDOFF_PANE = 'handoff'
const HANDOFF_PROMPT = `Stop working on the task: this is a request from the cache-countdown mod, not a new instruction to act on.

Write a handoff prompt that I will paste into a brand-new Claude Code session, started in the same directory, with none of this conversation's context. The new session must be able to pick the work up from it alone, without re-reading everything we went through.

Address it to the new session, in Markdown, under about 700 words, with these sections:
- **Goal**: what we are doing and why, in the user's terms.
- **Where it stands**: what is done and verified, what is done but not verified, what is not started. Name the branch, PR, commits or issue numbers if there are any.
- **Decisions already made**: settled choices and who made them, so the new session does not reopen them.
- **Key files**: paths (with line numbers where it helps) and what each holds for this work.
- **Next steps**: in order, concrete enough to start on.
- **Gotchas**: what was tried and failed, constraints, commands that work, anything surprising.

Use only facts from this conversation and mark anything you are unsure of. Leave out secrets. Reply with the handoff prompt alone: no preamble, no closing remarks.`

const MIN = 60_000
const HOUR = 60 * MIN
const PING_RETRY_MS = MIN

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MIN))
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

type Settings = {
  ttlMs: number
  leadMs: number
  warnMs: number
  maxMs: number
  stopWhenBack: boolean
}

// Set by register; module variables start over on a reload, which is fine.
let cfg: Settings = { ttlMs: 60 * MIN, leadMs: 5 * MIN, warnMs: 5 * MIN, maxMs: 4 * HOUR, stopWhenBack: true }
let isWorking = false
let isPinging = false
let pingTriedAt = 0
let warnedFor: number | null = null
let isHandingOff = false
let cwd = ''

async function stamp($: EngineInterface) {
  const t = await $.clock.now()
  await update($, lastWarmAt, () => t)
  await update($, now, () => t)
}

async function startKeepWarm($: EngineInterface, hours?: number) {
  const t = await $.clock.now()
  const until = t + (hours !== undefined ? hours * HOUR : cfg.maxMs)
  await update($, keepWarm, (): KeepWarm => ({ until }))
  return until - t
}

async function stopKeepWarm($: EngineInterface) {
  await update($, keepWarm, () => null)
}

async function ping($: EngineInterface) {
  if (isPinging) return
  isPinging = true
  pingTriedAt = await $.clock.now()
  try {
    const r = await $.model.fork({ prompt: 'Keep-alive ping from the cache-countdown mod. Reply with only: ok' })
    const at = await $.clock.now()
    let result: Ping
    if (r.isAnswered) {
      const hitTokens = r.usage.cache_read_input_tokens
      const wrote = r.usage.cache_creation_input_tokens
      result = {
        at,
        isOk: true,
        note: hitTokens > 0 ? `read ${tokens(hitTokens)} from cache` : `cache was cold, rewrote ${tokens(wrote)}`,
      }
      await update($, lastWarmAt, () => at)
    } else {
      const why = r.reason === 'api-error' && 'status' in r ? `api error ${r.status}` : r.reason
      result = { at, isOk: false, note: why }
      $.ui.toast(`cache-countdown: keep-warm ping failed (${why}); retrying in a minute`)
    }
    await update($, lastPing, () => result)
  } finally {
    isPinging = false
  }
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  await update($, now, () => t)
  const warmAt = await read($, lastWarmAt)
  const kw = await read($, keepWarm)

  if (kw !== null && t >= kw.until) {
    await stopKeepWarm($)
    $.ui.toast('cache-countdown: keep-warm switched itself off (time limit reached)')
    return
  }
  if (warmAt === null || isWorking) return
  const elapsed = t - warmAt

  if (kw !== null) {
    if (elapsed >= cfg.ttlMs - cfg.leadMs && !isPinging && t - pingTriedAt >= PING_RETRY_MS) {
      void ping($)
    }
    return
  }

  const left = cfg.ttlMs - elapsed
  if (cfg.warnMs > 0 && left > 0 && left <= cfg.warnMs && warnedFor !== warmAt) {
    warnedFor = warmAt
    $.ui.toast(`Prompt cache goes cold in ${clock(left)}. /keepwarm to hold it, or /handoff to start fresh later.`, { timeoutMs: 10_000 })
  }
}

function stampName(t: number): string {
  // 2026-11-05T13:22:10.123Z -> 2026-11-05-132210
  const iso = new Date(t).toISOString()
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
}

async function writeHandoff($: EngineInterface) {
  await $.ui.open({ id: HANDOFF_PANE, title: 'Handoff' })
  if (isHandingOff) return
  isHandingOff = true
  const startedAt = await $.clock.now()
  await update($, handoff, (): Handoff => ({ status: 'writing', startedAt, text: '', path: null, note: '' }))
  try {
    const r = await $.model.fork({ prompt: HANDOFF_PROMPT })
    const at = await $.clock.now()
    if (!r.isAnswered) {
      const why = r.reason === 'api-error' && 'status' in r ? `api error ${r.status}` : r.reason
      await update($, handoff, (): Handoff => ({ status: 'failed', startedAt, text: '', path: null, note: why }))
      return
    }
    // The fork read (or rewrote) the cache, so it is warm again.
    await update($, lastWarmAt, () => at)
    const project = cwd.split('/').filter(Boolean).pop() ?? 'session'
    const header = `<!-- Handoff from a Claude Code session in ${cwd || 'an unknown directory'}, written ${new Date(at).toISOString()} -->\n\n`
    let path: string | null = null
    let note = `read ${tokens(r.usage.cache_read_input_tokens)} from cache`
    try {
      const home = await $.env.get('HOME')
      if (home !== undefined) {
        path = `${home}/.claude/handoffs/${project}-${stampName(at)}.md`
        await $.fs.write(path, header + r.text.trim() + '\n')
      }
    } catch {
      path = null
      note += '; could not save the file'
    }
    await update($, handoff, (): Handoff => ({ status: 'ready', startedAt, text: r.text.trim(), path, note }))
  } finally {
    isHandingOff = false
  }
}

export const register: Register = (on, options) => {
  const ttlMs = num(options.ttlMinutes, 60) * MIN
  cfg = {
    ttlMs,
    leadMs: Math.min(num(options.pingLeadMinutes, 5) * MIN, ttlMs / 2),
    warnMs: num(options.warnMinutes, 5) * MIN,
    maxMs: Math.max(num(options.keepWarmMaxHours, 4), 0.25) * HOUR,
    stopWhenBack: options.stopWhenBack !== false,
  }
  const { leadMs, warnMs, stopWhenBack } = cfg

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff prompt for a fresh session while the cache is still warm',
    })
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm while you are away: /keepwarm [on|off|<hours>]',
      argumentHint: '[on|off|<hours>]',
    })
    // First load: assume the cache was just written. The mod
    // loads at the end of a turn, right after that turn's last request.
    if ((await read($, lastWarmAt)) === null) await stamp($)
    const startedAt = await $.clock.now()
    await update($, now, () => startedAt)
    $.clock.every(1000, () => void tick($))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, lastWarmAt, () => null)
      await update($, lastHit, () => null)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    isWorking = false
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await stamp($)
    const r = yield* next(e)
    if (r.usage !== null) {
      const hit: CacheHit = {
        readTokens: r.usage.cache_read_input_tokens,
        writeTokens: r.usage.cache_creation_input_tokens,
      }
      await update($, lastHit, () => hit)
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (stopWhenBack && !e.isMeta && (await read($, keepWarm)) !== null) {
      await stopKeepWarm($)
      $.ui.toast('Welcome back: keep-warm is off.')
    }
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'off' || arg === 'stop') {
      await stopKeepWarm($)
      return { text: 'Keep-warm is off.' }
    }
    if (arg === '' && (await read($, keepWarm)) !== null) {
      await stopKeepWarm($)
      return { text: 'Keep-warm is off.' }
    }
    const hours = arg === '' || arg === 'on' ? undefined : Number.parseFloat(arg.replace(/h$/, ''))
    if (hours !== undefined && !(hours > 0)) {
      return { text: 'Usage: /keepwarm [on|off|<hours>], e.g. /keepwarm 1.5' }
    }
    const forMs = await startKeepWarm($, hours)
    const back = stopWhenBack ? ', or until you send your next message' : ''
    return { text: `Keep-warm is on for ${span(forMs)}${back}. It pings ${span(leadMs)} before the cache would go cold.` }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    void writeHandoff($)
    return { text: 'Writing a handoff prompt in the Handoff pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: HANDOFF_PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const ho = await read($, handoff)
    const t = await read($, now)
    const surface = e.surface

    if (ho === null) return <Text dimColor>No handoff yet. Press Handoff above the prompt, or run /handoff.</Text>
    if (ho.status === 'writing') {
      return (
        <Text dimColor>
          Writing the handoff from this conversation… {t > ho.startedAt ? clock(t - ho.startedAt) : ''}
        </Text>
      )
    }
    if (ho.status === 'failed') {
      return (
        <Box flexDirection="column">
          <Text color="error">The handoff could not be written ({ho.note}).</Text>
          <Button key="retry" label="Try again" onPress={() => void writeHandoff($)} />
        </Box>
      )
    }
    const copy = async () => {
      const r = await $.ui.copy({ text: ho.text, surface })
      $.ui.toast(r.isCopied ? 'Handoff copied. Paste it into a new session.' : `Could not copy (${r.reason}).`)
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Button key="copy" variant="primary" label="Copy" onPress={() => void copy()} />
          <Button key="again" label="Rewrite" onPress={() => void writeHandoff($)} />
        </Box>
        <Text dimColor>
          {ho.path !== null ? `Saved to ${ho.path}` : 'Not saved to a file'} · {ho.note}
        </Text>
        <Markdown text={ho.text} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    const t = (await read($, now)) || (await read($, lastWarmAt)) || 0
    const warmAt = await read($, lastWarmAt)
    const kw = await read($, keepWarm)
    const pinged = await read($, lastPing)
    const hit = await read($, lastHit)

    const working = isWorking || e.props.isWorking
    const left = warmAt === null ? ttlMs : ttlMs - (t - warmAt)
    const isCold = warmAt !== null && left <= 0 && !working
    const color = warmAt === null ? 'subtle' : isCold ? 'error' : left <= Math.max(warnMs, leadMs) ? 'warning' : 'success'
    const cached = hit === null ? 0 : hit.readTokens + hit.writeTokens

    // Headline: state, then the number that matters, then a small meter.
    const label = warmAt === null ? 'Cache empty' : isCold ? 'Cache cold' : 'Cache warm'
    const figure = warmAt === null ? '' : working ? 'in use' : isCold ? `expired ${span(-left)} ago` : clock(left)
    const METER = 20
    const filled = working ? METER : Math.round(Math.max(0, Math.min(1, left / ttlMs)) * METER)

    // One plain-language line under it.
    let detail: string
    if (warmAt === null) detail = 'Nothing cached yet: the countdown starts with your first message.'
    else if (kw !== null) {
      const nextPing = isPinging ? 'pinging now' : `next ping in ${clock(Math.max(0, left - leadMs))}`
      const until = `stops in ${span(kw.until - t)}${stopWhenBack ? ' or when you’re back' : ''}`
      const last = pinged === null ? '' : pinged.isOk ? ` · last ping ${span(t - pinged.at)} ago kept it warm` : ` · last ping failed (${pinged.note})`
      detail = `Keep-warm on · ${nextPing} · ${until}${last}`
    } else if (isCold) {
      detail = cached > 0
        ? `Your next message re-reads all ${tokens(cached)} tokens at full price. Handoff starts fresh instead.`
        : 'Your next message re-reads the whole conversation at full price. Handoff starts fresh instead.'
    } else if (hit !== null && hit.readTokens === 0 && hit.writeTokens > 0) {
      detail = `Your last message rebuilt the cache: ${tokens(cached)} tokens of conversation, good for ${span(ttlMs)}.`
    } else if (cached > 0) {
      detail = `${tokens(cached)} tokens of conversation cached · each message restarts the ${span(ttlMs)} clock`
    } else {
      detail = `Each message restarts the ${span(ttlMs)} clock.`
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2} rowGap={1}>
        <Box flexDirection="column" flexShrink={1}>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Text color={color} weight="semibold">
              {isCold || warmAt === null ? '○' : '●'} {label}
            </Text>
            {figure !== '' && (
              <Text color={color} weight="bold" size="heading" tabular>
                {figure}
              </Text>
            )}
            {warmAt !== null && !isCold && (
              <Text mono>
                <Text color={color}>{'━'.repeat(filled)}</Text>
                <Text dimColor>{'━'.repeat(METER - filled)}</Text>
              </Text>
            )}
          </Box>
          <Text dimColor size="footnote">
            {detail}
          </Text>
        </Box>
        <Box flexDirection="row" columnGap={1}>
          {kw === null ? (
            <Button key="warm" label="Keep warm" onPress={() => void startKeepWarm($)} />
          ) : (
            <Button key="stop" label="Stop keep-warm" onPress={() => void stopKeepWarm($)} />
          )}
          <Button
            key="handoff"
            label="Handoff"
            variant={isCold ? 'primary' : 'secondary'}
            onPress={() => void writeHandoff($)}
          />
        </Box>
      </Box>
    )
  })
}
