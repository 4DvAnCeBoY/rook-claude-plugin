import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cellLine, heatGrid, heatMessageOf, previousRunId, runTokens, sparkline, tokenDelta, trendCounts, trendOf, versusPrevious } from '../hooks/trends'
import type { RookStatus, RookVerdictHistory } from '../types'
import { command, PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, NEW_RUN, OLD_RUN, reportYaml, runYaml, VERDICT_OLD_FAIL, workspace } from './fixtures/workspace'

const PLUGIN = 'rook'
const THIRD_RUN = '2026-09-29T09-00-00Z'
const HEAT = 'trends-heat'

const P: RookStatus = 'Pass'
const F: RookStatus = 'Fail'
const U: RookStatus = 'Unable to Verify'

describe('trends · what a scenario’s recent verdicts say', () => {
  test('flaky: Pass and Fail swap twice or more; it wins over regressed', () => {
    expect(trendOf([P, F, P])).toBe('flaky')
    expect(trendOf([P, P, F, P, F])).toBe('flaky')
    expect(trendOf([F, P, F])).toBe('flaky')
  })

  test('regressed: the latest Fail straight after a Pass', () => {
    expect(trendOf([P, P, P, F])).toBe('regressed')
    expect(trendOf([P, U, F])).toBe('regressed') // Unable to Verify says nothing about the agent
  })

  test('fixed: the latest Pass straight after a Fail', () => {
    expect(trendOf([F, F, P])).toBe('fixed')
    expect(trendOf([F, U, P])).toBe('fixed')
  })

  test('never passed: not one Pass in the window', () => {
    expect(trendOf([F, F, F])).toBe('never passed')
    expect(trendOf([U, F])).toBe('never passed')
    expect(trendOf([U])).toBe('never passed')
  })

  test('steady passes, or nothing judged, say nothing', () => {
    expect(trendOf([P, P, P])).toBeUndefined()
    expect(trendOf([P, U, P])).toBeUndefined()
    expect(trendOf([])).toBeUndefined()
  })

  test('only the last 8 count: an old flip-flop has settled', () => {
    expect(trendOf([P, F, P, F, P, P, P, P, P, P, P, P])).toBeUndefined()
  })
})

describe('trends · the heat grid', () => {
  const history: RookVerdictHistory[] = [
    {
      id: 'SC-001',
      runs: [
        { runId: 'r1', status: P },
        { runId: 'r2', status: F },
        { runId: 'r3', status: P },
      ],
    },
    {
      id: 'SC-002',
      runs: [
        { runId: 'r2', status: P },
        { runId: 'r3', status: F },
      ],
    },
    {
      id: 'SC-003',
      runs: [
        { runId: 'r1', status: U },
        { runId: 'r3', status: F },
      ],
    },
    {
      id: 'SC-004',
      runs: [
        { runId: 'r1', status: P },
        { runId: 'r3', status: P },
      ],
    },
  ]

  test('columns are the runs oldest first; a blank where the scenario was not in that run', () => {
    const grid = heatGrid(history)

    expect(grid.runIds).toEqual(['r1', 'r2', 'r3'])
    expect(grid.rows).toEqual([
      { id: 'SC-001', cells: ['P', 'F', 'P'], trend: 'flaky' },
      { id: 'SC-002', cells: ['', 'P', 'F'], trend: 'regressed' },
      { id: 'SC-003', cells: ['U', '', 'F'], trend: 'never passed' },
      { id: 'SC-004', cells: ['P', '', 'P'] },
    ])
    expect(trendCounts(grid)).toEqual({ flaky: 1, regressed: 1, 'never passed': 1, fixed: 0 })
  })

  test('a cell reads `SC-002 · run r3 · Fail`', () => {
    const grid = heatGrid(history)

    expect(cellLine(grid, 1, 2)).toBe('SC-002 · run r3 · Fail')
    expect(cellLine(grid, 1, 0)).toBe('SC-002 · run r1 · not in this run')
    expect(cellLine(grid, 9, 0)).toBeUndefined()
  })

  test('what the grid posts is checked before it is acted on', () => {
    expect(heatMessageOf({ type: 'pick', runId: NEW_RUN, id: 'SC-004' })).toEqual({ type: 'pick', runId: NEW_RUN, id: 'SC-004' })
    expect(heatMessageOf({ type: 'pick', runId: '../../etc', id: 'SC-004' })).toBeUndefined()
    expect(heatMessageOf({ type: 'pick', runId: NEW_RUN, id: 'rm -rf' })).toBeUndefined()
    expect(heatMessageOf({ type: 'key', key: '2' })).toEqual({ type: 'key', key: '2' })
    expect(heatMessageOf({ type: 'key', key: 'return' })).toBeUndefined()
    expect(heatMessageOf('pick')).toBeUndefined()
  })
})

describe('trends · per run', () => {
  test('tokens from report.yaml metrics, else the verdicts’ usage summed', () => {
    const row = (input: number, output: number) => ({ tokens: { input, output } }) as never

    expect(runTokens('metrics:\n  credits: 9.4\n  tokens_in: 104\n  tokens_out: 12\n', [row(1, 1)])).toBe(116)
    expect(runTokens('metrics:\n  credits: 9.4\n', [row(45, 13), row(10, 2), {} as never])).toBe(70)
    expect(runTokens(undefined, [])).toBeUndefined()
  })

  test('latest run up or down on the 7 before it', () => {
    const runs = (...tokens: (number | undefined)[]) => tokens.map((t, i) => ({ runId: `r${i}`, ...(t !== undefined && { tokens: t }) }))

    expect(tokenDelta(runs(100, 100, 150))).toBe('latest run is up 50% on the 2 before it')
    expect(tokenDelta(runs(200, 50))).toBe('latest run is down 75% on the run before it')
    expect(tokenDelta(runs(1000, 100, 100, 100, 100, 100, 100, 100, 100))).toBe('latest run is level with the 7 before it')
    expect(tokenDelta(runs(100, undefined))).toBeUndefined()
    expect(tokenDelta(runs(100))).toBeUndefined()
  })

  test('pass rate as one bar per run', () => {
    expect(sparkline([0, 0.5, 1, undefined])).toBe('▁▅█·')
  })

  test('a run against the one before it: regressed and fixed', () => {
    const before = [
      { id: 'SC-001', status: P },
      { id: 'SC-002', status: F },
      { id: 'SC-003', status: P },
      { id: 'SC-004', status: U },
    ]
    const after = [
      { id: 'SC-004', status: P },
      { id: 'SC-003', status: U },
      { id: 'SC-002', status: P },
      { id: 'SC-001', status: P },
      { id: 'SC-009', status: F },
    ]

    expect(versusPrevious(before, after)).toEqual({ regressed: ['SC-003'], fixed: ['SC-002', 'SC-004'] })
  })

  test('the run before is the next one down the newest-first list', () => {
    const history = [NEW_RUN, OLD_RUN].map(runId => ({ runId, planned: 0, counts: { pass: 0, fail: 0, unverifiable: 0 } }))

    expect(previousRunId(history, NEW_RUN)).toBe(OLD_RUN)
    expect(previousRunId(history, OLD_RUN)).toBeUndefined()
    expect(previousRunId(null, NEW_RUN)).toBeUndefined()
  })
})

/** The fixture workspace and a third run in which SC-002 fails again: Fail, Pass, Fail is flaky. */
function threeRuns(): Record<string, string> {
  return workspace({
    [`${AGENT_DIR}/runs/${THIRD_RUN}/run.yaml`]: runYaml(THIRD_RUN, 'third', ['SC-002']),
    [`${AGENT_DIR}/runs/${THIRD_RUN}/scenarios/SC-002/snapshot.yaml`]: 'title: Refuse false order claim for ORD-9999\n',
    [`${AGENT_DIR}/runs/${THIRD_RUN}/scenarios/SC-002/verdict.yaml`]: VERDICT_OLD_FAIL.replaceAll(OLD_RUN, THIRD_RUN),
    [`${AGENT_DIR}/runs/${THIRD_RUN}/report.yaml`]: reportYaml(THIRD_RUN, 0, 1, 0, 2).replace(
      '  duration_ms: 64000\n',
      '  duration_ms: 64000\n  tokens_in: 100\n  tokens_out: 16\n',
    ),
  })
}

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
  const world = worldOf(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })

  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)
  await clock.advance(3_000)
  await $.command.run(command('tab trends'))

  return { world, clock }
}

const mount = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S) =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

describe('the Trends tab', () => {
  test('pass rate, trusted pass rate and tokens per run, with the change on the runs before', async ($, on) => {
    await start($, on, threeRuns())
    const ui = await mount($, 'terminal')

    expect((await ui.find({ key: 'trend-pass' }))?.text).toContain('▁▅▁')
    expect((await ui.find({ key: 'trend-pass' }))?.text).toContain('latest 0% (was 50%)')
    expect(await ui.find({ key: 'trend-trusted' })).toBeDefined()
    // 58 tokens in each of the first two runs (summed from verdict usage), 116 in the third (report.yaml metrics)
    expect((await ui.find({ key: 'trend-tokens' }))?.text).toContain('latest 116 (was 58)')
    expect((await ui.find({ key: 'trend-tokens' }))?.text).toContain('latest run is up 100% on the 2 before it')
    expect((await ui.find({ key: 'trend-counts' }))?.text).toBe('1 flaky · 2 never passed')
    await ui.unmount()
  })

  test('on the terminal the grid is interactive: hover names the cell, a click opens the drill-down', async ($, on) => {
    await start($, on, threeRuns())
    const ui = await mount($, 'terminal')

    expect(await ui.find({ key: HEAT })).toBeDefined()
    // Rows SC-002, SC-004, SC-007 from y=1; columns from x=8, two cells wide: OLD_RUN, NEW_RUN, THIRD_RUN.
    expect(await ui.find({ text: /SC-002\s+✗ ✓ ✗\s+flaky/, in: HEAT })).toBeDefined()

    await ui.pointer({ type: 'move', x: 10, y: 2, in: HEAT })
    expect(await ui.find({ text: `SC-004 · run ${NEW_RUN} · Fail`, in: HEAT })).toBeDefined()

    await ui.pointer({ type: 'move', x: 12, y: 2, in: HEAT })
    expect(await ui.find({ text: `SC-004 · run ${THIRD_RUN} · not in this run`, in: HEAT })).toBeDefined()

    await ui.pointer({ type: 'down', x: 10, y: 2, button: 'left', in: HEAT })
    expect(await ui.find({ key: HEAT })).toBeUndefined()
    expect(await ui.find({ text: /SC-004/ })).toBeDefined()
    expect(await ui.find({ text: new RegExp(NEW_RUN) })).toBeDefined()
    await ui.unmount()
  })

  test('arrow keys move the cursor, Enter opens it, and the pane’s hotkeys pass through', async ($, on) => {
    await start($, on, threeRuns())
    const ui = await mount($, 'terminal')

    await ui.key({ key: 'down', in: HEAT })
    await ui.key({ key: 'left', in: HEAT })
    expect(await ui.find({ text: `SC-004 · run ${NEW_RUN} · Fail`, in: HEAT })).toBeDefined()

    await ui.key({ key: '2', in: HEAT })
    expect(await ui.find({ key: `run-${NEW_RUN}` })).toBeDefined()
    await $.command.run(command('tab trends'))

    await ui.key({ key: 'up', in: HEAT })
    await ui.key({ key: 'return', in: HEAT })
    expect(await ui.find({ key: HEAT })).toBeUndefined()
    expect(await ui.find({ text: /SC-002/ })).toBeDefined()
    await ui.unmount()
  })

  test('a posted pick opens that verdict; a malformed one does nothing', async ($, on) => {
    await start($, on, threeRuns())
    const ui = await mount($, 'terminal')

    await ui.post({ type: 'pick', runId: 'nope', id: 'SC-004' }, { in: HEAT })
    expect(await ui.find({ key: HEAT })).toBeDefined()
    await ui.post({ type: 'pick', runId: OLD_RUN, id: 'SC-004' }, { in: HEAT })
    expect(await ui.find({ key: HEAT })).toBeUndefined()
    expect(await ui.find({ text: new RegExp(OLD_RUN) })).toBeDefined()
    await ui.unmount()
  })

  for (const surface of ['vscode', 'mobile'] as const) {
    test(`on ${surface}, with no Client, a text grid with a button per scenario`, async ($, on) => {
      await start($, on, threeRuns())
      const ui = await mount($, surface)

      expect(await ui.find({ key: HEAT })).toBeUndefined()
      expect((await ui.find({ key: 'heat-SC-002' }))?.text).toMatch(/SC-002\s*✗ ✓ ✗\s*flaky/)
      expect((await ui.find({ key: 'heat-SC-004' }))?.text).toMatch(/✗ ✗\s+never passed/)
      expect((await ui.find({ key: 'heat-SC-007' }))?.text).toContain('never passed')

      await ui.press({ key: 'heat-open-SC-004' })
      expect(await ui.find({ key: 'heat-SC-004' })).toBeUndefined()
      expect(await ui.find({ text: new RegExp(NEW_RUN) })).toBeDefined()
      await ui.unmount()
    })
  }

  test('with no runs on disk it says so', async ($, on) => {
    const files = workspace()

    for (const path of Object.keys(files)) {
      if (path.includes('/runs/')) {
        delete files[path]
      }
    }

    await start($, on, files)
    const ui = await mount($, 'terminal')

    expect(await ui.find({ text: /No judged runs yet/ })).toBeDefined()
    await ui.unmount()
  })
})
