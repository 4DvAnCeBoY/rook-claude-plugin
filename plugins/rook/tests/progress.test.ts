import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { countText, elapsed, jobFromDisk, jobFromLine, jobSpinnerText, lineSplitter, newJob, shownLanes } from '../hooks/progress'
import type { RookJob } from '../types'
import { PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, workspace } from './fixtures/workspace'

type On = Parameters<typeof worldOf>[0]

const PLUGIN = 'rook'
const SURFACES = ['terminal', 'desktop'] as const
const T0 = 1_000_000
const SPINNER = { component: 'Spinner', surface: 'terminal', requestId: 'spinner', viewport: PANE.viewport, props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' } } as never

type Ran = { result?: unknown; text?: string }

const asText = (ran: Ran): string => (typeof ran.result === 'string' ? ran.result : (ran.text ?? JSON.stringify(ran)))

/** Lines exactly as rook 5be0db96 prints them (generate/plan.ts renderPlan, index.ts, output.ts verboseShow). */
const GENERATE_PLAN = [
  'The refund flows are thin on negatives; the order lookup is covered.',
  '',
  'plan: 7 scenario(s) across 3 feature(s)',
  '  F-001  4  happy_path 2, negative 2',
  '      refunds over the limit and the exclusions are untested',
  '  F-002  2  prompt_injection 2  (medium confidence)',
  '      the order-claim path reads user text into a tool call',
  '  F-003  1  boundary 1',
  '      a refund of exactly the limit',
  '  F-004  none — already covered by SC-002',
]
const GENERATE_VERBOSE = ['  · plan_scenarios 4 feature(s)', '  · plan_scenarios done — 7 scenarios across 3 features', '  · write_scenarios F-001 happy_path', '    read_file src/refunds.ts', '    +0.42 credits (1.10 this session)', '  · write_attacks F-002 prompt_injection']
const GENERATE_END = ['7 scenario(s) written, 1 already current, 3.20 credits', 'on disk only — nothing has been recorded upstream', '  next:  rook sync        record this project upstream']
const EXPLORE_LINES = ['  · find_agents .', 'billing: unchanged, not re-analysed', '  · describe_agent commercecare', '  · extract_features commercecare', 'commercecare: 4 features', 'not an agent: utils — helpers only']

const fold = (job: RookJob, lines: readonly string[], now = T0 + 1000) => lines.reduce((acc, line) => jobFromLine(acc, line, now), job)

describe('progress · parsing what rook prints', () => {
  test('the generate plan: the total, a lane per planned feature, none for the ones it leaves alone', () => {
    const job = fold(newJob('generate', 'scenarios for commercecare', T0, 'tool'), GENERATE_PLAN)

    expect(job.planned).toBe(7)
    expect(job.done).toBe(0)
    expect(job.lanes.map(lane => [lane.id, lane.phase, lane.planned, lane.label])).toEqual([
      ['F-001', 'planned', 4, 'happy_path 2, negative 2'],
      ['F-002', 'planned', 2, 'prompt_injection 2 (medium confidence)'],
      ['F-003', 'planned', 1, 'boundary 1'],
    ])
    expect(job.last).toBe('F-004 none — already covered by SC-002')
  })

  test('--verbose subagent lines move lanes: planning, then writing per feature', () => {
    const job = fold(fold(newJob('generate', 'x', T0, 'tool'), GENERATE_PLAN), GENERATE_VERBOSE, T0 + 5000)

    expect(job.lanes.find(lane => lane.id === 'plan')?.phase).toBe('done')
    expect(job.lanes.find(lane => lane.id === 'F-001')).toMatchObject({ phase: 'writing', since: T0 + 5000, label: 'happy_path 2, negative 2' })
    expect(job.lanes.find(lane => lane.id === 'F-002')?.phase).toBe('writing')
    expect(job.lanes.find(lane => lane.id === 'F-003')?.phase).toBe('planned')
    expect(job.last).toBe('· write_attacks F-002 prompt_injection')
  })

  test('the closing lines and the --json document leave the lanes alone', () => {
    const before = fold(newJob('generate', 'x', T0, 'tool'), GENERATE_PLAN)
    const after = fold(before, [...GENERATE_END, '{', '  "written": [', '    "SC-021"', '  ],', '  "credits": 3.2', '}'])

    expect(after.lanes).toEqual(before.lanes)
    expect(after.last).toBe('next: rook sync record this project upstream')
  })

  test('explore: a lane per agent, from rook\'s per-agent lines and --verbose', () => {
    const job = fold(newJob('explore', 'this repository', T0, 'tool'), EXPLORE_LINES)

    expect(job.lanes.map(lane => [lane.id, lane.phase, lane.label])).toEqual([
      ['scan', 'finding agents', 'the repository'],
      ['billing', 'unchanged', 'not re-analysed'],
      ['commercecare', 'done', '4 features'],
    ])
    expect(job.last).toBe('not an agent: utils — helpers only')
  })

  test('chunks split into whole lines, the unterminated rest on flush', () => {
    const seen: string[] = []
    const lines = lineSplitter(line => seen.push(line))

    lines.push('plan: 7 scen')
    lines.push('ario(s) across 3 feature(s)\r\n  F-001  4  happy')
    expect(seen).toEqual(['plan: 7 scenario(s) across 3 feature(s)'])
    lines.flush()
    expect(seen).toEqual(['plan: 7 scenario(s) across 3 feature(s)', '  F-001  4  happy'])
  })
})

describe('progress · the disk', () => {
  test('scenario files new since the start count as done, per feature; a feature with all its files is done', () => {
    const job = fold(newJob('generate', 'x', T0, 'tool'), GENERATE_PLAN)
    const before = new Set(['SC-002', 'SC-004'])
    const next = jobFromDisk(
      job,
      before,
      [
        { key: 'SC-002', mtimeMs: T0 - 10 },
        { key: 'SC-004', mtimeMs: T0 - 10 },
        { key: 'SC-021', mtimeMs: T0 + 10, owner: 'F-003' },
        { key: 'SC-022', mtimeMs: T0 + 20, owner: 'F-001' },
      ],
      T0 + 2000,
    )

    expect(next.done).toBe(2)
    expect(countText(next)).toBe('2/7')
    expect(next.lanes.find(lane => lane.id === 'F-003')).toMatchObject({ phase: 'done', done: 1 })
    expect(next.lanes.find(lane => lane.id === 'F-001')).toMatchObject({ phase: 'writing', done: 1 })
  })

  test('a scenario rewritten during the job (--force) counts too', () => {
    const next = jobFromDisk(newJob('generate', 'x', T0, 'tool'), new Set(['SC-002']), [{ key: 'SC-002', mtimeMs: T0 + 5, owner: 'F-002' }], T0 + 1000)

    expect(next.done).toBe(1)
    expect(countText(next)).toBe('1 scenarios')
  })

  test('explore: feature files per agent, extracting until rook says how many', () => {
    const next = jobFromDisk(newJob('explore', 'x', T0, 'tool'), new Set(), [{ key: 'commercecare/F-001', mtimeMs: 0, owner: 'commercecare' }, { key: 'commercecare/F-002', mtimeMs: 0, owner: 'commercecare' }], T0 + 1000)

    expect(next.lanes).toEqual([{ id: 'commercecare', label: '2 features so far', phase: 'extracting features', since: T0 + 1000, done: 2 }])
    expect(countText(next)).toBe('2 feature files')
  })
})

describe('progress · lines', () => {
  test('elapsed in whole seconds', () => {
    expect(elapsed(9_400)).toBe('9s')
    expect(elapsed(130_000)).toBe('2m10s')
    expect(elapsed(3_725_000)).toBe('1h02m')
  })

  test('the spinner: kind, the oldest lane in flight, done/planned, elapsed', () => {
    const planned = fold(newJob('generate', 'x', T0, 'tool'), GENERATE_PLAN, T0)
    const writing = fold(fold(planned, ['  · write_scenarios F-003 boundary'], T0 + 1000), ['  · write_scenarios F-001 happy_path'], T0 + 1500)
    const job = jobFromDisk(writing, new Set(), [{ key: 'SC-030', mtimeMs: 0, owner: 'F-001' }, { key: 'SC-031', mtimeMs: 0, owner: 'F-001' }, { key: 'SC-032', mtimeMs: 0, owner: 'F-002' }], T0 + 2000)

    expect(jobSpinnerText(job, T0 + 130_000)).toBe('rook generate · F-003 writing +2 · 3/7 · 2m10s')
    expect(jobSpinnerText(newJob('explore', 'x', T0, 'tool'), T0 + 4000)).toBe('rook explore · 4s')
  })

  test('at most eight lanes, those in flight first', () => {
    let job = newJob('explore', 'x', T0, 'tool')
    for (let i = 0; i < 12; i += 1) {
      job = jobFromLine(job, i % 2 === 0 ? `agent${i}: 3 features` : `  · describe_agent agent${i}`, T0 + i)
    }
    const { lanes, hidden } = shownLanes(job)

    expect(lanes.length).toBe(8)
    expect(hidden).toBe(4)
    expect(lanes.slice(0, 6).every(lane => lane.phase === 'describing')).toBe(true)
  })
})

type Step = string | (() => Promise<void>)

/**
 * A fake rook ahead of the world's: while `fake.script` is set, a spawned rook
 * prints it line by line (`  ·` lines on stderr, as --verbose does), running
 * each function step where it stands.
 */
async function start($: Engine, on: On, files: Record<string, string>) {
  const fake: { script?: () => Step[] } = {}
  type SpawnHook = (...args: unknown[]) => AsyncGenerator<never, never, unknown>
  let worldSpawn: SpawnHook | undefined
  // The world's own spawn hook is kept and wrapped: an event takes one hook per test.
  const onBeneath = ((name: string, ...rest: unknown[]) => {
    if (name === 'process.spawn') {
      worldSpawn = rest.at(-1) as SpawnHook
      return
    }

    return (on as (...args: unknown[]) => unknown)(name, ...rest)
  }) as unknown as On
  const world = worldOf(onBeneath, files)

  on('process.spawn', async function* ($, e, next) {
    if (fake.script === undefined) {
      return yield* worldSpawn!($, e, next)
    }

    world.invocations.push([...e.argv])
    for (const step of fake.script()) {
      if (typeof step === 'string') {
        yield { stream: step.startsWith('  ·') ? ('stderr' as const) : ('stdout' as const), text: `${step}\n` }
      } else {
        await step()
      }
    }

    return { value: { code: 0, signal: null } } as never
  })
  const clock = mock.clock(on, { now: T0 })

  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return { world, clock, fake }
}

/** A drawn tree as text: a Text's children run together, everything else one line each. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }

  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }

  if (node === null || typeof node !== 'object') {
    return ''
  }

  const { type, children, props } = node as { type?: string; children?: unknown; props?: { children?: unknown } }
  const inner = children ?? props?.children

  if (type === 'Text') {
    return textOf(inner)
  }

  return (Array.isArray(inner) ? inner : [inner]).map(textOf).filter(Boolean).join('\n')
}

/** Lets the unawaited line callbacks land before a step looks. */
const settle = async () => {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve()
  }
}

const paneText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  await settle()

  return textOf(await $.ui.render({ ...PANE, surface } as never))
}

const spinnerText = async ($: Engine) => {
  await settle()

  return textOf(await $.ui.render(SPINNER))
}

describe('progress · a generate and an explore in flight', () => {
  test('generate through the tool: the job is set while rook runs, fed by its lines and the disk, then cleared', async ($, on) => {
    const { world, clock, fake } = await start($, on, workspace())
    const seen: { spinner: string; pane: string }[] = []
    const look = async () => {
      seen.push({ spinner: await spinnerText($), pane: await paneText($) })
    }

    fake.script = () => [
      look,
      ...GENERATE_PLAN,
      '  · write_scenarios F-001 happy_path',
      async () => {
        world.files.set(`${AGENT_DIR}/scenarios/SC-021.yaml`, 'id: SC-021\ntitle: Refund over the limit\nfeature_id: F-001\n')
        world.files.set(`${AGENT_DIR}/scenarios/SC-022.yaml`, 'id: SC-022\ntitle: Exactly the limit\nfeature_id: F-003\n')
        await clock.advance(130_000)
      },
      look,
      ...GENERATE_END,
    ]
    const ran = (await $.tool.call({ tool: 'mcp__rook__generate', total: 7 } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'generate', '--yes', '--json', '--total', '7'])
    expect(seen[0]!.spinner).toBe('rook generate · 0s')
    expect(seen[0]!.pane).toContain('▸ rook generate · scenarios for commercecare · 0s')
    expect(seen[1]!.spinner).toBe('rook generate · F-001 writing +1 · 2/7 · 2m10s')
    expect(seen[1]!.pane).toContain('2/7')
    expect(seen[1]!.pane).toContain('F-001 · writing 1/4')
    expect(seen[1]!.pane).toContain('F-003 · done 1/1')
    // the summary is still read from what rook printed
    expect(asText(ran)).toContain('rook generate: 7 scenario files written')
    expect(await spinnerText($)).toBe('Working')
    expect(await paneText($)).not.toContain('▸ rook generate')
  })

  test('/rook generate in the background: lanes in the pane, the spinner left alone', async ($, on) => {
    const { world, clock, fake } = await start($, on, workspace())
    const seen: { spinner: string; pane: string }[] = []

    fake.script = () => [...GENERATE_PLAN, async () => void seen.push({ spinner: await spinnerText($), pane: await paneText($) }), ...GENERATE_END]
    expect((await $.command.run({ command: 'rook', args: 'generate --total 7', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } } as never)).text).toContain('in the background')
    for (let i = 0; i < 50 && world.toasts.length === 0; i += 1) {
      await clock.advance(0)
      await settle()
    }

    expect(seen[0]!.pane).toContain('F-002 · planned 0/2')
    expect(seen[0]!.spinner).toBe('Working')
    expect(world.toasts.at(-1)).toContain('rook generate: 7 scenario files written')
    expect(await paneText($)).not.toContain('▸ rook generate')
  })

  test('a failed generate clears the job too', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.onRun = () => ({ code: 1, stdout: '', stderr: 'no active agent — rook agent use <id>\n' })
    expect(asText((await $.tool.call({ tool: 'mcp__rook__generate' } as never)) as Ran)).toContain('no active agent')

    expect(await paneText($)).not.toContain('▸ rook generate')
  })

  test('explore through the tool: a lane per agent while it runs', async ($, on) => {
    const { world, fake } = await start($, on, workspace())
    const seen: string[] = []

    fake.script = () => [...EXPLORE_LINES.slice(0, 4), async () => void seen.push(await spinnerText($)), async () => void seen.push(await paneText($)), EXPLORE_LINES[4]!, '1 analysed, 1 unchanged, 2.10 credits']
    const ran = (await $.tool.call({ tool: 'mcp__rook__explore' } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'explore', '.', '--yes', '--json'])
    expect(seen[0]).toBe('rook explore · scan finding agents +1 · 0s')
    expect(seen[1]).toContain('▸ rook explore · this repository · 0s')
    expect(seen[1]).toContain('commercecare · extracting features')
    expect(seen[1]).toContain('billing · unchanged · not re-analysed')
    expect(asText(ran)).toContain('1 analysed, 1 unchanged, 2.10 credits')
    expect(await paneText($)).not.toContain('▸ rook explore')
  })
})

describe('progress · the lanes view', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: the job line, the bar, the lanes and the last line`, async ($, on) => {
      const { fake } = await start($, on, workspace())
      let pane = ''

      fake.script = () => [...GENERATE_PLAN, '  · write_scenarios F-001 happy_path', async () => void (pane = await paneText($, surface))]
      await $.tool.call({ tool: 'mcp__rook__generate', instruction: 'the refunds flow' } as never)

      expect(pane).toContain('▸ rook generate · scenarios for commercecare — the refunds flow · 0s')
      expect(pane).toContain('░░░░ 0/7')
      expect(pane).toContain('◌ F-001 · writing 0/4 · 0s · happy_path 2, negative 2')
      expect(pane).toContain('◌ F-003 · planned 0/1 · 0s · boundary 1')
      expect(pane).toContain('· write_scenarios F-001 happy_path')
    })
  }
})
