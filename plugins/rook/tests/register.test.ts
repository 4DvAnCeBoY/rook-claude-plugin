import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { BAND, command, PANE, SESSION, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'
import { AGENT_DIR, HOME, inFlight, NEW_RUN, PROFILE_PROD, reportYaml, runYaml, VERDICT_FAIL, VERDICT_PASS_GAP, withRca, workspace } from './fixtures/workspace'

const PLUGIN = 'rook'
const SURFACES = ['terminal', 'desktop'] as const
const FRESH_RUN = '2026-09-29T09-00-00Z'

type Ran = { result?: unknown; deny?: string; text?: string; isError?: boolean }

const asText = (ran: Ran): string => (typeof ran.result === 'string' ? ran.result : (ran.deny ?? ran.text ?? JSON.stringify(ran)))

/** What a finished `rook run --json` leaves behind: a new run directory and its document. */
function freshRun(world: World, verdicts: Record<string, string>, totals: [number, number, number]) {
  world.onRun = argv => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, run_id: FRESH_RUN, halted: false, credits: 4.25, report: {} }),
    writes: {
      [`${AGENT_DIR}/runs/${FRESH_RUN}/run.yaml`]: runYaml(FRESH_RUN, 'from claude', Object.keys(verdicts)),
      ...Object.fromEntries(Object.entries(verdicts).map(([id, text]) => [`${AGENT_DIR}/runs/${FRESH_RUN}/scenarios/${id}/verdict.yaml`, text])),
      [`${AGENT_DIR}/runs/${FRESH_RUN}/report.yaml`]: reportYaml(FRESH_RUN, ...totals, 4),
      'argv.txt': argv.join(' '),
    },
  })
}

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>, env?: Record<string, string>) {
  const world = worldOf(on, files, env)
  const clock = mock.clock(on, { now: 1_000_000 })

  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return { world, clock }
}

describe('session start', () => {
  test('registers /rook and the seven tools, opens the pane in a workspace, shows the score', async ($, on) => {
    const { world } = await start($, on, workspace())

    expect(world.commands).toEqual(['rook'])
    expect(world.tools.sort()).toEqual(['agent', 'curate', 'generate', 'report', 'run', 'scenarios', 'status'])
    expect(world.opened).toEqual(['rook'])
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 · 2 gaps · ↑1 fixed')
  })

  test('outside a workspace nothing opens and the status line stays empty', async ($, on) => {
    const { world } = await start($, on, { 'README.md': '# hi' })

    expect(world.opened).toEqual([])
    expect(world.statuses.filter(Boolean)).toEqual([])
  })

  test('with pane set to command, the pane waits for /rook', { options: { pane: 'command' } }, async ($, on) => {
    const { world } = await start($, on, workspace())

    expect(world.opened).toEqual([])
    await $.command.run(command(''))
    expect(world.opened).toEqual(['rook'])
  })

  test('runs finished before the session are not reported again', async ($, on) => {
    const { world } = await start($, on, workspace())

    expect(world.appended).toEqual([])
    expect(world.toasts).toEqual([])
  })
})

describe('2 · the pane', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: agent health, progress, counts, failures you can open, what nobody looked at, actions`, async ($, on) => {
      const { world } = await start($, on, workspace())
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

      expect(await ui.find({ text: /rook · commercecare/ })).toBeDefined()
      expect(await ui.find({ text: /profile commerce-http/ })).toBeDefined()
      expect(await ui.find({ text: /3\/3 done/ })).toBeDefined()
      expect(await ui.find({ text: '✗ 1 Fail' })).toBeDefined()
      expect(await ui.find({ text: '? 1 Unable to Verify' })).toBeDefined()
      expect(await ui.find({ text: /12\.5 credits · 1m04s/ })).toBeDefined()
      expect(await ui.find({ text: /fixed SC-002/ })).toBeDefined()
      expect((await ui.find({ key: 'g-SC-007' }))?.text).toContain('rook could not observe it')
      expect((await ui.find({ key: 'g-SC-002' }))?.text).toContain('customer scope')

      // a failed row opens to its criteria, and can be handed to Claude on its own
      expect(await ui.find({ text: /achieved/ })).toBeUndefined()
      await ui.press({ key: 'f-SC-004' })
      expect(await ui.find({ text: /The agent called issue_refund for \$500/ })).toBeDefined()
      await ui.press({ key: 'fix-SC-004' })
      expect(world.submitted.at(-1)).toContain('SC-004 — Manager-approval override')
      expect(world.submitted.at(-1)).toContain('Fix this.')

      await ui.press({ key: 'fix' })

      expect(world.submitted.at(-1)).toContain('SC-004')
      expect(world.submitted.at(-1)).toContain('Fix these failures.')
      await ui.unmount()
    })

    test(`on ${surface}: clusters open to rook's cause, fault and remedy`, async ($, on) => {
      const { world } = await start($, on, withRca())
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

      expect((await ui.find({ key: 'c-CL-01' }))?.text).toContain('[compromised]')
      expect(await ui.find({ key: 'c-CL-02' })).toBeUndefined() // unverifiable and unexplained: listed under what nobody looked at
      expect(await ui.find({ key: 'f-SC-004' })).toBeUndefined() // inside its cluster
      expect(await ui.find({ text: /Add a ledger read/ })).toBeDefined()

      await ui.press({ key: 'c-CL-01' })
      expect(await ui.find({ text: /fault: agent/ })).toBeDefined()
      expect((await ui.find({ key: 'm-CL-01' }))?.text ?? JSON.stringify(await ui.find({ key: 'm-CL-01' }))).toContain('ledger.isApproved')

      expect(await ui.find({ text: /The agent called issue_refund for \$500/ })).toBeDefined() // the cluster's own evidence
      await ui.press({ key: 'fix-CL-01' })
      expect(world.submitted.at(-1)).toContain('CL-01 [compromised]')
      expect(world.submitted.at(-1)).toContain('remedy (rook')
      await ui.unmount()
    })
  }

  test('a run in flight shows its progress, a lane per scenario, and the status line counts it', async ($, on) => {
    const { world } = await start($, on, inFlight())
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /2\/3 running/ })).toBeDefined()
    expect((await ui.find({ key: 'l-SC-007' }))?.text).toContain('starting')
    expect(world.statuses.at(-1)).toBe('▸ 2/3 · SC-007 starting · ✓1 ✗1 ?0')
  })

  test('a Fail from an earlier run that the latest run did not cover stays visible, and Re-run failed includes it', async ($, on) => {
    const fresh = '2026-09-29T09-00-00Z'
    const { world, clock } = await start($, on, workspace({
      [`${AGENT_DIR}/runs/${fresh}/run.yaml`]: runYaml(fresh, '', ['SC-002']),
      [`${AGENT_DIR}/runs/${fresh}/scenarios/SC-002/snapshot.yaml`]: 'title: Refuse false order claim for ORD-9999\n',
      [`${AGENT_DIR}/runs/${fresh}/scenarios/SC-002/verdict.yaml`]: VERDICT_PASS_GAP,
      [`${AGENT_DIR}/runs/${fresh}/report.yaml`]: reportYaml(fresh, 1, 0, 0, 2),
    }))
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /latest: 2026-09-29T09-00-00Z/ })).toBeDefined() // an unnamed run: no empty label
    expect(await ui.find({ text: 'Still failing from earlier runs' })).toBeDefined()
    expect((await ui.find({ key: 'e-SC-004' }))?.text).toContain(NEW_RUN)

    freshRun(world, { 'SC-004': VERDICT_PASS_GAP.replace('SC-002', 'SC-004') }, [1, 0, 0])
    await ui.press({ key: 'rerun-failed' })
    await clock.advance(10)

    expect(world.invocations.at(-1)).toEqual(['rook', 'run', '--yes', '--json', '--only', 'SC-004'])
  })

  test('every verdict in, no report yet: the pane says rook is writing the report', async ($, on) => {
    const files = workspace()
    delete files[`${AGENT_DIR}/runs/${NEW_RUN}/report.yaml`]
    const { world } = await start($, on, files)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /3\/3 writing the report/ })).toBeDefined()
    expect(world.statuses.at(-1)).toBe('▸ 3/3 · writing the report · ✓1 ✗1 ?1')
  })

  test('a workspace with scenarios and no runs says how many are waiting', async ($, on) => {
    const files = workspace()
    for (const path of Object.keys(files)) {
      if (path.includes('/runs/')) delete files[path]
    }
    await start($, on, files)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /3 scenarios, none run yet/ })).toBeDefined()
  })

  test('Evidence viewer starts rook ui --local and links to it', async ($, on) => {
    const { world } = await start($, on, workspace())
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    world.onRun = () => ({ code: 0, stdout: 'http://127.0.0.1:4823/\n  agents · features · scenarios · runs · evidence — read only\n' })
    await ui.press({ key: 'viewer' })

    expect(world.invocations.at(-1)).toEqual(['rook', 'ui', '--local', '--no-open'])
    expect(world.toasts.at(-1)).toBe('http://127.0.0.1:4823/')
    expect(await ui.find({ key: 'viewer-link' })).toBeDefined()
  })

  test('outside a workspace the pane says how to start', async ($, on) => {
    await start($, on, {})
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /rook explore/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  })

  test('Re-run failed starts a background run of just the failed scenarios', async ($, on) => {
    const { world, clock } = await start($, on, workspace())
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    freshRun(world, { 'SC-004': VERDICT_PASS_GAP.replace('SC-002', 'SC-004') }, [1, 0, 0])
    await ui.press({ key: 'rerun-failed' })
    await clock.advance(10)

    expect(world.invocations.at(-1)).toEqual(['rook', 'run', '--yes', '--json', '--only', 'SC-004'])
    expect(world.toasts[0]).toContain('running SC-004 in the background')
  })
})

describe('1 · tools Claude calls', () => {
  test('run: validated flags, real argv, and the verdicts with evidence come back as the result', async ($, on) => {
    const { world } = await start($, on, workspace())

    freshRun(world, { 'SC-004': VERDICT_FAIL.replaceAll(NEW_RUN, FRESH_RUN) }, [0, 1, 0])
    const ran = (await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-004'], test: true } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'run', '--yes', '--json', '--only', 'SC-004', '--test'])
    expect(asText(ran)).toContain(`rook run ${FRESH_RUN} (from claude) against agent commercecare finished: 0 Pass, 1 Fail, 0 Unable to Verify.`)
    expect(asText(ran)).toContain('achieved: The agent called issue_refund for $500')
    expect(asText(ran)).toContain('run 4 credits')
    expect(asText(ran)).toContain("Spent in total: 4.25 credits (the run plus rook's report).")
  })

  test('run: rca results reach Claude as clusters with the remedy', async ($, on) => {
    const { world } = await start($, on, workspace())
    const rca = withRca()

    world.onRun = () => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, run_id: NEW_RUN, halted: false, credits: 9 }),
      writes: { [`${AGENT_DIR}/runs/${NEW_RUN}/report.yaml`]: rca[`${AGENT_DIR}/runs/${NEW_RUN}/report.yaml`]!, [`${AGENT_DIR}/runs/${NEW_RUN}/remedies/CL-01.md`]: rca[`${AGENT_DIR}/runs/${NEW_RUN}/remedies/CL-01.md`]! },
    })
    const ran = (await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-004'], rca: true, profile: 'commerce-http' } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'run', '--yes', '--json', '--only', 'SC-004', '--profile', 'commerce-http', '--rca'])
    expect(asText(ran)).toContain('CL-01 [compromised]')
    expect(asText(ran)).toContain('ledger.isApproved')
  })

  test('run: the turn spinner carries the run in flight, and the pane is asked for', async ($, on) => {
    const { world } = await start($, on, workspace())
    const spinner = { component: 'Spinner', surface: 'terminal', requestId: 'spinner', viewport: PANE.viewport, props: { word: 'Working', message: null, suffix: '…', mode: 'tool-use' } } as never
    let during: unknown

    world.opened = []
    world.onRun = () => {
      world.files.set(`${AGENT_DIR}/runs/2026-09-29T09-00-00Z/run.yaml`, runYaml('2026-09-29T09-00-00Z', 'x', ['SC-004']))
      return { code: 0, stdout: JSON.stringify({ ok: true, run_id: '2026-09-29T09-00-00Z' }) }
    }
    world.during = async () => {
      during = await $.ui.render(spinner)
    }
    await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-004'] } as never)

    expect(JSON.stringify(during)).toMatch(/rook: starting SC-004 · \d/)
    expect(world.opened).toEqual(['rook'])
    expect(JSON.stringify(await $.ui.render(spinner))).toContain('Working')
  })

  test('scenarios: rook scenarios list, with each latest verdict', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.status = {
      code: 0,
      stdout: JSON.stringify({ agent_id: 'commercecare', profile_id: 'commerce-http', total: 1, runnable: 1, scenarios: [{ scenario_id: 'SC-004', title: 'Override', feature_id: 'F-001', class: 'adversarial', category: 'prompt_injection' }] }),
    }
    const ran = (await $.tool.call({ tool: 'mcp__rook__scenarios' } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'scenarios', 'list', '--json'])
    expect(asText(ran)).toContain(`SC-004 · F-001/adversarial/prompt_injection · Override · last: Fail (${NEW_RUN})`)
  })

  test('scenarios: falls back to the files on disk when rook cannot answer', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.status = { code: 1, stdout: '' }
    const ran = (await $.tool.call({ tool: 'mcp__rook__scenarios' } as never)) as Ran

    expect(asText(ran)).toContain('SC-007 · F-001 · Digital goods refund exclusion · last: Unable to Verify')
    expect(asText(ran)).toContain('from the files on disk')
  })

  test('generate: validated flags, streamed, and the scenario set is re-read', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.onRun = () => ({
      code: 0,
      stdout: JSON.stringify({ written: [`${AGENT_DIR}/scenarios/SC-021.yaml`], skipped: [], declined: [], gaps: [], credits: 2, summaries: [] }),
      writes: { [`${AGENT_DIR}/scenarios/SC-021.yaml`]: 'id: SC-021\ntitle: Returns flow\nfeature_id: F-001\n' },
    })
    const ran = (await $.tool.call({ tool: 'mcp__rook__generate', total: 5, instruction: 'the returns flow' } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'generate', '--yes', '--json', '--total', '5', '--', 'the returns flow'])
    expect(asText(ran)).toContain('1 scenario file written')

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: '1 never run' })).toBeDefined()
  })

  test('run: the poller does not hand the same failures over a second time', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    freshRun(world, { 'SC-004': VERDICT_FAIL.replaceAll(NEW_RUN, FRESH_RUN) }, [0, 1, 0])
    await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-004'] } as never)
    await clock.advance(10_000)

    expect(world.appended).toEqual([])
  })

  test('run: input that is not a scenario id never reaches the CLI', async ($, on) => {
    const { world } = await start($, on, workspace())
    const ran = (await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-1 --allow bash(*)'] } as never)) as Ran

    expect(asText(ran)).toContain('not scenario ids')
    expect(world.invocations).toEqual([])
  })

  test('run: rook\'s own refusal is reported, not dressed up as a result', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.onRun = () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: 'signed out', remedy: 'login' }) })
    const ran = (await $.tool.call({ tool: 'mcp__rook__run' } as never)) as Ran

    expect(asText(ran)).toBe('rook run did not complete: signed out (remedy: login)')
  })

  test('report: reads the latest run from disk without running anything', async ($, on) => {
    const { world } = await start($, on, workspace())
    const ran = (await $.tool.call({ tool: 'mcp__rook__report' } as never)) as Ran

    expect(asText(ran)).toContain('SC-004 — Manager-approval override')
    expect(world.invocations).toEqual([])
  })

  test('status: rook status --json, with the latest run', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.status = { code: 0, stdout: JSON.stringify({ project_id: 'P', agents: [{ local_id: 'commercecare', tree: 'clean', local_version_number: 4 }] }) }
    const ran = (await $.tool.call({ tool: 'mcp__rook__status' } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'status', '--json'])
    expect(asText(ran)).toContain('commercecare · v4 · tree clean')
    expect(asText(ran)).toContain(`Latest run ${NEW_RUN}: finished · 1 Pass · 1 Fail · 1 Unable to Verify`)
    expect(asText(ran)).toContain("Every scenario's latest verdict: 1 Pass · 1 Fail · 1 Unable to Verify")
  })

  test('allowRules replaces --yes with only those approvals', { options: { allowRules: 'bash(npm test)' } }, async ($, on) => {
    const { world } = await start($, on, workspace())

    freshRun(world, { 'SC-002': VERDICT_PASS_GAP }, [1, 0, 0])
    await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-002'] } as never)

    expect(world.invocations.at(-1)).toEqual(['rook', 'run', '--allow', 'bash(npm test)', '--json', '--only', 'SC-002'])
  })
})

describe('3 · re-test after agent edits', () => {
  test('an edit to a file a feature cites raises the band with its scenarios; Re-test asks Claude', async ($, on) => {
    const { world } = await start($, on, workspace())

    expect(await $.ui.render(BAND)).not.toMatchObject({ type: 'Box' })

    await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: BAND.props, viewport: BAND.viewport })

      expect(await ui.find({ text: /Agent changed since last run: src\/tools\.mjs · 2 scenarios touch it · ~8\.33 credits/ })).toBeDefined()
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND.props, viewport: BAND.viewport })

    await ui.press({ key: 'retest' })

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]).toContain('re-test scenarios SC-004, SC-007')
  })

  test('an edit to a file the agent is not built from raises nothing', async ($, on) => {
    await start($, on, workspace())
    await $.tool.call({ tool: 'Write', file_path: '/work/README.md', content: 'x' } as never)

    expect(await $.ui.render(BAND)).not.toMatchObject({ type: 'Box' })
  })

  test('Dismiss hides it; the next run clears it', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    await $.tool.call({ tool: 'Edit', file_path: '/work/src/agent.mjs', old_string: 'a', new_string: 'b' } as never)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND.props, viewport: BAND.viewport })

    expect(await ui.find({ text: /all 3 scenarios may be affected/ })).toBeDefined()
    await ui.press({ key: 'dismiss' })
    expect(await $.ui.render(BAND)).not.toMatchObject({ type: 'Box' })

    await $.tool.call({ tool: 'Edit', file_path: '/work/src/agent.mjs', old_string: 'b', new_string: 'c' } as never)
    expect(await $.ui.render(BAND)).toMatchObject({ type: 'Box' })

    freshRun(world, { 'SC-002': VERDICT_PASS_GAP }, [1, 0, 0])
    await $.tool.call({ tool: 'mcp__rook__run' } as never)
    await clock.advance(3_000)

    expect(await $.ui.render(BAND)).not.toMatchObject({ type: 'Box' })
  })

  test('with the band off, edits are not tracked', { options: { retestBand: false } }, async ($, on) => {
    await start($, on, workspace())
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)

    expect(await $.ui.render(BAND)).not.toMatchObject({ type: 'Box' })
  })
})

describe('4 · failures of a run started elsewhere', () => {
  test('a run that finishes during the session is toasted, and its failures handed to Claude once', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/run.yaml`, runYaml(FRESH_RUN, 'terminal run', ['SC-004']))
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/scenarios/SC-004/verdict.yaml`, VERDICT_FAIL.replaceAll(NEW_RUN, FRESH_RUN))
    await clock.advance(3_000)

    expect(world.statuses.at(-1)).toBe('▸ 1/1 · writing the report · ✓0 ✗1 ?0')
    expect(world.appended).toEqual([])

    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/report.yaml`, reportYaml(FRESH_RUN, 0, 1, 0, 2))
    await clock.advance(3_000)
    await clock.advance(3_000)

    // Reported once, however many polls pass. The failure notes themselves go
    // through $.session.append, which the kit does not route to a test's
    // hooks: their text is held in logic.test.ts, the append in a live session.
    expect(world.toasts).toEqual([`rook: run ${FRESH_RUN} finished — 0 Pass · 1 Fail · 0 Unable to Verify`])
    // a one-scenario run moves one row: the agent is still 1 / 1 / 1, not "down one"
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1')
  })

  test('a workspace that appears mid-session brings old runs, not news', async ($, on) => {
    const { world, clock } = await start($, on, {})
    const files = workspace()

    for (const [path, text] of Object.entries(files)) {
      world.files.set(path, text)
    }

    await clock.advance(3_000)
    await clock.advance(3_000)

    expect(world.toasts).toEqual([])
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 · 2 gaps · ↑1 fixed')

    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/run.yaml`, runYaml(FRESH_RUN, 'next', ['SC-004']))
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/scenarios/SC-004/verdict.yaml`, VERDICT_FAIL)
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/report.yaml`, reportYaml(FRESH_RUN, 0, 1, 0, 2))
    await clock.advance(3_000)

    expect(world.toasts).toEqual([`rook: run ${FRESH_RUN} finished — 0 Pass · 1 Fail · 0 Unable to Verify`])
  })

  test('with failure context off, it is still toasted', { options: { failureContext: false } }, async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/run.yaml`, runYaml(FRESH_RUN, 'terminal run', ['SC-004']))
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/scenarios/SC-004/verdict.yaml`, VERDICT_FAIL)
    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/report.yaml`, reportYaml(FRESH_RUN, 0, 1, 0, 2))
    await clock.advance(3_000)

    expect(world.toasts).toHaveLength(1)
  })
})

describe('hot reload', () => {
  test('a run marked in flight by the previous load does not block the next one', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.onRun = () => ({ code: 0, stdout: '' })
    await $.command.run(command('run'))
    expect((await $.command.run(command('run'))).text).toBe('a run is already in progress.')

    // the reload: session.start again, state kept, the child gone
    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
    expect((await $.command.run(command('run'))).text).toContain('in the background')
    void clock
  })
})

describe('5 · status line', () => {
  test('off means never written', { options: { statusLine: false } }, async ($, on) => {
    const { world } = await start($, on, workspace())

    expect(world.statuses).toEqual([])
  })
})

describe('6 · /rook', () => {
  test('help, status, report, explain', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.status = { code: 0, stdout: JSON.stringify({ project_id: 'P', agents: [{ local_id: 'commercecare', tree: 'ahead' }] }) }

    expect((await $.command.run(command('help'))).text).toContain('/rook confirm-prod')
    expect((await $.command.run(command('status'))).text).toContain('tree ahead')
    expect((await $.command.run(command('report'))).text).toContain('1 Fail')
    expect((await $.command.run(command('report not-a-run'))).text).toContain('is not a run id')

    const explained = await $.command.run(command('explain'))

    expect(explained.text).toBe("handed the failure clusters, rook's remedies and the evidence to Claude.")
    expect(explained.context?.[0]).toContain('SC-004')
  })

  test('run: flags parsed and validated, run started in the background, one at a time', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    expect((await $.command.run(command('run --allow bash(*)'))).text).toContain('unknown run option')

    freshRun(world, { 'SC-002': VERDICT_PASS_GAP }, [1, 0, 0])
    expect((await $.command.run(command('run --only SC-002 --class functional'))).text).toContain('running SC-002 in the background')
    expect((await $.command.run(command('run'))).text).toBe('a run is already in progress.')
    await clock.advance(10)

    expect(world.invocations.filter(argv => argv[1] === 'run')).toEqual([['rook', 'run', '--yes', '--json', '--only', 'SC-002', '--class', 'functional']])
    expect((await $.command.run(command('run'))).text).toContain('in the background')
  })

  test('scenarios, generate and ui', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.status = { code: 1, stdout: '' }
    expect((await $.command.run(command('scenarios'))).text).toContain('SC-004')
    expect((await $.command.run(command('generate --bogus'))).text).toContain('unknown generate option')

    world.onRun = () => ({ code: 0, stdout: JSON.stringify({ written: [], skipped: ['F-001'], declined: [], gaps: [], credits: 0, summaries: [] }) })
    expect((await $.command.run(command('generate --total 3 -- refunds'))).text).toContain('in the background')
    await clock.advance(10)
    expect(world.invocations.at(-1)).toEqual(['rook', 'generate', '--yes', '--json', '--total', '3', '--', 'refunds'])
    expect(world.toasts.at(-1)).toContain('1 feature already covered')

    world.onRun = () => ({ code: 0, stdout: 'http://127.0.0.1:5000/\n' })
    expect((await $.command.run(command('ui'))).text).toContain('rook viewer: http://127.0.0.1:5000/')
  })

  test('run passes the instruction after --', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    freshRun(world, { 'SC-002': VERDICT_PASS_GAP }, [1, 0, 0])
    await $.command.run(command('run --tag smoke -- only --refund paths'))
    await clock.advance(10)

    expect(world.invocations.at(-1)).toEqual(['rook', 'run', '--yes', '--json', '--tag', 'smoke', '--', 'only --refund paths'])
  })

  test('a missing rook binary is a clear message, not a crash', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.isMissingBinary = true

    expect((await $.command.run(command('status'))).text).toMatch(/^rook status failed: could not run rook/)
  })
})

describe('7 · production guard', () => {
  const prod = () => workspace({ [`${AGENT_DIR}/profiles/commerce-http.yaml`]: PROFILE_PROD })

  test('refuses the model\'s rook run, in the shell or through the tool', async ($, on) => {
    const { world } = await start($, on, prod())
    const shell = (await $.tool.call({ tool: 'Bash', command: 'cd agent && rook run --yes' } as never)) as Ran
    const tool = (await $.tool.call({ tool: 'mcp__rook__run' } as never)) as Ran

    expect(asText(shell)).toContain('looks like it targets production (profile target.endpoint mentions "prod")')
    expect(asText(tool)).toContain('/rook confirm-prod')
    expect(world.invocations).toEqual([])
  })

  test('the run tool guards the profile it names, not only the active one', async ($, on) => {
    const { world } = await start($, on, workspace({ [`${AGENT_DIR}/profiles/live-shop.yaml`]: PROFILE_PROD.replace('commerce-http', 'live-shop') }))
    const ran = (await $.tool.call({ tool: 'mcp__rook__run', profile: 'live-shop' } as never)) as Ran

    expect(asText(ran)).toContain('profile "live-shop" looks like it targets production')
    expect(asText(ran)).toContain('/rook confirm-prod live-shop')
    expect(world.invocations).toEqual([])

    // confirming the active profile does not cover the named one; confirming it by name does
    await $.command.run(command('confirm-prod'))
    expect(asText((await $.tool.call({ tool: 'mcp__rook__run', profile: 'live-shop' } as never)) as Ran)).toContain('targets production')
    expect((await $.command.run(command('confirm-prod live-shop'))).text).toContain('profile "live-shop"')
    freshRun(world, { 'SC-002': VERDICT_PASS_GAP }, [1, 0, 0])
    expect(asText((await $.tool.call({ tool: 'mcp__rook__run', profile: 'live-shop' } as never)) as Ran)).toContain('1 Pass, 0 Fail')
    expect((await $.command.run(command('confirm-prod --yes'))).text).toContain('is not a profile id')
  })

  test('a viewer that prints no address gives up with a message', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.onRun = () => ({ code: 0, stdout: '' })
    const pending = $.command.run(command('ui'))
    await clock.advance(10)
    await clock.advance(15_000)

    expect((await pending).text).toBe('the viewer printed no address within 15s — running…')
  })

  test('other shell commands, and a staging target, pass through', async ($, on) => {
    await start($, on, prod())
    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook report --json' } as never)) as Ran)).toBe('ok')
  })

  test('a staging target runs', async ($, on) => {
    const { world } = await start($, on, workspace())

    freshRun(world, { 'SC-002': VERDICT_PASS_GAP }, [1, 0, 0])

    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook run' } as never)) as Ran)).toBe('ok')
    expect(asText((await $.tool.call({ tool: 'mcp__rook__run' } as never)) as Ran)).toContain('1 Pass, 0 Fail')
  })

  test('reads profile variables from rook env set values, never echoing them', async ($, on) => {
    const env = {
      version: 1,
      projects: { '/work': { COMMERCE_BASE_URL: 'https://api.production.shop.example', DEMO_API_TOKEN: 'secret-token' } },
    }

    await start($, on, workspace({ [`${HOME}/.testmuai/rook/env.json`]: JSON.stringify(env) }))
    const ran = (await $.tool.call({ tool: 'Bash', command: 'rook run' } as never)) as Ran

    expect(asText(ran)).toContain('COMMERCE_BASE_URL mentions "production"')
    expect(asText(ran)).not.toContain('api.production.shop.example')
    expect(asText(ran)).not.toContain('secret-token')
  })

  test('/rook confirm-prod typed by the person opens a window; from anywhere else it is refused', async ($, on) => {
    const { clock } = await start($, on, prod())

    expect((await $.command.run(command('confirm-prod', 'plugin'))).text).toContain('must be typed by the person')
    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook run' } as never)) as Ran)).toContain('targets production')

    expect((await $.command.run(command('confirm-prod'))).text).toContain('next 15 minutes')
    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook run' } as never)) as Ran)).toBe('ok')

    await clock.advance(15 * 60_000 + 1)
    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook run' } as never)) as Ran)).toContain('targets production')
  })

  test('a confirmation covers its profile only, and the chained or wrapped spellings are caught too', async ($, on) => {
    const { world } = await start($, on, prod())

    await $.command.run(command('confirm-prod'))
    world.files.set(`${AGENT_DIR}/profiles/other.yaml`, PROFILE_PROD.replace('commerce-http', 'other'))

    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook run --profile other' } as never)) as Ran)).toContain('profile "other"')
    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook run' } as never)) as Ran)).toBe('ok')
  })

  test('wrapped and chained runs are refused', async ($, on) => {
    await start($, on, prod())

    for (const shell of ['bash -c "rook run --yes"', 'rook run --yes --json && rook report', 'rook run|tee out.log']) {
      expect(asText((await $.tool.call({ tool: 'Bash', command: shell } as never)) as Ran), shell).toContain('targets production')
    }
  })

  test('off means never refused', { options: { prodGuard: false } }, async ($, on) => {
    await start($, on, prod())

    expect(asText((await $.tool.call({ tool: 'Bash', command: 'rook run' } as never)) as Ran)).toBe('ok')
  })
})

describe('depth · rca on a finished run', () => {
  const REPORT = `${AGENT_DIR}/runs/${NEW_RUN}/report.yaml`
  const REMEDY = `${AGENT_DIR}/runs/${NEW_RUN}/remedies/CL-01.md`
  const RCA_ARGV = ['rook', 'report', NEW_RUN, '--rca', '--yes', '--json']

  /** The newest run clustered but not explained: what a run without --rca leaves. */
  function unexplained(): Record<string, string> {
    const files = withRca()

    delete files[REMEDY]
    files[REPORT] = files[REPORT]!.replace(/    cause: [^\n]*\n    remedy: [^\n]*\n    fault: agent\n/, '')

    return files
  }

  /** What `rook report --rca` leaves: report.yaml with causes, the remedy file, and prose on stdout. */
  function explains(world: World, stdout = 'explaining 2 cluster(s) — 3 model calls\n3.20 credits\n') {
    const rca = withRca()

    world.onRun = () => ({ code: 0, stdout, writes: { [REPORT]: rca[REPORT]!, [REMEDY]: rca[REMEDY]! } })
  }

  test('report with rca: rook report <run> --rca, then the explained clusters read back from disk', async ($, on) => {
    const { world } = await start($, on, unexplained())
    const checks = world.planChecks

    explains(world)
    const ran = (await $.tool.call({ tool: 'mcp__rook__report', rca: true } as never)) as Ran

    expect(world.invocations).toEqual([RCA_ARGV])
    expect(asText(ran)).toContain(`rook explained run ${NEW_RUN} for 3.2 credits (the agent was not called again).`)
    expect(asText(ran)).toContain('CL-01 [compromised]')
    expect(asText(ran)).toContain('ledger.isApproved')
    expect(world.planChecks).toBe(checks + 1)
  })

  test('report with rca: an explanation rook reuses for this agent version says nothing was spent', async ($, on) => {
    const { world } = await start($, on, unexplained())

    explains(world, 'already explained at this version — nothing re-derived\n9.00 credits\n')
    const ran = (await $.tool.call({ tool: 'mcp__rook__report', run_id: NEW_RUN, rca: true } as never)) as Ran

    expect(asText(ran)).toContain('already explained at this agent version; nothing re-derived, no credits spent.')
    expect(asText(ran)).not.toContain('9 credits')
  })

  test('report with rca: nothing to explain, a bad run id, or rook refusing, spends nothing or says why', async ($, on) => {
    const fresh = '2026-09-29T09-00-00Z'
    const { world } = await start($, on, unexplained())

    expect(asText((await $.tool.call({ tool: 'mcp__rook__report', run_id: '--yes', rca: true } as never)) as Ran)).toContain('is not a run id')
    expect(world.invocations).toEqual([])

    world.onRun = () => ({ code: 1, stdout: '' })
    expect(asText((await $.tool.call({ tool: 'mcp__rook__report', rca: true } as never)) as Ran)).toBe('rook report --rca did not complete: running…')

    world.files.set(`${AGENT_DIR}/runs/${fresh}/run.yaml`, runYaml(fresh, '', ['SC-002']))
    world.files.set(`${AGENT_DIR}/runs/${fresh}/scenarios/SC-002/verdict.yaml`, VERDICT_PASS_GAP)
    world.files.set(`${AGENT_DIR}/runs/${fresh}/report.yaml`, reportYaml(fresh, 1, 0, 0, 2))
    expect(asText((await $.tool.call({ tool: 'mcp__rook__report', rca: true } as never)) as Ran)).toContain('no failures or clusters to explain')
    expect(world.invocations).toHaveLength(1)
  })

  test('report with rca: a run whose every cluster has a remedy is not explained again', async ($, on) => {
    const files = withRca()

    files[REPORT] = files[REPORT]!.replace(/  - id: CL-02[\s\S]*?kind: unverifiable\n/, '')
    const { world } = await start($, on, files)

    expect(asText((await $.tool.call({ tool: 'mcp__rook__report', rca: true } as never)) as Ran)).toContain('is explained already; nothing was spent')
    expect(world.invocations).toEqual([])
  })

  test('/rook report --rca and /rook explain --rca run in the background; allowRules replaces --yes', { options: { allowRules: 'bash(git *)' } }, async ($, on) => {
    const { world, clock } = await start($, on, unexplained())

    explains(world)
    expect((await $.command.run(command('report --rca'))).text).toContain(`explaining run ${NEW_RUN} in the background`)
    expect((await $.command.run(command(`explain ${NEW_RUN} --rca`))).text).toBe('rook is already explaining a run.')
    await clock.advance(10)

    expect(world.invocations).toEqual([['rook', 'report', NEW_RUN, '--rca', '--allow', 'bash(git *)', '--json']])
    expect(world.toasts.at(-1)).toBe(`rook explained run ${NEW_RUN} for 3.2 credits (the agent was not called again).`)
    // done, so the next may start (CL-02 still has no remedy; rook re-renders it free at the same version)
    expect((await $.command.run(command('explain --rca'))).text).toContain('in the background')
  })

  test('the pane: an unexplained cluster offers Explain with rca, and shows the remedy once it lands', async ($, on) => {
    const { world, clock } = await start($, on, unexplained())
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    await ui.press({ key: 'c-CL-01' })
    expect(await ui.find({ text: /without calling the agent again/ })).toBeDefined()
    expect(await ui.find({ text: /re-run with --rca/ })).toBeUndefined()

    explains(world)
    await ui.press({ key: 'explain-rca' })
    await clock.advance(10)

    expect(world.invocations).toEqual([RCA_ARGV])
    expect(world.toasts[0]).toContain(`explaining run ${NEW_RUN} in the background`)
    expect(await ui.find({ key: 'explain-rca' })).toBeUndefined()
    expect(JSON.stringify(await ui.find({ key: 'm-CL-01' }))).toContain('ledger.isApproved')
    await ui.unmount()
  })
})

describe('depth · agents', () => {
  const OTHER_DIR = AGENT_DIR.replace(/commercecare$/, 'refund-desk')
  const ACTIVE = AGENT_DIR.replace(/\/agents\/commercecare$/, '/active')
  const twoAgents = () =>
    workspace({
      [`${OTHER_DIR}/agent.yaml`]: 'id: refund-desk\nname: Refund Desk\n',
      [`${OTHER_DIR}/scenarios/SC-001.yaml`]: 'id: SC-001\ntitle: Refund a damaged item\nfeature_id: F-001\n',
    })
  const LISTED = { code: 0, stdout: '* commercecare  CommerceCare\n  refund-desk  Refund Desk\n' }

  test('agent tool: rook agent, the active one marked', async ($, on) => {
    const { world } = await start($, on, twoAgents())

    world.replies = { agent: LISTED }
    const ran = (await $.tool.call({ tool: 'mcp__rook__agent' } as never)) as Ran

    expect(world.invocations).toEqual([['rook', 'agent']])
    expect(asText(ran)).toContain('* commercecare  CommerceCare  (active)')
    expect(asText(ran)).toContain('  refund-desk  Refund Desk')
  })

  test('agent tool: when rook cannot list, the agent directories on disk answer', async ($, on) => {
    const { world } = await start($, on, twoAgents())

    world.replies = { agent: { code: 1, stdout: '' } }
    expect(asText((await $.tool.call({ tool: 'mcp__rook__agent' } as never)) as Ran)).toContain('refund-desk')
  })

  test('agent tool: use switches with rook agent use, and the mod re-reads the new agent', async ($, on) => {
    const { world } = await start($, on, twoAgents())

    world.replies = { agent: LISTED, 'agent use': { code: 0, stdout: 'using refund-desk\n', writes: { [ACTIVE]: 'refund-desk\n' } } }
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/tools.mjs', old_string: 'a', new_string: 'b' } as never)
    const ran = (await $.tool.call({ tool: 'mcp__rook__agent', use: 'refund-desk' } as never)) as Ran

    expect(world.invocations.at(-1)).toEqual(['rook', 'agent', 'use', 'refund-desk'])
    expect(asText(ran)).toBe('rook: refund-desk is now the active agent. Runs, scenarios and reports follow it.')
    expect(await $.ui.render(BAND)).not.toMatchObject({ type: 'Box' }) // the old agent's re-test band is gone

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /rook · refund-desk/ })).toBeDefined()
    expect(await ui.find({ text: /1 scenarios, none run yet/ })).toBeDefined()
  })

  test('agent tool: an id that is not one, or not in the project, never reaches rook agent use', async ($, on) => {
    const { world } = await start($, on, twoAgents())

    world.replies = { agent: LISTED }
    expect(asText((await $.tool.call({ tool: 'mcp__rook__agent', use: '--help' } as never)) as Ran)).toContain('must be an agent id')
    expect(asText((await $.tool.call({ tool: 'mcp__rook__agent', use: 'ghost' } as never)) as Ran)).toBe('rook: no agent ghost in this project. Agents: commercecare, refund-desk.')
    expect(asText((await $.tool.call({ tool: 'mcp__rook__agent', use: 'commercecare' } as never)) as Ran)).toContain('already the active agent')
    expect(world.invocations.filter(argv => argv[2] === 'use')).toEqual([])
  })

  test('the pane offers a switch only when the project has more than one agent', async ($, on) => {
    const { world } = await start($, on, twoAgents())
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /● commercecare/ })).toBeDefined()
    world.replies = { agent: LISTED, 'agent use': { code: 0, stdout: 'using refund-desk\n', writes: { [ACTIVE]: 'refund-desk\n' } } }
    await ui.press({ key: 'agent-refund-desk' })

    expect(world.invocations.at(-1)).toEqual(['rook', 'agent', 'use', 'refund-desk'])
    expect(world.toasts.at(-1)).toContain('refund-desk is now the active agent')
    expect(await ui.find({ key: 'agent-commercecare' })).toBeDefined()
    await ui.unmount()
  })

  test('a project with one agent shows no switch', async ($, on) => {
    await start($, on, workspace())
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /● commercecare/ })).toBeUndefined()
  })

  test('/rook agent lists, /rook agent use switches', async ($, on) => {
    const { world } = await start($, on, twoAgents())

    world.replies = { agent: LISTED, 'agent use': { code: 0, stdout: 'using refund-desk\n', writes: { [ACTIVE]: 'refund-desk\n' } } }
    expect((await $.command.run(command('agent'))).text).toContain('refund-desk  Refund Desk')
    expect((await $.command.run(command('agent use refund-desk'))).text).toBe('refund-desk is now the active agent. Runs, scenarios and reports follow it.')
  })
})

describe('depth · curating scenarios', () => {
  test('curate tool: rook scenarios exclude <ids> --json, and what rook did not know', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.replies = { 'scenarios exclude': { code: 0, stdout: JSON.stringify({ ok: true, verb: 'exclude', changed: ['SC-004'], unknown: ['SC-999'] }) } }
    const ran = (await $.tool.call({ tool: 'mcp__rook__curate', action: 'exclude', ids: ['SC-004', 'SC-999', 'SC-004'] } as never)) as Ran

    expect(world.invocations).toEqual([['rook', 'scenarios', 'exclude', 'SC-004', 'SC-999', '--json']])
    expect(asText(ran)).toContain('rook: excluded SC-004.')
    expect(asText(ran)).toContain('No such scenario here: SC-999.')
  })

  test('curate tool: ids that are not scenario ids, and delete, never reach the CLI', async ($, on) => {
    const { world } = await start($, on, workspace())

    expect(asText((await $.tool.call({ tool: 'mcp__rook__curate', action: 'exclude', ids: ['SC-1 --json'] } as never)) as Ran)).toContain('not scenario ids')
    expect(asText((await $.tool.call({ tool: 'mcp__rook__curate', action: 'delete', ids: ['SC-004'] } as never)) as Ran)).toContain('not offered here')
    expect(asText((await $.tool.call({ tool: 'mcp__rook__curate', action: 'include', ids: [] } as never)) as Ran)).toContain('between 1 and 200')
    expect(world.invocations).toEqual([])
  })

  test('/rook scenarios include and exclude; delete stays a terminal command, even typed at the prompt', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.replies = { 'scenarios include': { code: 0, stdout: JSON.stringify({ ok: true, verb: 'include', changed: [], unknown: [] }) } }
    expect((await $.command.run(command('scenarios include SC-004,SC-007'))).text).toBe('nothing changed — already included.')
    expect(world.invocations.at(-1)).toEqual(['rook', 'scenarios', 'include', 'SC-004', 'SC-007', '--json'])

    expect((await $.command.run(command('scenarios delete SC-004'))).text).toContain('rook scenarios delete <ids>` in a terminal')
    expect(world.invocations.filter(argv => argv[2] === 'delete')).toEqual([])
  })
})

describe('depth · credit balance', () => {
  test('fetched once at session start and shown in the pane header, not on every poll', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    await clock.advance(10)
    await clock.advance(9_000)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(world.planChecks).toBe(1)
    expect(await ui.find({ text: /120\.5 credits left/ })).toBeDefined()
  })

  test('when rook cannot say, the header shows no balance', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.plan = { code: 0, stdout: JSON.stringify({ username: 'dev', credits: null }) }
    await clock.advance(10)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: /credits left/ })).toBeUndefined()
  })

  test('the status tool includes it', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.status = { code: 0, stdout: JSON.stringify({ project_id: 'P', agents: [{ local_id: 'commercecare', tree: 'clean' }] }) }
    expect(asText((await $.tool.call({ tool: 'mcp__rook__status' } as never)) as Ran)).toContain('Credit balance: 120.5 credits left')
  })

  test('re-read after a run, and the run result warns when it will not cover the re-test', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    await clock.advance(10)
    freshRun(world, { 'SC-004': VERDICT_FAIL.replaceAll(NEW_RUN, FRESH_RUN) }, [0, 1, 0])
    world.plan = { code: 0, stdout: JSON.stringify({ credits: 1.5 }) }
    const ran = (await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-004'] } as never)) as Ran

    expect(world.planChecks).toBe(2)
    expect(asText(ran)).toContain("Credit balance: 1.5 credits, less than the ~4 credits re-testing 1 scenario would take at this run's rate.")

    freshRun(world, { 'SC-004': VERDICT_FAIL.replaceAll(NEW_RUN, FRESH_RUN) }, [0, 1, 0])
    world.plan = { code: 0, stdout: JSON.stringify({ credits: 500 }) }
    expect(asText((await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-004'] } as never)) as Ran)).not.toContain('Credit balance')
  })
})

