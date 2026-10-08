import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { freshnessText, isStale, isStaleIn, justJudged, liveHeadline, newFailText, nextLive, runBandText } from '../hooks/live'
import type { LiveState } from '../hooks/live'
import type { RookCurrent, RookRunView, RookScenarioRow, RookStale } from '../types'
import { BAND, PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, inFlight, NEW_RUN, reportYaml, runYaml, VERDICT_FAIL, VERDICT_OLD_FAIL, workspace } from './fixtures/workspace'

const PLUGIN = 'rook'
const FRESH = '2026-09-29T09-00-00Z'

const row = (id: string, status: RookScenarioRow['status'], over: Partial<RookScenarioRow> = {}): RookScenarioRow => ({
  id,
  title: `title ${id}`,
  status,
  gaps: [],
  unchecked: [],
  compromised: false,
  summary: '',
  failing: status === 'Fail' ? [{ id: 'C1', criterion: 'c', expected: 'e', achieved: 'a', evidence: '' }] : [],
  ...over,
})

const run = (over: Partial<RookRunView> = {}): RookRunView => ({
  runId: FRESH,
  planned: 4,
  done: 0,
  finished: false,
  counts: { pass: 0, fail: 0, unverifiable: 0 },
  rows: [],
  lanes: [],
  clusters: [],
  next: [],
  ...over,
})

const base = { agentId: 'a', current: [] as RookCurrent[], running: null, isPrimed: true, now: 1_000 }

describe('live · following a run', () => {
  test('the first poll takes what is on disk as known; a later landing is news', () => {
    const done = run({ runId: NEW_RUN, finished: true })
    const first = nextLive(null, { ...base, latest: done, isPrimed: false })

    expect(first.known).toBe(NEW_RUN)
    expect(first.landed).toBeUndefined()
    expect(nextLive(first, { ...base, latest: done })).toBe(first) // nothing changed: the same object

    const landed = nextLive(first, { ...base, latest: run({ finished: true }), now: 5_000 })

    expect(landed.landed).toEqual({ runId: FRESH, at: 5_000, isOwn: false })
  })

  test("verdicts are listed in the order they arrived, newest first", () => {
    let s = nextLive(null, { ...base, latest: run({ rows: [row('SC-002', 'Pass'), row('SC-005', 'Fail')] }) })

    expect(s.judged).toEqual({ runId: FRESH, ids: ['SC-005', 'SC-002'] })
    s = nextLive(s, { ...base, latest: run({ rows: [row('SC-001', 'Pass'), row('SC-002', 'Pass'), row('SC-005', 'Fail')] }) })
    expect(s.judged?.ids).toEqual(['SC-001', 'SC-005', 'SC-002'])
  })

  test('a run this session started is its own, even when it lands right after running clears', () => {
    const running = { startedAt: 0, label: 'all', source: 'pane' as const }
    let s = nextLive(null, { ...base, latest: run({ runId: NEW_RUN, finished: true }), isPrimed: false })

    s = nextLive(s, { ...base, latest: run({ runId: NEW_RUN, finished: true }), running })
    s = nextLive(s, { ...base, latest: run({ finished: true }), now: 2_000 })
    expect(s.landed?.isOwn).toBe(true)
    expect(s.newFail).toBeUndefined()
  })

  test('a run from elsewhere that broke what passed raises the new failures', () => {
    const current: RookCurrent[] = [
      { id: 'SC-002', title: 'Refuse', status: 'Fail', runId: FRESH, was: 'Pass' },
      { id: 'SC-004', title: 'Override', status: 'Fail', runId: FRESH, was: 'Fail' },
    ]
    const s0 = nextLive(null, { ...base, latest: run({ runId: NEW_RUN, finished: true }), isPrimed: false })
    const s = nextLive(s0, { ...base, current, latest: run({ finished: true }) })

    expect(s.newFail).toEqual({ runId: FRESH, rows: [{ id: 'SC-002', title: 'Refuse', status: 'Fail' }] })
    expect(newFailText(s.newFail!)).toBe(`✗ rook · run ${FRESH} from elsewhere · new failure: SC-002 Refuse`)
  })

  test('another agent starts over; a stopped run is not news', () => {
    const s0 = nextLive(null, { ...base, latest: run({ runId: NEW_RUN, finished: true }), isPrimed: false })
    const switched = nextLive(s0, { ...base, agentId: 'b', latest: run({ finished: true }) })

    expect(switched.known).toBe(FRESH)
    expect(switched.landed).toBeUndefined()
    expect(nextLive(s0, { ...base, latest: run({ finished: true, stopped: true }) }).landed).toBeUndefined()
  })
})

describe('live · stale verdicts and rows', () => {
  const stale: RookStale = { files: ['src/tools.mjs'], scenarios: [{ id: 'SC-004', title: '' }], isWholeAgent: false, since: Date.parse('2026-09-29T10:00:00Z') }

  test('isStale: the band set, or every scenario when the whole agent is reached', () => {
    expect(isStale(stale, 'SC-004')).toBe(true)
    expect(isStale(stale, 'SC-002')).toBe(false)
    expect(isStale({ ...stale, isWholeAgent: true }, 'SC-002')).toBe(true)
    expect(isStale(null, 'SC-004')).toBe(false)
    // a verdict from a run started after the edit is fresh
    expect(isStaleIn(stale, 'SC-004', FRESH)).toBe(true)
    expect(isStaleIn(stale, 'SC-004', '2026-09-29T11-00-00Z')).toBe(false)
  })

  test('just judged: newest first, an owner chip for what did not pass, ⧗ for stale', () => {
    const r = run({ rows: [row('SC-002', 'Pass'), row('SC-004', 'Fail'), row('SC-007', 'Unable to Verify')] })
    const live: LiveState = { own: [], judged: { runId: FRESH, ids: ['SC-004', 'SC-002'] } }
    const rows = justJudged({ run: r, live, verdicts: [{ id: 'SC-004', runs: [{ runId: NEW_RUN, status: 'Pass' }, { runId: FRESH, status: 'Fail' }] }], stale })

    expect(rows.map(x => x.id)).toEqual(['SC-007', 'SC-004', 'SC-002'])
    expect(rows.map(x => x.ownerLabel)).toEqual(['judge unsure', 'agent bug', undefined])
    expect(rows.map(x => x.isStale)).toEqual([false, true, false])
    expect(justJudged({ run: r, live: null, verdicts: [], stale: null, limit: 1 }).map(x => x.id)).toEqual(['SC-007'])
  })

  test('headline, band and freshness words', () => {
    const r = run({ done: 2, counts: { pass: 1, fail: 1, unverifiable: 0 }, lanes: [{ id: 'SC-009', title: 't', phase: 'judging', since: 0 }] })
    const running = { startedAt: 10_000, label: 'all', source: 'pane' as const }

    expect(liveHeadline({ run: r, running, isOwn: true, now: 74_000, eta: 90_000 })).toBe('◐ pane 2/4 · 1m04s · ETA ~2m · 1 failing')
    expect(liveHeadline({ running, isOwn: true, now: 12_000 })).toBe('◐ pane starting all · 2s')
    expect(runBandText(r, null, 0)).toBe('◐ rook · 2/4 · SC-009 judging · 1 failing')
    expect(freshnessText(true, 0, 0)).toBe('● live')
    expect(freshnessText(false, 1_000, 13_000)).toBe('updated 12s ago')
  })
})

describe('live · in a session', () => {
  async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
    const world = worldOf(on, files)
    const clock = mock.clock(on, { now: 1_000_000 })

    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.session.start(SESSION)

    return { world, clock }
  }

  const mountPane = ($: Engine) => $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })
  const mountBand = ($: Engine) => $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { ...BAND.props, bodyColumns: 170 }, viewport: BAND.viewport })

  test('a run from elsewhere in flight: above every tab, its lanes and the just-judged rows, each opening the drill-down; no Cancel', async ($, on) => {
    await start($, on, inFlight())
    const ui = await mountPane($)

    expect((await ui.find({ key: 'live-head' }))?.text).toContain('◐ elsewhere 2/3')
    expect((await ui.find({ key: 'live-head' }))?.text).toContain('1 failing')
    expect((await ui.find({ key: 'live-lane-SC-007' }))?.text).toContain('SC-007')
    expect((await ui.find({ key: 'live-judged-SC-004' }))?.text).toMatch(/✗.*SC-004.*\[agent bug\]/)
    expect((await ui.find({ key: 'live-judged-SC-002' }))?.text).toContain('SC-002')
    expect(await ui.find({ key: 'cancel-run' })).toBeUndefined() // not this session's run
    expect(await ui.find({ text: /● live/ })).toBeDefined()

    await ui.press({ key: 'judged-SC-004' })
    expect((await ui.find({ key: 'dd-head' }))?.text).toContain('SC-004')
  })

  test('the band above the prompt follows the run and opens the pane focused', async ($, on) => {
    const { world } = await start($, on, inFlight())
    const band = await mountBand($)

    expect((await band.find({ key: 'run-band' }))?.text).toContain('◐ rook · 2/3 · SC-007 starting · 1 failing')
    expect(await band.find({ key: 'band-cancel' })).toBeUndefined()

    const before = world.opened.length

    await band.press({ key: 'band-open' })
    expect(world.opened.length).toBe(before + 1)
  })

  test('a run started here offers Cancel in the band and in the pane', async ($, on) => {
    const { world, clock } = await start($, on, workspace())
    let release = () => undefined as void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })

    world.during = () => gate
    await $.command.run({ command: 'rook', args: 'run', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } } as never)
    const advancing = clock.advance(10)
    const band = await mountBand($)

    expect((await band.find({ key: 'run-band' }))?.text).toContain('◐ rook · starting all runnable scenarios')
    expect(await band.find({ key: 'band-cancel' })).toBeDefined()
    expect(world.statuses.at(-1)).toBe('◐ /rook starting')

    await band.press({ key: 'band-cancel' })
    await advancing
    expect(world.toasts).toContain('run cancelled')
    release()
  })

  test('a run from elsewhere that lands with a new failure keeps a band until dismissed', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    // SC-002 passed in the newest run; a terminal run fails it.
    world.files.set(`${AGENT_DIR}/runs/${FRESH}/run.yaml`, runYaml(FRESH, 'terminal run', ['SC-002']))
    world.files.set(`${AGENT_DIR}/runs/${FRESH}/scenarios/SC-002/verdict.yaml`, VERDICT_OLD_FAIL.replaceAll('2026-09-28T15-31-14Z', FRESH))
    world.files.set(`${AGENT_DIR}/runs/${FRESH}/report.yaml`, reportYaml(FRESH, 0, 1, 0, 2))
    await clock.advance(3_000)

    const band = await mountBand($)

    expect((await band.find({ key: 'newfail-band' }))?.text).toContain(`run ${FRESH} from elsewhere · new failure: SC-002`)
    expect(world.statuses.at(-1)).toBe('✗ 0/1 <1m ago · new ✗ SC-002')

    await clock.advance(3_000)
    expect(await band.find({ key: 'newfail-band' })).toBeDefined() // stays across polls

    await band.press({ key: 'newfail-dismiss' })
    expect(await band.find({ key: 'newfail-band' })).toBeUndefined()

    // ten minutes on, the line is idle again
    await clock.advance(11 * 60_000)
    expect(world.statuses.at(-1)).toMatch(/^✓\d ✗\d \?\d \d+%/)
  })

  test("a run this session started that regresses something raises no band (the tool's own result says so)", async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.onRun = () => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, run_id: FRESH }),
      writes: {
        [`${AGENT_DIR}/runs/${FRESH}/run.yaml`]: runYaml(FRESH, 'here', ['SC-002']),
        [`${AGENT_DIR}/runs/${FRESH}/scenarios/SC-002/verdict.yaml`]: VERDICT_FAIL.replace('SC-004', 'SC-002'),
        [`${AGENT_DIR}/runs/${FRESH}/report.yaml`]: reportYaml(FRESH, 0, 1, 0, 2),
      },
    })
    await $.command.run({ command: 'rook', args: 'run --only SC-002', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } } as never)
    await clock.advance(10)
    await clock.advance(3_000)

    expect(await $.ui.render(BAND)).not.toMatchObject({ type: 'Box' })
    expect(world.statuses.at(-1)).toBe('✗ 0/1 <1m ago · new ✗ SC-002')
  })

  test('idle, the pane header says how fresh the snapshot is', async ($, on) => {
    const { clock } = await start($, on, workspace())
    const ui = await mountPane($)

    expect(await ui.find({ text: /updated \d+s ago/ })).toBeDefined()
    expect(await ui.find({ key: 'live' })).toBeUndefined()
    await clock.advance(1)
  })
})
