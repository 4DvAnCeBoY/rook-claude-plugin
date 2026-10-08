import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { RookRunView, RookSnapshot, RookStale } from '../types'
import { statusLine } from '../hooks/format'
import {
  budgetText,
  composeStatus,
  editedPart,
  etaMs,
  etaText,
  fitParts,
  isLowCredits,
  jobText,
  msPerScenario,
  sparkline,
  trendOf,
  trendText,
} from '../hooks/statusline'
import type { StatusInput, TrendPoint } from '../hooks/statusline'
import type { Io } from '../hooks/workspace'
import { runIds } from '../hooks/workspace'
import { SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, inFlight, reportYaml, runYaml, VERDICT_FAIL, workspace } from './fixtures/workspace'

/** An `Io` over a map of files, listing directories the way `$.fs.list` does. */
function ioOver(files: Readonly<Record<string, string>>): Io {
  return {
    read: async path => files[path],
    list: async path => {
      const names = new Map<string, string>()

      for (const file of Object.keys(files)) {
        if (file.startsWith(`${path}/`)) {
          const rest = file.slice(path.length + 1)
          names.set(rest.split('/')[0]!, rest.includes('/') ? 'dir' : 'file')
        }
      }

      return [...names.entries()].map(([name, kind]) => ({ name, kind }))
    },
  }
}

const run = (over: Partial<RookRunView> = {}): RookRunView => ({
  runId: '2026-10-01T10-00-00Z',
  planned: 7,
  done: 7,
  finished: true,
  counts: { pass: 4, fail: 0, unverifiable: 3 },
  rows: [],
  lanes: [],
  clusters: [],
  next: [],
  credits: 14,
  ...over,
})

const current = (pass: number, fail: number, unverifiable: number) => [
  ...Array.from({ length: pass }, (_, i) => ({ id: `SC-1${i}0`, title: 'p', status: 'Pass' as const, runId: 'r' })),
  ...Array.from({ length: fail }, (_, i) => ({ id: `SC-2${i}0`, title: 'f', status: 'Fail' as const, runId: 'r' })),
  ...Array.from({ length: unverifiable }, (_, i) => ({ id: `SC-3${i}0`, title: 'u', status: 'Unable to Verify' as const, runId: 'r' })),
]

const snap = (latest: RookRunView, over: Partial<RookSnapshot> = {}): RookSnapshot => ({ agentId: 'a', latest, current: current(4, 0, 3), neverRun: 0, checkedAt: 0, ...over })

const points = (...rates: number[]): TrendPoint[] => rates.map((passRate, i) => ({ runId: `r${i}`, passRate, executed: 4, credits: 8, durationMs: 120_000 }))

const STALE: RookStale = { files: ['src/tools.mjs'], scenarios: [], isWholeAgent: false, since: 0 }

const input = (over: Partial<StatusInput>): StatusInput => ({
  snapshot: snap(run()),
  running: null,
  stale: null,
  balance: null,
  budget: null,
  job: null,
  trend: [],
  now: 1_000_000,
  ...over,
})

describe('status line · trend', () => {
  test('sparkline: one bar per pass rate on a fixed 0–100% scale', () => {
    expect(sparkline([0, 0.5, 1])).toBe('▁▅█')
    expect(sparkline([0.3, 0.6, 0.8])).toBe('▃▅▇')
    expect(sparkline([50, 100])).toBe('▅█') // percentages read the same
    expect(sparkline([-1, 1])).toBe('▁█')
  })

  test('the trend needs three decided runs and shows the last eight', () => {
    expect(trendText(points(0.5, 1))).toBeUndefined()
    expect(trendText([...points(0.5, 1), { runId: 'x', executed: 3 }])).toBeUndefined() // nothing decided: no bar
    expect(trendText(points(0.3, 0.6, 0.8))).toBe('▃▅▇')
    expect(trendText(points(0, 0, 0, 0, 1, 1, 1, 1, 1, 1))).toBe('▁▁██████')
  })

  test('beside the score, before the gaps', () => {
    expect(composeStatus(input({ trend: points(0.3, 0.6, 0.8) }))).toBe('✓4 ✗0 ?3 ▃▅▇')
  })

  test('trendOf: finished, non-test runs from disk, oldest first', async () => {
    const fresh = '2026-09-29T09-00-00Z'
    const test = '2026-09-29T10-00-00Z'
    const files = workspace({
      [`${AGENT_DIR}/runs/${fresh}/run.yaml`]: runYaml(fresh, '', ['SC-004']),
      [`${AGENT_DIR}/runs/${fresh}/report.yaml`]: reportYaml(fresh, 1, 0, 0, 2),
      [`${AGENT_DIR}/runs/${test}/run.yaml`]: runYaml(test, '', ['SC-004']).replace('test_mode: false', 'test_mode: true'),
      [`${AGENT_DIR}/runs/${test}/report.yaml`]: reportYaml(test, 0, 1, 0, 0),
    })
    const io = ioOver(files)
    const trend = await trendOf(io, AGENT_DIR, await runIds(io, AGENT_DIR))

    expect(trend.map(point => [point.passRate, point.executed, point.credits, point.durationMs])).toEqual([
      [0, 2, 3, 64_000],
      [0.5, 3, 12.5, 64_000],
      [1, 1, 2, 64_000],
    ])
    expect(trendText(trend)).toBe('▁▅█')
    expect(await trendOf(io, AGENT_DIR, await runIds(io, AGENT_DIR), 2)).toHaveLength(2)
  })
})

describe('status line · ETA', () => {
  const inflight = run({ finished: false, planned: 7, done: 1, lanes: [{ id: 'SC-006', title: 't', phase: 'judging', since: 0 }], created: '2026-10-01T10:00:00.000Z' })

  test("from recent runs' pace per scenario, the median", () => {
    expect(msPerScenario(points(1, 1, 1))).toBe(30_000)
    expect(msPerScenario([{ runId: 'a', executed: 2, durationMs: 10_000 }, { runId: 'b', executed: 1, durationMs: 40_000 }])).toBe(22_500)
    expect(msPerScenario([{ runId: 'a', executed: 0, durationMs: 10_000 }])).toBeUndefined()
    expect(etaMs(inflight, null, 0, points(1, 1))).toBe(6 * 30_000)
    expect(etaMs(inflight, null, 0, [])).toBeUndefined()
  })

  test("the run's own pace once two are judged", () => {
    const twoDone = { ...inflight, done: 2 }
    const started = Date.parse('2026-10-01T10:00:00.000Z')

    expect(etaMs(twoDone, null, started + 120_000, [])).toBe(5 * 60_000)
    // a run started here counts from when it started
    expect(etaMs(twoDone, { startedAt: 1_000, label: 'all', source: 'pane' }, 41_000, [])).toBe(5 * 20_000)
    // a clock before the run started falls back to history
    expect(etaMs(twoDone, null, 0, points(1))).toBe(5 * 30_000)
    expect(etaMs({ ...inflight, done: 7 }, null, 0, points(1))).toBeUndefined()
  })

  test('words and placement: after the lane', () => {
    expect(etaText(20_000)).toBe('<1m left')
    expect(etaText(80_000)).toBe('~1m left')
    expect(etaText(5 * 60_000)).toBe('~5m left')
    expect(etaText(80 * 60_000)).toBe('~1h20m left')
    expect(composeStatus(input({ snapshot: snap(inflight), trend: points(1, 1) }))).toBe('▸ 1/7 · SC-006 judging · ~3m left · ✓4 ✗0 ?3')
  })
})

describe('status line · markers', () => {
  test('an untested edit names the file when there is room', () => {
    expect(editedPart(STALE)).toEqual({ text: '⚠ edited tools.mjs', short: '⚠ edited', rank: 2 })
    expect(editedPart({ ...STALE, files: ['src/a.ts', 'b.ts'] }).text).toBe('⚠ edited a.ts +1')
    expect(composeStatus(input({ stale: STALE }))).toBe('✓4 ✗0 ?3 · ⚠ edited tools.mjs')
  })

  test('low credits: below one full run of every scenario at the latest rate', () => {
    const snapshot = snap(run()) // 14 credits / 7 scenarios = 2 each, 7 scenarios = 14

    expect(isLowCredits(13.9, snapshot, [])).toBe(true)
    expect(isLowCredits(14, snapshot, [])).toBe(false)
    expect(isLowCredits(null, snapshot, [])).toBe(false)
    // a run in flight: the rate comes from the newest finished run on disk (8 / 4 = 2)
    expect(isLowCredits(13, snap(run({ finished: false, done: 1 })), points(1))).toBe(true)
    expect(isLowCredits(13, snap(run({ finished: false, done: 1 })), [])).toBe(false)
    // never-run scenarios count too
    expect(isLowCredits(15, snap(run(), { neverRun: 1 }), [])).toBe(true)
    expect(composeStatus(input({ balance: 3 }))).toBe('✓4 ✗0 ?3 · low credits')
  })

  test('budget', () => {
    expect(budgetText({ limit: 500, spent: 120.4 })).toBe('120/500 cr')
    expect(composeStatus(input({ budget: { limit: 500, spent: 120 } }))).toBe('✓4 ✗0 ?3 · 120/500 cr')
  })

  test('a generate or explore in flight leads the line', () => {
    const job = { kind: 'generate' as const, label: 'g', startedAt: 1_000_000 - 130_000, lanes: [], done: 3, planned: 7 }

    expect(jobText(job, 1_000_000)).toBe('▸ generate · 3/7 · 2m10s')
    expect(jobText({ ...job, kind: 'explore', done: undefined, planned: undefined }, 1_000_000)).toBe('▸ explore · 2m10s')
    expect(composeStatus(input({ job }))).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3')
    // outside a workspace a job still shows; markers do not
    expect(composeStatus(input({ snapshot: null, job, budget: { limit: 5, spent: 1 } }))).toBe('▸ generate · 3/7 · 2m10s')
  })

  test('outside a workspace: nothing, or the setup step', () => {
    expect(composeStatus(input({ snapshot: null, stale: STALE, balance: 0 }))).toBeUndefined()
    expect(composeStatus(input({ snapshot: null, setup: 'setup: install rook' }))).toBe('setup: install rook')
  })

  test('the score alone reads as before', () => {
    const snapshot = snap(run())

    expect(composeStatus(input({ snapshot }))).toBe(statusLine(snapshot, false))
  })
})

describe('status line · fitting the width', () => {
  const everything = input({
    snapshot: snap(run({ rows: [{ id: 'SC-300', title: 'u', status: 'Unable to Verify', gaps: [], unchecked: [], compromised: false, summary: '', failing: [] }] })),
    stale: { ...STALE, files: ['src/agent-tools-and-guardrails.mjs'] },
    balance: 1,
    budget: { limit: 500, spent: 120 },
    job: { kind: 'generate', label: 'g', startedAt: 1_000_000 - 130_000, lanes: [], done: 3, planned: 7 },
    trend: points(0.3, 0.6, 0.8),
  })

  test('everything fits on a wide line', () => {
    expect(composeStatus({ ...everything, max: 200 })).toBe(
      '▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 ▃▅▇ · 1 gap · ⚠ edited agent-tools-and-guardrails.mjs · low credits · 120/500 cr',
    )
  })

  test('shortens the file name first, then drops gaps, trend, budget, low credits, edited, job', () => {
    const at = (max: number) => composeStatus({ ...everything, max })

    expect(at(100)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 ▃▅▇ · 1 gap · ⚠ edited · low credits · 120/500 cr')
    expect(at(80)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 ▃▅▇ · ⚠ edited · low credits · 120/500 cr')
    expect(at(73)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 · ⚠ edited · low credits · 120/500 cr')
    expect(at(72)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 · ⚠ edited · low credits')
    expect(at(48)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 · ⚠ edited')
    expect(at(40)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3')
    expect(at(20)).toBe('✓4 ✗0 ?3') // rank 0 stays, however narrow
    expect(composeStatus(everything)!.length).toBeLessThanOrEqual(72)
  })

  test('while running: the lane goes before the ETA, the progress and counts stay', () => {
    const inflight = run({ finished: false, done: 5, planned: 7, lanes: [{ id: 'SC-006', title: 't', phase: 'judging', since: 0 }] })
    const at = (max: number) => composeStatus(input({ snapshot: snap(inflight), trend: points(1, 1), stale: STALE, max }))

    expect(at(80)).toBe('▸ 5/7 · SC-006 judging · ~1m left · ✓4 ✗0 ?3 · ⚠ edited tools.mjs')
    expect(at(48)).toBe('▸ 5/7 · ~1m left · ✓4 ✗0 ?3 · ⚠ edited tools.mjs')
    expect(at(37)).toBe('▸ 5/7 · ✓4 ✗0 ?3 · ⚠ edited tools.mjs') // the drop left room for the name again
    expect(at(36)).toBe('▸ 5/7 · ✓4 ✗0 ?3 · ⚠ edited')
  })

  test('fitParts keeps the order and glue', () => {
    expect(fitParts([{ text: 'a', rank: 0 }, { text: 'b', rank: 1, glue: ' ' }, { text: 'c', rank: 2 }], 3)).toBe('a b')
    expect(fitParts([{ text: 'x', rank: 1 }, { text: 'a', rank: 0 }], 1)).toBe('a')
  })
})

describe('status line · in a session', () => {
  async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
    const world = worldOf(on, files)
    const clock = mock.clock(on, { now: 1_000_000 })

    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.session.start(SESSION)

    return { world, clock }
  }

  const FRESH = '2026-09-29T09-00-00Z'
  const third = {
    [`${AGENT_DIR}/runs/${FRESH}/run.yaml`]: runYaml(FRESH, '', ['SC-004']),
    [`${AGENT_DIR}/runs/${FRESH}/scenarios/SC-004/verdict.yaml`]: VERDICT_FAIL,
    [`${AGENT_DIR}/runs/${FRESH}/report.yaml`]: reportYaml(FRESH, 1, 0, 0, 2),
  }

  test('three runs on disk draw a trend', async ($, on) => {
    const { world } = await start($, on, workspace(third))

    expect(world.statuses.at(-1)).toMatch(/^✓\d ✗\d \?\d ▁▅█/)
  })

  test('an edit to the agent marks the line at once; the next finished run clears it', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 · 2 gaps · ↑1 fixed · ⚠ edited tools.mjs')

    for (const [path, text] of Object.entries(third)) {
      world.files.set(path, text)
    }

    await clock.advance(3_000)
    expect(world.statuses.at(-1)).not.toContain('edited')
  })

  test('a balance below one full run says low credits', async ($, on) => {
    const world = worldOf(on, workspace())
    const clock = mock.clock(on, { now: 1_000_000 })
    world.plan = { stdout: JSON.stringify({ username: 'dev', subscription: 'Team', credits: 5 }), code: 0 }
    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.session.start(SESSION)
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 · 2 gaps · ↑1 fixed')

    // the balance is fetched just after start, and the line follows it at once
    await clock.advance(10)
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 · 2 gaps · ↑1 fixed · low credits')
  })

  test("a run in flight estimates what is left from earlier runs' pace", async ($, on) => {
    const { world } = await start($, on, inFlight())

    // the baseline took 64s for two scenarios: one left is about half a minute
    expect(world.statuses.at(-1)).toBe('▸ 2/3 · SC-007 starting · <1m left · ✓1 ✗1 ?0')
  })
})
