import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { RookRunView, RookScenarioRow, RookSnapshot, RookStale, RookVerdictHistory } from '../types'
import { statusLine } from '../hooks/format'
import {
  agoText,
  flakyIds,
  greenRun,
  idsText,
  tokenDelta,
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
  recentRuns,
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
    expect(composeStatus(input({ trend: points(0.3, 0.6, 0.8) }))).toBe('✓4 ✗0 ?3 57% ▃▅▇')
  })

  test('recentRuns: finished, non-test runs from disk, oldest first', async () => {
    const fresh = '2026-09-29T09-00-00Z'
    const test = '2026-09-29T10-00-00Z'
    const files = workspace({
      [`${AGENT_DIR}/runs/${fresh}/run.yaml`]: runYaml(fresh, '', ['SC-004']),
      [`${AGENT_DIR}/runs/${fresh}/report.yaml`]: reportYaml(fresh, 1, 0, 0, 2),
      [`${AGENT_DIR}/runs/${test}/run.yaml`]: runYaml(test, '', ['SC-004']).replace('test_mode: false', 'test_mode: true'),
      [`${AGENT_DIR}/runs/${test}/report.yaml`]: reportYaml(test, 0, 1, 0, 0),
    })
    const io = ioOver(files)
    const trend = await recentRuns(io, AGENT_DIR, await runIds(io, AGENT_DIR))

    expect(trend.map(point => [point.passRate, point.executed, point.credits, point.durationMs])).toEqual([
      [0, 2, 3, 64_000],
      [0.5, 3, 12.5, 64_000],
      [1, 1, 2, 64_000],
    ])
    expect(trendText(trend)).toBe('▁▅█')
    expect(await recentRuns(io, AGENT_DIR, await runIds(io, AGENT_DIR), 2)).toHaveLength(2)
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
    expect(composeStatus(input({ snapshot: snap(inflight), trend: points(1, 1) }))).toBe('◐ elsewhere 1/7 · SC-006 judging · ETA ~3m')
  })
})

describe('status line · markers', () => {
  test('an untested edit names the file when there is room', () => {
    expect(editedPart(STALE)).toEqual({ text: '⚠ edited tools.mjs', short: '⚠ edited', rank: 2 })
    expect(editedPart({ ...STALE, files: ['src/a.ts', 'b.ts'] }).text).toBe('⚠ edited a.ts +1')
    expect(composeStatus(input({ stale: STALE }))).toBe('✓4 ✗0 ?3 57% · ⚠ edited tools.mjs')
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
    expect(composeStatus(input({ balance: 3 }))).toBe('✓4 ✗0 ?3 57% · low credits')
  })

  test('budget', () => {
    expect(budgetText({ limit: 500, spent: 120.4 })).toBe('120/500 cr')
    expect(composeStatus(input({ budget: { limit: 500, spent: 120 } }))).toBe('✓4 ✗0 ?3 57% · 120/500 cr')
  })

  test('a generate or explore in flight leads the line', () => {
    const job = { kind: 'generate' as const, label: 'g', startedAt: 1_000_000 - 130_000, lanes: [], done: 3, planned: 7 }

    expect(jobText(job, 1_000_000)).toBe('▸ generate · 3/7 · 2m10s')
    expect(jobText({ ...job, kind: 'explore', done: undefined, planned: undefined }, 1_000_000)).toBe('▸ explore · 2m10s')
    expect(composeStatus(input({ job }))).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 57%')
    // outside a workspace a job still shows; markers do not
    expect(composeStatus(input({ snapshot: null, job, budget: { limit: 5, spent: 1 } }))).toBe('▸ generate · 3/7 · 2m10s')
  })

  test('outside a workspace: nothing, or the setup step', () => {
    expect(composeStatus(input({ snapshot: null, stale: STALE, balance: 0 }))).toBeUndefined()
    expect(composeStatus(input({ snapshot: null, setup: 'setup: install rook' }))).toBe('setup: install rook')
  })

  test('idle, the score leads as it did, with the pass rate beside it', () => {
    const snapshot = snap(run())

    expect(composeStatus(input({ snapshot }))).toBe(`${statusLine(snapshot, false)} 57%`)
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
      '▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 57% ▃▅▇ · ⚠ edited agent-tools-and-guardrails.mjs · low credits · 120/500 cr',
    )
  })

  test('shortens the file name first, then drops parts right to left: budget, low credits, edited, trend, rate, job', () => {
    const at = (max: number) => composeStatus({ ...everything, max })

    expect(at(100)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 57% ▃▅▇ · ⚠ edited · low credits · 120/500 cr')
    expect(at(80)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 57% ▃▅▇ · ⚠ edited · low credits')
    expect(at(67)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 57% ▃▅▇ · ⚠ edited')
    expect(at(53)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 57% ▃▅▇')
    expect(at(42)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3 57%')
    expect(at(38)).toBe('▸ generate · 3/7 · 2m10s · ✓4 ✗0 ?3')
    expect(at(20)).toBe('✓4 ✗0 ?3') // rank 0 stays, however narrow
    expect(composeStatus(everything)!.length).toBeLessThanOrEqual(72)
  })

  test('while running: the marker, then the source, the ETA and the lane go; the progress and failures stay', () => {
    const inflight = run({ finished: false, done: 5, planned: 7, counts: { pass: 3, fail: 2, unverifiable: 0 }, lanes: [{ id: 'SC-006', title: 't', phase: 'judging', since: 0 }] })
    const at = (max: number) => composeStatus(input({ snapshot: snap(inflight), trend: points(1, 1), stale: STALE, max }))

    expect(at(80)).toBe('◐ elsewhere 5/7 ✗2 · SC-006 judging · ETA ~1m · ⚠ edited tools.mjs')
    expect(at(60)).toBe('◐ elsewhere 5/7 ✗2 · SC-006 judging · ETA ~1m · ⚠ edited')
    expect(at(45)).toBe('◐ elsewhere 5/7 ✗2 · SC-006 judging · ETA ~1m')
    expect(at(35)).toBe('◐ 5/7 ✗2 · SC-006 judging · ETA ~1m')
    expect(at(30)).toBe('◐ 5/7 ✗2 · SC-006 judging')
    expect(at(20)).toBe('◐ 5/7 ✗2')
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

    expect(world.statuses.at(-1)).toMatch(/^✓\d ✗\d \?\d \d+% ▁▅█/)
  })

  test('an edit to the agent marks the line at once; the next finished run clears it', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 33% · 1 blocker · ⚠ edited tools.mjs')

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
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 33% · 1 blocker')

    // the balance is fetched just after start, and the line follows it at once
    await clock.advance(10)
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 33% · 1 blocker · low credits')
  })

  test("a run in flight estimates what is left from earlier runs' pace", async ($, on) => {
    const { world } = await start($, on, inFlight())

    // the baseline took 64s for two scenarios: one left is about half a minute
    expect(world.statuses.at(-1)).toBe('◐ elsewhere 2/3 ✗1 · SC-007 starting · ETA <1m')
  })
})

describe('status line · states by priority', () => {
  const R0 = '2026-10-01T09-00-00Z'
  const R1 = '2026-10-01T10-00-00Z'
  const NOW = Date.parse('2026-10-01T11:00:00Z')

  const row = (id: string, status: RookScenarioRow['status'], over: Partial<RookScenarioRow> = {}): RookScenarioRow => ({
    id,
    title: id,
    status,
    gaps: [],
    unchecked: [],
    compromised: false,
    summary: '',
    failing: status === 'Fail' ? [{ id: 'C1', criterion: 'c', expected: 'e', achieved: 'a', evidence: '' }] : [],
    ...over,
  })

  test('fresh repository: not set up, the next step, what was found; nothing found stays silent', () => {
    const snapshot: RookSnapshot = {
      current: [],
      neverRun: 0,
      checkedAt: 0,
      readiness: {
        steps: [
          { id: 'installed', label: '', ok: true },
          { id: 'signed_in', label: '', ok: true },
          { id: 'project', label: '', ok: false },
        ],
        hasWorkspace: false,
      },
      repoFound: [
        { path: 'agent.py', kind: 'agent', what: 'an agent' },
        { path: 'docs/req.md', kind: 'requirements', what: 'requirements' },
        { path: 'b.py', kind: 'agent', what: 'an agent' },
      ],
    }

    expect(composeStatus(input({ snapshot }))).toBe('not set up · next: select a project · found agent, requirements')
    expect(composeStatus(input({ snapshot: { ...snapshot, repoFound: [] } }))).toBeUndefined()
  })

  test('workspace never run: how many, and the setup step or the first run with its price', () => {
    const snapshot: RookSnapshot = { agentId: 'a', current: [], neverRun: 5, checkedAt: 0 }

    expect(composeStatus(input({ snapshot }))).toBe('5 scenarios · never run · next: first run')
    expect(composeStatus(input({ snapshot, trend: points(1) }))).toBe('5 scenarios · never run · next: first run ~10cr')
    expect(composeStatus(input({ snapshot, setup: 'setup: add a profile' }))).toBe('5 scenarios · never run · next: add a profile')
  })

  test('running: the source, progress, failures, the lane with its time, the ETA', () => {
    const inflight = run({
      runId: R1,
      finished: false,
      done: 2,
      planned: 7,
      counts: { pass: 1, fail: 1, unverifiable: 0 },
      lanes: [{ id: 'SC-006', title: 't', phase: 'execute', since: NOW - 12_000 }],
    })
    const running = { startedAt: NOW - 60_000, label: 'all', source: 'pane' as const }

    expect(composeStatus(input({ snapshot: snap(inflight), running, now: NOW }))).toBe('◐ 2/7 ✗1 · SC-006 execute 12s · ETA ~3m')
    expect(composeStatus(input({ snapshot: snap(inflight), running: { ...running, source: 'tool' }, now: NOW }))).toContain('◐ Claude 2/7')
    // started, nothing on disk yet
    expect(composeStatus(input({ snapshot: snap(run()), running, now: NOW }))).toBe('◐ starting')
  })

  test('a setup blocker wins over a run that just landed', () => {
    const live = { own: [], landed: { runId: R1, at: NOW - 60_000, isOwn: false } }

    expect(composeStatus(input({ snapshot: snap(run({ runId: R1 })), live, setup: 'setup: sign in', now: NOW }))).toBe('✓4 ✗0 ?3 · setup: sign in')
  })

  test('just finished: the run, how long ago, fixed, still failing and new failures; idle again after ten minutes', () => {
    const landed = run({ runId: R1, counts: { pass: 1, fail: 2, unverifiable: 0 }, rows: [row('SC-001', 'Pass'), row('SC-002', 'Fail'), row('SC-003', 'Fail')] })
    const snapshot = snap(landed, {
      current: [
        { id: 'SC-001', title: '', status: 'Pass', runId: R1, was: 'Fail' },
        { id: 'SC-002', title: '', status: 'Fail', runId: R1, was: 'Pass' },
        { id: 'SC-003', title: '', status: 'Fail', runId: R1, was: 'Fail' },
      ],
    })
    const live = { own: [], landed: { runId: R1, at: NOW - 180_000, isOwn: false } }

    expect(composeStatus(input({ snapshot, live, now: NOW }))).toBe('✗ 1/3 3m ago · fixed SC-001 · ✗ SC-003 · new ✗ SC-002')
    // too long: fixed goes first, the new failure stays
    expect(composeStatus(input({ snapshot, live, now: NOW, max: 32 }))).toBe('✗ 1/3 3m ago · new ✗ SC-002')
    expect(composeStatus(input({ snapshot, live, now: NOW + 8 * 60_000 }))).toBe('✓1 ✗2 ?0 33%')
  })

  const verdicts: RookVerdictHistory[] = [
    { id: 'SC-001', runs: [{ runId: '2026-09-30T10-00-00Z', status: 'Fail' }, { runId: R0, status: 'Pass' }, { runId: R1, status: 'Pass' }] },
    { id: 'SC-003', runs: [{ runId: R0, status: 'Pass' }, { runId: R1, status: 'Fail' }] },
  ]

  test('idle for a QE: score, pass rate, trusted rate, trend, blockers, flaky', () => {
    const rows = new Map<string, RookScenarioRow>([
      [`${R1}/SC-001`, row('SC-001', 'Pass')],
      [`${R1}/SC-002`, row('SC-002', 'Pass', { weakPasses: ['C2'] })],
      [`${R1}/SC-003`, row('SC-003', 'Fail')],
      [`${R1}/SC-004`, row('SC-004', 'Unable to Verify')],
    ])
    const snapshot = snap(run({ runId: R1 }), { current: [...rows.values()].map(r => ({ id: r.id, title: '', status: r.status, runId: R1 })) })
    const flaky: RookVerdictHistory[] = [{ id: 'SC-002', runs: [{ runId: 'x1', status: 'Pass' }, { runId: 'x2', status: 'Fail' }, { runId: R1, status: 'Pass' }] }, ...verdicts]

    expect(composeStatus(input({ snapshot, trend: points(0.3, 0.6, 0.8), verdicts: flaky, rowAt: (runId, id) => rows.get(`${runId}/${id}`) }))).toBe(
      '✓2 ✗1 ?1 50% (25% trusted) ▃▅▇ · 1 blocker · 1 flaky',
    )
    expect(flakyIds(flaky)).toEqual(['SC-002'])
  })

  test('idle for a developer: regressed since green, files changed since, stale, tokens', () => {
    const rows = new Map<string, RookScenarioRow>([
      [`${R0}/SC-003`, row('SC-003', 'Pass', { tokens: { input: 80, output: 20 } })],
      [`${R1}/SC-003`, row('SC-003', 'Fail', { tokens: { input: 90, output: 20 } })],
    ])
    const latest = run({ runId: R1, rows: [rows.get(`${R1}/SC-003`)!] })
    const snapshot = snap(latest, {
      current: [
        { id: 'SC-001', title: '', status: 'Pass', runId: R1 },
        { id: 'SC-003', title: '', status: 'Fail', runId: R1, was: 'Pass' },
      ],
    })
    const stamps = new Map([
      ['src/a.ts', Date.parse('2026-10-01T09:30:00Z')],
      ['src/b.ts', Date.parse('2026-10-01T08:00:00Z')],
    ])
    const stale: RookStale = { files: ['src/a.ts'], scenarios: [{ id: 'SC-001', title: '' }, { id: 'SC-003', title: '' }], isWholeAgent: false, since: 0 }
    const rowAt = (runId: string, id: string) => rows.get(`${runId}/${id}`)

    expect(greenRun(verdicts)).toBe(R0)
    expect(tokenDelta(latest, verdicts, rowAt)).toBe(10)
    expect(composeStatus(input({ snapshot, lens: 'dev', verdicts, stamps, stale, rowAt }))).toBe('✓1 ✗1 ?0 · 1 regressed since green · Δ1 file · 2 stale · tokens +10%')
  })

  test('helpers: ids, ago', () => {
    expect(idsText(['SC-1', 'SC-2', 'SC-3', 'SC-4'])).toBe('SC-1,SC-2 +2')
    expect(agoText(30_000)).toBe('<1m ago')
    expect(agoText(65 * 60_000)).toBe('1h05m ago')
  })
})
