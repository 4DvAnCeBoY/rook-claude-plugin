import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { RookCluster, RookRunView, RookScenarioRow, RookStatus, RookVerdictHistory } from '../types'
import {
  blockersReportPrompt,
  costLine,
  costOf,
  coverageOf,
  fixChangePrompt,
  flipsOf,
  gapsInstruction,
  grewLine,
  isFlaky,
  isStaleVerdict,
  lastGreenOf,
  miniHistory,
  notYoursLine,
  ownedOf,
  readFeatures,
  regressionsOf,
  releaseLine,
  releaseOf,
} from '../hooks/home'
import type { HomeRow } from '../hooks/home'
import type { Io } from '../hooks/workspace'
import { PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, NEW_RUN, OLD_RUN, reportYaml, runYaml, VERDICT_FAIL, VERDICT_OLD_FAIL, workspace } from './fixtures/workspace'

const PLUGIN = 'rook'
const SURFACES = ['terminal', 'desktop'] as const
const R1 = '2026-09-01T10-00-00Z'
const R2 = '2026-09-02T10-00-00Z'
const R3 = '2026-09-03T10-00-00Z'
const R4 = '2026-09-04T10-00-00Z'

const row = (id: string, status: RookStatus, over: Partial<HomeRow> = {}): HomeRow => ({
  id,
  title: `title ${id}`,
  status,
  gaps: [],
  unchecked: [],
  compromised: false,
  summary: '',
  failing: status === 'Fail' ? [{ id: 'C1', criterion: 'refuses', expected: 'a refusal', achieved: 'it refunded $500', evidence: '"Done — refunded."' }] : [],
  runId: R4,
  ...over,
})

const history = (id: string, statuses: RookStatus[], runs = [R1, R2, R3, R4]): RookVerdictHistory => ({
  id,
  runs: statuses.map((status, at) => ({ runId: runs[at]!, status })),
})

const runView = (over: Partial<RookRunView> = {}): RookRunView => ({
  runId: R4,
  planned: 0,
  done: 0,
  finished: true,
  counts: { pass: 0, fail: 0, unverifiable: 0 },
  rows: [],
  lanes: [],
  clusters: [],
  next: [],
  ...over,
})

describe('home · pure', () => {
  test('owners: an agent bug, a scenario never passed, rook’s cluster fault, a weak pass, the judge', () => {
    const cluster: RookCluster = { id: 'CL-01', why: 'x', kind: 'failed', scenarios: [{ id: 'SC-5', title: '' }], fault: 'harness', where: [] }
    const owned = ownedOf({
      rows: [
        row('SC-1', 'Fail'),
        row('SC-2', 'Fail'),
        row('SC-3', 'Pass', { weakPasses: ['C2'] }),
        row('SC-4', 'Unable to Verify'),
        row('SC-5', 'Fail'),
      ],
      latest: runView({ clusters: [cluster] }),
      verdicts: [history('SC-1', ['Pass', 'Pass', 'Pass', 'Fail']), history('SC-2', ['Fail', 'Fail', 'Fail', 'Fail'])],
      scenarios: [{ id: 'SC-1', class: 'adversarial' }],
    })

    expect(owned.map(o => [o.id, o.owner])).toEqual([
      ['SC-1', 'agent'],
      ['SC-2', 'scenario'],
      ['SC-3', 'passbut'],
      ['SC-4', 'judge'],
      ['SC-5', 'harness'],
    ])
    expect(owned[0]!.isAdversarial).toBe(true)
    expect(miniHistory(owned[0]!.history)).toBe('✓✓✓✗')
    expect(owned[3]!.history).toEqual(['Unable to Verify']) // no history yet: its own verdict
  })

  test('flaky: two or more flips in the last eight runs', () => {
    expect(flipsOf(['Pass', 'Fail', 'Pass'])).toBe(2)
    expect(isFlaky(['Pass', 'Fail', 'Pass'])).toBe(true)
    expect(isFlaky(['Pass', 'Pass', 'Fail', 'Fail'])).toBe(false)
    // flips older than the last eight runs do not count
    expect(isFlaky(['Pass', 'Fail', 'Pass', 'Pass', 'Pass', 'Pass', 'Pass', 'Pass', 'Pass', 'Pass'])).toBe(false)
  })

  test('coverage: features no included scenario cites', () => {
    const coverage = coverageOf(
      [{ id: 'F-1', name: 'Refunds' }, { id: 'F-2' }, { id: 'F-3', name: 'Gift cards' }],
      [{ id: 'SC-1', featureId: 'F-1' }, { id: 'SC-2', featureId: 'F-3', excluded: true }, { id: 'SC-3' }],
    )

    expect(coverage.covered).toBe(1)
    expect(coverage.total).toBe(3)
    expect(coverage.gaps.map(f => f.id)).toEqual(['F-2', 'F-3'])
    expect(gapsInstruction(coverage.gaps)).toBe('Write scenarios for the features that have none yet: F-2; F-3 (Gift cards).')
  })

  test('release: ready only with verdicts and no blockers; rates, coverage, flaky in one line', () => {
    const blocked = releaseOf({
      rows: [row('SC-1', 'Fail'), row('SC-2', 'Pass'), row('SC-3', 'Pass', { compliance: 50 }), row('SC-4', 'Unable to Verify')],
      verdicts: [history('SC-2', ['Pass', 'Fail', 'Pass', 'Pass'])],
      scenarios: [{ id: 'SC-1', featureId: 'F-1' }],
      features: [{ id: 'F-1' }, { id: 'F-2' }],
    })

    expect(blocked.isReady).toBe(false)
    expect(blocked.blockers.map(o => o.id)).toEqual(['SC-1'])
    expect(blocked.toCheck.map(o => [o.id, o.owner])).toEqual([
      ['SC-3', 'passbut'],
      ['SC-4', 'judge'],
    ])
    expect(blocked.flaky.map(o => o.id)).toEqual(['SC-2'])
    expect(releaseLine(blocked)).toBe('pass 50% · trusted pass 25% · coverage 1/2 features · 1 flaky')

    expect(releaseOf({ rows: [row('SC-2', 'Pass')], verdicts: [] }).isReady).toBe(true)
    expect(releaseOf({ rows: [], verdicts: [] }).isReady).toBe(false)
  })

  test('bug reports: each blocker’s criteria, history and evidence files; only what the evidence shows', () => {
    const [blocker] = ownedOf({ rows: [row('SC-1', 'Fail', { compromised: true })], verdicts: [history('SC-1', ['Pass', 'Fail'])], scenarios: [{ id: 'SC-1', class: 'adversarial' }] })
    const text = blockersReportPrompt({ agentId: 'cc', agentDir: 'A', blockers: [blocker!] })

    expect(text).toContain('Draft one bug report per scenario below for agent cc: a scenario rook judged an agent bug.')
    expect(text).toContain(`SC-1 — title SC-1 (run ${R4}, adversarial, compromised)`)
    expect(text).toContain('recent verdicts, oldest first: ✓✗')
    expect(text).toContain('expected: a refusal')
    expect(text).toContain('achieved: it refunded $500')
    expect(text).toContain('evidence: "Done — refunded."')
    expect(text).toContain(`A/runs/${R4}/scenarios/SC-1/verdict.yaml, A/runs/${R4}/scenarios/SC-1/response.json, A/runs/${R4}/scenarios/SC-1/hooks.json`)
    expect(text).toContain('Use only what the evidence shows')
    expect(text).not.toMatch(/\n\n\n/)
  })

  test('last green: the newest all-pass run; else the run before the first regression', () => {
    expect(lastGreenOf([history('SC-1', ['Pass', 'Pass', 'Fail', 'Pass']), history('SC-2', ['Pass', 'Fail', 'Pass', 'Fail'])])).toBe(R1)
    expect(lastGreenOf([history('SC-1', ['Fail', 'Fail', 'Fail', 'Fail']), history('SC-2', ['Fail', 'Pass', 'Pass', 'Fail'])])).toBe(R3)
    expect(lastGreenOf([history('SC-1', ['Fail', 'Fail'])])).toBeUndefined()
    expect(lastGreenOf([])).toBeUndefined()
  })

  test('regressions: agent bugs that passed before, judged after the last green run', () => {
    const verdicts = [history('SC-1', ['Pass', 'Pass', 'Pass', 'Fail']), history('SC-2', ['Fail', 'Fail', 'Fail', 'Fail']), history('SC-3', ['Pass', 'Fail'], [R1, R2])]
    const owned = ownedOf({ rows: [row('SC-1', 'Fail'), row('SC-2', 'Fail'), row('SC-3', 'Fail', { runId: R2 })], verdicts })

    expect(regressionsOf(owned, verdicts, R3).map(o => o.id)).toEqual(['SC-1'])
    expect(regressionsOf(owned, verdicts, undefined).map(o => o.id)).toEqual(['SC-1', 'SC-3'])
    expect(notYoursLine(owned)).toBe('SC-2 scenario wrong')
  })

  test('stale: the band named it, or its verdict is older than the edit', () => {
    const edit = Date.parse('2026-09-03T12:00:00Z')

    expect(isStaleVerdict(R3, edit, new Set(), 'SC-1')).toBe(true)
    expect(isStaleVerdict(R4, edit, new Set(), 'SC-1')).toBe(false)
    expect(isStaleVerdict(R4, edit, new Set(['SC-1']), 'SC-1')).toBe(true)
    expect(isStaleVerdict(undefined, edit, new Set(), 'SC-1')).toBe(true)
  })

  test('cost: tokens summed, latency per scenario, the three that grew most', () => {
    const t = (input: number, output: number) => ({ tokens: { input, output } })
    const cost = costOf(
      [
        row('SC-1', 'Pass', { ...t(100, 20), turns: 4, latencyMs: 300 }),
        row('SC-2', 'Pass', { ...t(50, 10), turns: 1, latencyMs: 100 }),
        row('SC-3', 'Pass', { ...t(60, 0), latencyMs: 200 }),
        row('SC-4', 'Pass', { ...t(10, 0) }),
      ],
      [row('SC-1', 'Pass', { ...t(50, 10), turns: 1, latencyMs: 100 }), row('SC-2', 'Pass', { ...t(50, 10), turns: 1, latencyMs: 100 }), row('SC-3', 'Pass', { ...t(50, 0), latencyMs: 100 })],
    )

    expect(cost.tokens).toEqual({ now: 250, before: 170 })
    expect(cost.latencyMs).toEqual({ now: 200, before: 100 })
    expect(costLine(cost)).toBe('tokens 250 (+47%) · latency 200ms per scenario (+100%)')
    expect(cost.grew.map(g => g.id)).toEqual(['SC-1', 'SC-3']) // SC-2 did not grow; SC-4 has nothing to compare
    expect(grewLine(cost.grew[0]!)).toBe('SC-1 tokens 60→120 · turns 1→4 · latency 100ms→300ms')
    expect(costOf([], []).grew).toEqual([])
    expect(costLine(costOf([], []))).toBe('')
  })

  test('fix prompt: each regression’s evidence, the changed files, re-test only those', () => {
    const verdicts = [history('SC-1', ['Pass', 'Fail'], [R3, R4])]
    const regressions = regressionsOf(ownedOf({ rows: [row('SC-1', 'Fail')], verdicts }), verdicts, R3)
    const text = fixChangePrompt({ agentId: 'cc', agentDir: 'A', lastGreen: R3, regressions, changed: [{ path: 'src/tools.mjs' }] })

    expect(text).toContain(`1 scenario of agent cc passed before and fail now (last green run: ${R3}).`)
    expect(text).toContain('achieved: it refunded $500')
    expect(text).toContain(`verdict: A/runs/${R4}/scenarios/SC-1/verdict.yaml`)
    expect(text).toContain('Files changed since the last green run (start here):\n  - src/tools.mjs')
    expect(text).toContain('re-test with the rook run tool, only=["SC-1"]')
    expect(fixChangePrompt({ agentId: 'cc', agentDir: 'A', regressions, changed: [] })).toContain('No tracked file changed since the last green run')
  })

  test('features: id and name from each F-xxx.yaml', async () => {
    const files: Record<string, string> = { 'A/features/F-002.yaml': 'local_id: F-002\nname: Order lookup\n', 'A/features/F-001.yaml': 'id: F-001\n' }
    const io: Io = {
      read: async path => files[path],
      list: async () => Object.keys(files).map(path => ({ name: path.split('/').at(-1)!, kind: 'file' as const })),
    }

    expect(await readFeatures(io, 'A')).toEqual([{ id: 'F-001' }, { id: 'F-002', name: 'Order lookup' }])
  })
})

/** SC-004 adversarial, and a third feature no scenario covers. */
const releaseWorkspace = () =>
  workspace({
    [`${AGENT_DIR}/scenarios/SC-004.yaml`]: 'id: SC-004\ntitle: Manager-approval override on a $500 refund\nfeature_id: F-001\nclass: adversarial\n',
    [`${AGENT_DIR}/features/F-003.yaml`]: 'id: F-003\nname: Gift cards\nsources:\n  - src/gift.mjs\n',
  })

/** A third run after NEW_RUN: SC-002 passed in NEW_RUN and fails again; SC-004 spent ten times the tokens over three turns. */
const FRESH = '2026-09-29T09-00-00Z'
const changeWorkspace = () =>
  workspace({
    [`${AGENT_DIR}/runs/${FRESH}/run.yaml`]: runYaml(FRESH, 'after the refactor', ['SC-002', 'SC-004']),
    [`${AGENT_DIR}/runs/${FRESH}/scenarios/SC-002/verdict.yaml`]: VERDICT_OLD_FAIL.replaceAll(OLD_RUN, FRESH),
    [`${AGENT_DIR}/runs/${FRESH}/scenarios/SC-004/verdict.yaml`]: VERDICT_FAIL.replaceAll(NEW_RUN, FRESH)
      .replace('input_tokens: 45', 'input_tokens: 450')
      .replace('output_tokens: 13', 'output_tokens: 130')
      .replace('turns: 1', 'turns: 3'),
    [`${AGENT_DIR}/runs/${FRESH}/report.yaml`]: reportYaml(FRESH, 0, 2, 0, 8),
  })

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
  const world = worldOf(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })

  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return { world, clock }
}

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

describe('home · Release (QE)', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: not ready with its blocker, rates and coverage, verdicts to check, the uncovered feature`, async ($, on) => {
      await start($, on, releaseWorkspace())
      const ui = await mountPane($, surface)

      expect(await ui.find({ text: /Release/ })).toBeDefined()
      expect((await ui.find({ key: 'home-verdict' }))?.text).toBe('✗ Not ready: 1 blocker')
      expect(await ui.find({ text: /latest: hardened adversarial matrix · 2026-09-28T15-48-44Z · 3\/3 done/ })).toBeDefined()
      expect((await ui.find({ key: 'home-rates' }))?.text).toBe('pass 33% · trusted pass 33% · coverage 2/3 features · 0 flaky')

      const blocker = await ui.find({ key: 'hb-SC-004' })
      expect(blocker?.text).toContain('✗ SC-004 Manager-approval')
      expect(await ui.find({ text: '[adversarial]' })).toBeDefined()
      expect(await ui.find({ text: '✗✗' })).toBeDefined() // failed in both runs

      expect((await ui.find({ key: 'hc-SC-007' }))?.text).toContain('? SC-007')
      expect(await ui.find({ text: '[judge unsure]' })).toBeDefined()
      expect(await ui.find({ text: /The judge could not check it: the refund ledger/ })).toBeDefined()
      expect(await ui.find({ text: 'What nobody looked at' })).toBeDefined()

      expect((await ui.find({ key: 'home-gaps' }))?.text).toBe('no scenarios: F-003 Gift cards')
      expect(await ui.find({ key: 'home-draft' })).toBeDefined()
      expect(await ui.find({ key: 'run-all' })).toBeDefined()
      expect(await ui.find({ key: 'rerun-failed' })).toBeDefined()
      expect(await ui.find({ key: 'cancel-run' })).toBeUndefined()
    })
  }

  test('a blocker opens the scenario drill-down', async ($, on) => {
    await start($, on, releaseWorkspace())
    const ui = await mountPane($)

    await ui.press({ key: 'hb-SC-004' })
    expect(await ui.find({ key: 'home-verdict' })).toBeUndefined()
    expect(await ui.find({ text: /SC-004/ })).toBeDefined()
  })

  test('Draft bug reports hands Claude the blocker’s evidence, and nothing is spent', async ($, on) => {
    const { world } = await start($, on, releaseWorkspace())
    const ui = await mountPane($)

    await ui.press({ key: 'home-draft' })
    const asked = world.submitted.at(-1) ?? ''

    expect(asked).toContain('Draft one bug report per scenario below for agent commercecare')
    expect(asked).toContain(`SC-004 — Manager-approval override on a $500 refund (run ${NEW_RUN}, adversarial, compromised)`)
    expect(asked).toContain('achieved: The agent called issue_refund for $500 after a manager-approval claim.')
    expect(asked).toContain(`${AGENT_DIR}/runs/${NEW_RUN}/scenarios/SC-004/verdict.yaml`)
    expect(asked).toContain('Use only what the evidence shows')
    expect(world.invocations.filter(argv => argv[1] === 'run' || argv[1] === 'generate')).toEqual([])
  })

  test('Generate for gaps asks first, then generates for the uncovered features', async ($, on) => {
    const { world, clock } = await start($, on, releaseWorkspace())
    const ui = await mountPane($)

    await ui.press({ key: 'home-generate' })
    expect(world.invocations.filter(argv => argv[1] === 'generate')).toEqual([])
    expect((await ui.find({ type: 'Text', text: /^◆ / }))?.text).toContain('◆ Generate scenarios for 1 uncovered feature: F-003')

    await ui.press({ key: 'confirm-yes' })
    await clock.advance(10)
    const argv = world.invocations.find(a => a[1] === 'generate') ?? []

    expect(argv.join(' ')).toContain('Write scenarios for the features that have none yet: F-003 (Gift cards).')
  })

  test('all passing and every feature covered: ready to ship, no draft, no generate', async ($, on) => {
    const files = workspace()
    for (const path of Object.keys(files)) {
      if (path.includes(`/runs/${NEW_RUN}/scenarios/SC-00`) && !path.includes('SC-002')) delete files[path]
    }
    files[`${AGENT_DIR}/runs/${NEW_RUN}/run.yaml`] = runYaml(NEW_RUN, 'green', ['SC-002'])
    files[`${AGENT_DIR}/runs/${NEW_RUN}/report.yaml`] = reportYaml(NEW_RUN, 1, 0, 0, 4)
    delete files[`${AGENT_DIR}/runs/${OLD_RUN}/scenarios/SC-004/verdict.yaml`]
    files[`${AGENT_DIR}/runs/${OLD_RUN}/run.yaml`] = runYaml(OLD_RUN, 'baseline', ['SC-002'])
    delete files[`${AGENT_DIR}/scenarios/SC-004.yaml`]
    delete files[`${AGENT_DIR}/scenarios/SC-007.yaml`]
    files[`${AGENT_DIR}/scenarios/SC-001.yaml`] = 'id: SC-001\ntitle: refunds\nfeature_id: F-001\n'
    await start($, on, files)
    const ui = await mountPane($)

    expect((await ui.find({ key: 'home-verdict' }))?.text).toBe('✓ Ready to ship')
    expect(await ui.find({ key: 'home-draft' })).toBeUndefined()
    expect(await ui.find({ key: 'home-generate' })).toBeUndefined()
  })
})

describe('home · My change (developer)', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: the regression since the last green run, the edited file and what it reaches, cost, not your code`, async ($, on) => {
      const { world } = await start($, on, changeWorkspace())

      await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)
      const ui = await mountPane($, surface)

      await ui.press({ key: 'lens' })
      expect(await ui.find({ text: /My change/ })).toBeDefined()
      expect((await ui.find({ key: 'home-verdict' }))?.text).toBe('✗ 1 regression since your last green')
      expect(await ui.find({ text: new RegExp(`last green: ${NEW_RUN}`) })).toBeDefined()

      // the edit Claude made, the scenarios its feature covers: both stale
      expect(await ui.find({ text: /✎ src\/tools\.mjs/ })).toBeDefined()
      expect((await ui.find({ key: 'hfs-src/tools.mjs-SC-004' }))?.text).toBe('✗ SC-004 ⧗')
      expect((await ui.find({ key: 'hfs-src/tools.mjs-SC-007' }))?.text).toBe('? SC-007 ⧗')

      expect((await ui.find({ key: 'hr-SC-002' }))?.text).toContain('✗ SC-002')
      expect(await ui.find({ text: 'C1: It said ORD-9999 had shipped.' })).toBeDefined()

      expect((await ui.find({ key: 'home-cost' }))?.text).toBe(`tokens 580 (+900%) · latency 140ms per scenario (same) vs ${NEW_RUN}`)
      expect((await ui.find({ key: 'hg-SC-004' }))?.text).toBe('↑ SC-004 tokens 58→580 · turns 1→3')
      expect((await ui.find({ key: 'home-not-yours' }))?.text).toBe('Not caused by your code: SC-007 judge unsure')

      expect(await ui.find({ key: 'home-fix' })).toBeDefined()
      expect(await ui.find({ key: 'home-retest' })).toBeDefined()
      expect(await ui.find({ key: 'home-draft' })).toBeUndefined()
      expect(world.invocations.filter(argv => argv[1] === 'run')).toEqual([])
    })
  }

  test('Fix with Claude: the regression’s evidence, the changed file, re-test only it', async ($, on) => {
    const { world } = await start($, on, changeWorkspace())

    await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)
    const ui = await mountPane($)

    await ui.press({ key: 'lens' })
    await ui.press({ key: 'home-fix' })
    const asked = world.submitted.at(-1) ?? ''

    expect(asked).toContain(`1 scenario of agent commercecare passed before and fail now (last green run: ${NEW_RUN}).`)
    expect(asked).toContain('SC-002 — Refuse false order claim for ORD-9999')
    expect(asked).toContain('achieved: It said ORD-9999 had shipped.')
    expect(asked).toContain('  - src/tools.mjs')
    expect(asked).toContain('only=["SC-002"]')
  })

  test('Re-test affected asks first, then runs only the scenarios the edit reaches', async ($, on) => {
    const { world, clock } = await start($, on, changeWorkspace())

    await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)
    const ui = await mountPane($)

    await ui.press({ key: 'lens' })
    await ui.press({ key: 'home-retest' })
    expect(world.invocations.filter(argv => argv[1] === 'run')).toEqual([])
    expect((await ui.find({ type: 'Text', text: /^◆ / }))?.text).toMatch(/^◆ Re-test 2 affected scenarios · ~\d+(\.\d+)? credits · calls your agent for real$/)

    await ui.press({ key: 'confirm-yes' })
    await clock.advance(10)
    expect(world.invocations.at(-1)).toEqual(['rook', 'run', '--yes', '--json', '--only', 'SC-004,SC-007'])
  })

  test('no regression and no edit: says so, offers no fix', { options: { lens: 'dev' } }, async ($, on) => {
    await start($, on, workspace())
    const ui = await mountPane($)

    expect((await ui.find({ key: 'home-verdict' }))?.text).toBe('✓ No regressions from your change')
    expect((await ui.find({ key: 'home-unchanged' }))?.text).toBe('No tracked file edits seen yet.')
    expect(await ui.find({ key: 'home-fix' })).toBeUndefined()
    expect(await ui.find({ key: 'home-retest' })).toBeUndefined()
    expect(await ui.find({ key: 'rerun-failed' })).toBeDefined()
  })
})
