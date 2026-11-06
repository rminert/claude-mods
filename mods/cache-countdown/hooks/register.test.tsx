import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'cache-countdown',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'cache-countdown',
  component: 'Pane',
  requestId: 'handoff',
  props: {
    title: 'Handoff',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const MIN = 60_000

function engine(on: On) {
  let forks = 0
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('model.fork', (_, e) => {
    if (e.prompt.includes('handoff prompt')) {
      return {
        value: {
          isAnswered: true,
          text: '## Goal\nFinish the thing.\n\n## Next steps\n1. Run the tests.',
          usage: { input_tokens: 400, output_tokens: 300, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 },
        },
      }
    }
    forks += 1
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 20, output_tokens: 2, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  return { forks: () => forks }
}

test('the band counts down and shows cold once the hour is up', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Cache warm/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1:00:00$/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(15 * MIN)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^45:00$/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(50 * MIN)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Cache cold/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^expired 5m ago$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Handoff starts fresh/ })).toBeDefined()
  await ui.unmount()
})

test('keep-warm pings before the cache goes cold, and stops when you are back', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fake = engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'warm' })
  expect(await ui.find({ key: 'stop' })).toBeDefined()
  await ui.unmount()

  await clock.advance(54 * MIN)
  expect(fake.forks()).toBe(0)
  await clock.advance(2 * MIN)
  expect(fake.forks()).toBe(1)

  // Two more hours away: one ping per ~55 minutes, never cold.
  await clock.advance(60 * MIN)
  await clock.advance(60 * MIN)
  expect(fake.forks()).toBe(3)
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /Cache warm/ }))?.text).toBeDefined()
  expect((await after.find({ type: 'Text', text: /Keep-warm on/ }))?.text).toContain('kept it warm')
  await after.unmount()

  await $.prompt.submit({ text: 'back from lunch', wait: false, origin: { kind: 'composer' } })
  const back = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await back.find({ key: 'warm' })).toBeDefined()
  await back.unmount()
})

test('keep-warm switches itself off at the limit', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const fake = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'warm' })
  await ui.unmount()

  for (let i = 0; i < 5; i++) await clock.advance(60 * MIN)
  const pings = fake.forks()
  expect(pings).toBe(4)
  await clock.advance(60 * MIN)
  await clock.advance(60 * MIN)
  expect(fake.forks()).toBe(pings)
})

test('Handoff writes a prompt into a pane and saves it', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 10, 5, 13, 22, 10) })
  engine(on)
  const written: { path: string; text: string }[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.write', (_, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  await $.session.start({ cwd: '/Users/me/Repos/my-project', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    await band.press({ key: 'handoff' })
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ key: 'copy' })).toBeDefined()
    expect((await pane.find({ type: 'Text', text: /Saved to/ }))?.text).toContain(
      '/Users/me/.claude/handoffs/my-project-2026-11-05-132210.md',
    )
    await pane.unmount()
  }
  expect(written[0]?.text).toContain('## Next steps')
})
