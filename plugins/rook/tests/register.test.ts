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
  test('registers /rook and the five tools, opens the pane in a workspace, shows the score', async ($, on) => {
    const { world } = await start($, on, workspace())

    expect(world.commands).toEqual(['rook'])
    expect(world.tools.sort()).toEqual(['generate', 'report', 'run', 'scenarios', 'status'])
    expect(world.opened).toEqual(['rook'])
    expect(world.statuses.at(-1)).toBe('rook ✓1 ✗1 ?1 · 2 gaps · ↑1 fixed')
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
    expect(world.statuses.at(-1)).toBe('rook ▸ 2/3 · SC-007 starting · ✓1 ✗1 ?0')
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
    expect(asText(ran)).toContain('Spent: 4.25 credits.')
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

    expect(world.statuses.at(-1)).toBe('rook ▸ 1/1 · ✓0 ✗1 ?0')
    expect(world.appended).toEqual([])

    world.files.set(`${AGENT_DIR}/runs/${FRESH_RUN}/report.yaml`, reportYaml(FRESH_RUN, 0, 1, 0, 2))
    await clock.advance(3_000)
    await clock.advance(3_000)

    // Reported once, however many polls pass. The failure notes themselves go
    // through $.session.append, which the kit does not route to a test's
    // hooks: their text is held in logic.test.ts, the append in a live session.
    expect(world.toasts).toEqual([`rook: run ${FRESH_RUN} finished — 0 Pass · 1 Fail · 0 Unable to Verify`])
    // a one-scenario run moves one row: the agent is still 1 / 1 / 1, not "down one"
    expect(world.statuses.at(-1)).toBe('rook ✓1 ✗1 ?1')
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
    expect(world.statuses.at(-1)).toBe('rook ✓1 ✗1 ?1 · 2 gaps · ↑1 fixed')

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
    expect((await $.command.run(command('run'))).text).toBe('rook: a run is already in progress.')

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

    expect(explained.text).toBe("rook: handed the failure clusters, rook's remedies and the evidence to Claude.")
    expect(explained.context?.[0]).toContain('SC-004')
  })

  test('run: flags parsed and validated, run started in the background, one at a time', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    expect((await $.command.run(command('run --allow bash(*)'))).text).toContain('unknown run option')

    freshRun(world, { 'SC-002': VERDICT_PASS_GAP }, [1, 0, 0])
    expect((await $.command.run(command('run --only SC-002 --class functional'))).text).toContain('running SC-002 in the background')
    expect((await $.command.run(command('run'))).text).toBe('rook: a run is already in progress.')
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

    expect((await pending).text).toBe('rook: the viewer printed no address within 15s — running…')
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

