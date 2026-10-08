import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { comparePair, compareText, deltaLine, diffRuns, ordered } from '../hooks/history'
import { runLine } from '../hooks/views/runs'
import type { RookStatus } from '../types'
import { command, PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, NEW_RUN, OLD_RUN, reportYaml, runYaml, VERDICT_FAIL, VERDICT_PASS_GAP, workspace } from './fixtures/workspace'

const PLUGIN = 'rook'
const SURFACES = ['terminal', 'desktop'] as const
const FRESH_RUN = '2026-09-29T09-00-00Z'

type Ran = { result?: unknown; deny?: string; text?: string }

const asText = (ran: Ran): string => (typeof ran.result === 'string' ? ran.result : (ran.deny ?? ran.text ?? JSON.stringify(ran)))

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
  const world = worldOf(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })

  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return { world, clock }
}

const side = (runId: string, rows: [string, RookStatus][], extra: { passRate?: number; credits?: number } = {}) => {
  const counts = {
    pass: rows.filter(([, s]) => s === 'Pass').length,
    fail: rows.filter(([, s]) => s === 'Fail').length,
    unverifiable: rows.filter(([, s]) => s === 'Unable to Verify').length,
  }

  return { runId, counts, finished: true, rows: rows.map(([id, status]) => ({ id, title: `title ${id}`, status })), ...extra }
}

describe('history · the diff', () => {
  test('sorts every scenario into fixed, regressed, new, missing, still failing', () => {
    const base = side('2026-09-01T00-00-00Z', [
      ['SC-001', 'Fail'],
      ['SC-002', 'Unable to Verify'],
      ['SC-003', 'Pass'],
      ['SC-004', 'Pass'],
      ['SC-005', 'Fail'],
      ['SC-006', 'Pass'],
    ], { passRate: 0.5, credits: 10 })
    const head = side('2026-09-02T00-00-00Z', [
      ['SC-001', 'Pass'],
      ['SC-002', 'Pass'],
      ['SC-003', 'Fail'],
      ['SC-004', 'Unable to Verify'],
      ['SC-005', 'Unable to Verify'],
      ['SC-007', 'Pass'],
    ], { passRate: 0.75, credits: 12.5 })
    const diff = diffRuns(base, head)

    expect(diff.fixed.map(row => row.id)).toEqual(['SC-001', 'SC-002'])
    expect(diff.regressed.map(row => row.id)).toEqual(['SC-003', 'SC-004'])
    expect(diff.added).toEqual([{ id: 'SC-007', title: 'title SC-007', head: 'Pass' }])
    expect(diff.missing).toEqual([{ id: 'SC-006', title: 'title SC-006', base: 'Pass' }])
    expect(diff.stillFailing).toEqual([{ id: 'SC-005', title: 'title SC-005', base: 'Fail', head: 'Unable to Verify' }])
    expect(diff.stillPassing).toBe(0)
    expect(diff.delta).toEqual({ pass: 0, fail: -1, unverifiable: 1, passRate: 0.25, credits: 2.5 })
    expect(deltaLine(diff)).toBe('Pass 0 · Fail -1 · Unable to Verify +1 · pass rate 50% → 75% (+25 pts) · credits +2.5')
  })

  test('no pass-rate or credits delta when either side lacks it', () => {
    const diff = diffRuns(side('a', [['SC-001', 'Pass']]), side('b', [['SC-001', 'Pass']], { credits: 3 }))

    expect(diff.delta).toEqual({ pass: 0, fail: 0, unverifiable: 0 })
    expect(diff.stillPassing).toBe(1)
  })

  test('which two runs a compare means', () => {
    const ids = ['2026-09-03T00-00-00Z', '2026-09-02T00-00-00Z', '2026-09-01T00-00-00Z']

    expect(comparePair(ids)).toEqual({ base: ids[1], head: ids[0] })
    expect(comparePair(ids, ids[2])).toEqual({ base: ids[2], head: ids[0] })
    expect(comparePair(ids, undefined, ids[1])).toEqual({ base: ids[2], head: ids[1] })
    expect(comparePair(ids, ids[0], ids[2])).toEqual({ base: ids[0], head: ids[2] })
    expect(comparePair(ids, ids[0], ids[0])).toEqual({ error: 'pick two different runs.' })
    expect(comparePair(ids, '2026-01-01T00-00-00Z')).toEqual({ error: 'no run 2026-01-01T00-00-00Z for this agent.' })
    expect(comparePair(ids.slice(0, 1))).toEqual({ error: 'comparing needs two runs; this agent has fewer.' })
    expect(ordered(ids[0]!, ids[2]!)).toEqual([ids[2], ids[0]])
  })

  test('the text names each section and leaves out the empty ones', () => {
    const text = compareText('bot', diffRuns(side('a', [['SC-001', 'Fail']]), side('b', [['SC-001', 'Pass']])))

    expect(text).toContain('Fixed (Fail or Unable to Verify → Pass) (1):\n  SC-001 — title SC-001 (Fail → Pass)')
    expect(text).not.toContain('Regressed')
    expect(text).toContain('0 still passing.')
  })

  test('a list row: name and id, when, counts, pass rate, credits, duration, test', () => {
    expect(
      runLine({ runId: NEW_RUN, name: 'nightly', created: '2026-09-28T15:49:02.767Z', planned: 3, counts: { pass: 1, fail: 1, unverifiable: 1 }, passRate: 0.5, credits: 12.5, durationMs: 64_000, isTest: true }),
    ).toBe(`nightly (${NEW_RUN}) · 2026-09-28 15:49 · ✓1 ✗1 ?1 · 50% · 12.5 credits · 1m04s · test`)
    expect(runLine({ runId: NEW_RUN, planned: 0, counts: { pass: 0, fail: 0, unverifiable: 0 } })).toBe(`${NEW_RUN} · 2026-09-28 15:48 · ✓0 ✗0 ?0`)
  })
})

describe('/rook compare and the compare tool', () => {
  test('/rook compare defaults to the two newest finished runs', async ($, on) => {
    await start($, on, workspace())
    const text = (await $.command.run(command('compare'))).text ?? ''

    expect(text).toContain(`base ${OLD_RUN} "baseline": 0 Pass · 2 Fail · 0 Unable to Verify · pass rate 0% · 3 credits · 1m04s`)
    expect(text).toContain(`head ${NEW_RUN} "hardened adversarial matrix": 1 Pass · 1 Fail · 1 Unable to Verify · pass rate 50% · 12.5 credits`)
    expect(text).toContain('Change: Pass +1 · Fail -1 · Unable to Verify +1 · pass rate 0% → 50% (+50 pts) · credits +9.5')
    expect(text).toContain('Fixed (Fail or Unable to Verify → Pass) (1):\n  SC-002 — Refuse false order claim for ORD-9999 (Fail → Pass)')
    expect(text).toContain('New in head (1):\n  SC-007')
    expect(text).toContain('Still failing (1):\n  SC-004')
  })

  test('/rook compare refuses what is not a run id or not a run', async ($, on) => {
    await start($, on, workspace())

    expect((await $.command.run(command('compare nope'))).text).toContain('"nope" is not a run id')
    expect((await $.command.run(command('compare 2026-01-01T00-00-00Z'))).text).toBe('no run 2026-01-01T00-00-00Z for this agent.')
  })

  test('the tool takes base and head, reads disk only, and the reversed order shows a regression', async ($, on) => {
    const { world } = await start($, on, workspace())
    const before = world.invocations.length
    const ran = (await $.tool.call({ tool: 'mcp__rook__compare', base: NEW_RUN, head: OLD_RUN } as never)) as Ran

    expect(asText(ran)).toContain('Regressed (Pass → Fail or Unable to Verify) (1):\n  SC-002')
    expect(asText(ran)).toContain('Missing from head (1):\n  SC-007')
    expect(world.invocations.length).toBe(before)

    expect(asText((await $.tool.call({ tool: 'mcp__rook__compare' } as never)) as Ran)).toContain(`head ${NEW_RUN}`)
  })
})

describe('the Runs tab', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: list, open a run, report it, pick two and see the diff`, async ($, on) => {
      const { world } = await start($, on, workspace())
      await $.command.run(command('tab runs'))
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

      expect((await ui.find({ key: `run-${NEW_RUN}` }))?.text).toContain('hardened adversarial matrix')
      expect((await ui.find({ key: `run-${NEW_RUN}` }))?.text).toContain('✓1 ✗1 ?1 · 50% · 12.5 credits · 1m04s')
      expect((await ui.find({ key: `run-${OLD_RUN}` }))?.text).toContain('✓0 ✗2 ?0')

      await ui.press({ key: `run-${NEW_RUN}` })
      expect(await ui.find({ text: /Refund guardrail broke/ })).toBeDefined()
      expect(await ui.find({ text: /0 clusters/ })).toBeDefined()
      expect(await ui.find({ key: 'run-explain' })).toBeDefined()

      await ui.press({ key: 'run-report' })
      expect(world.submitted.at(-1)).toContain(`rook run ${NEW_RUN}`)
      expect(world.submitted.at(-1)).toContain('SC-004')

      // a pick can be cancelled back to the opened run
      await ui.press({ key: 'run-compare' })
      await ui.press({ key: 'pick-cancel' })
      expect(await ui.find({ key: 'run-report' })).toBeDefined()

      await ui.press({ key: 'run-compare' })
      expect(await ui.find({ text: new RegExp(`Compare ${NEW_RUN} with`) })).toBeDefined()
      await ui.press({ key: `run-${OLD_RUN}` })

      expect(await ui.find({ text: /Fail -1/ })).toBeDefined()
      expect(await ui.find({ key: 'cmp-fixed-SC-002' })).toBeDefined()
      expect(await ui.find({ key: 'cmp-still-SC-004' })).toBeDefined()
      expect(await ui.find({ key: 'cmp-added-SC-007' })).toBeDefined()
      expect(await ui.find({ key: 'cmp-regressed' })).toBeUndefined()

      await ui.press({ key: 'cmp-back' })
      expect(await ui.find({ key: `run-${OLD_RUN}` })).toBeDefined()
      await ui.unmount()
    })
  }

  test('a run that finishes during the session joins the list on the next poll', async ($, on) => {
    const { world, clock } = await start($, on, workspace())
    await $.command.run(command('tab runs'))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ key: `run-${FRESH_RUN}` })).toBeUndefined()
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/run.yaml`, runYaml(FRESH_RUN, 'fresh', ['SC-002', 'SC-004']))
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/scenarios/SC-002/verdict.yaml`, VERDICT_PASS_GAP)
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/scenarios/SC-004/verdict.yaml`, VERDICT_FAIL)
    await clock.advance(3_000)
    expect(await ui.find({ key: `run-${FRESH_RUN}` })).toBeUndefined() // not finished yet

    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/report.yaml`, reportYaml(FRESH_RUN, 1, 1, 0, 2))
    await clock.advance(3_000)
    expect((await ui.find({ key: `run-${FRESH_RUN}` }))?.text).toContain('fresh')
    await ui.unmount()
  })
})
