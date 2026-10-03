import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { command, PANE, SESSION, worldOf } from './fixtures/world'
import { workspace } from './fixtures/workspace'

/**
 * Readiness as the person meets it: the pane's checklist, refusals that name
 * the next step before anything runs, background failures that stay put, and
 * command output Claude Code already labels "rook:".
 */

type Ran = { result?: unknown; deny?: string; text?: string }

const asText = (ran: Ran): string => (typeof ran.result === 'string' ? ran.result : (ran.deny ?? ran.text ?? JSON.stringify(ran)))

const YAML_SETTINGS = "version: 1\ncreated: '2026-09-20T10:00:00.000Z'\nactive_entity: null\n"
const NO_PROJECT = "can't run yet: no project selected. Next: ask Claude to select a project (mcp__rook__project), or run `! rook project use <id>`."

/** A workspace with results whose settings select no project: rook would refuse to run. */
const noProject = () => workspace({ '.testmuai/rook/settings.json': YAML_SETTINGS })

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>, setup?: (world: ReturnType<typeof worldOf>) => void) {
  const world = worldOf(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })

  setup?.(world)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)
  await clock.advance(10) // the probes run just after start

  return { world, clock }
}

const mountPane = ($: Engine) => $.ui.mount({ plugin: 'rook', surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

describe('readiness · probes', () => {
  test('rook --version and rook auth status run once after start, not on every poll', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    expect(world.probes).toEqual([['rook', '--version'], ['rook', 'auth', 'status']])
    await clock.advance(9_000)
    expect(world.probes).toHaveLength(2)
  })
})

describe('readiness · no workspace', () => {
  test('/rook opens the pane and lists the checklist; scenarios, report and status give the same next step', async ($, on) => {
    const { world } = await start($, on, {})

    const pane = (await $.command.run(command(''))).text

    expect(pane).toContain('pane opened.')
    expect(pane).toContain('✗ no project selected')
    expect(pane).toContain('Next: ask Claude to select a project (mcp__rook__project)')

    for (const sub of ['scenarios', 'report', 'status']) {
      expect((await $.command.run(command(sub))).text, sub).toContain('Next: ask Claude to select a project (mcp__rook__project)')
    }

    // status is answered from the checklist: rook status would only refuse
    expect(world.invocations.filter(argv => argv[1] === 'status')).toEqual([])
  })

  test('/rook run and the run tool refuse up front, with the next step, and nothing is spawned', async ($, on) => {
    const { world } = await start($, on, {})

    expect((await $.command.run(command('run'))).text).toBe(NO_PROJECT)
    expect(asText((await $.tool.call({ tool: 'mcp__rook__run' } as never)) as Ran)).toBe(`rook ${NO_PROJECT}`)
    expect(world.invocations).toEqual([])
  })

  test('generate refuses until there is an agent', async ($, on) => {
    const { world } = await start($, on, {})

    expect((await $.command.run(command('generate'))).text).toBe(
      "can't generate scenarios yet: no project selected. Next: ask Claude to select a project (mcp__rook__project), or run `! rook project use <id>`.",
    )
    expect(asText((await $.tool.call({ tool: 'mcp__rook__generate' } as never)) as Ran)).toContain("can't generate scenarios yet")
    expect(world.invocations).toEqual([])
  })
})

describe('readiness · results but no project', () => {
  test('the pane keeps the results, warns, and offers no run', async ($, on) => {
    const { world } = await start($, on, noProject())
    const ui = await mountPane($)

    expect(await ui.find({ text: /rook · commercecare/ })).toBeDefined()
    expect(await ui.find({ text: '✗ 1 Fail' })).toBeDefined()
    expect((await ui.find({ key: 'run-block' }))?.text).toBe(`⚠ ${NO_PROJECT}`)
    expect(await ui.find({ key: 'run-all' })).toBeUndefined()
    expect(await ui.find({ key: 'rerun-failed' })).toBeUndefined()
    expect(await ui.find({ key: 'fix' })).toBeDefined() // fixing needs no run
    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 · 2 gaps · ↑1 fixed · setup: select a project')
  })

  test('/rook run refuses instead of saying "running in the background"', async ($, on) => {
    const { world } = await start($, on, noProject())

    expect((await $.command.run(command('run --only SC-004'))).text).toBe(NO_PROJECT)
    expect(world.invocations).toEqual([])
  })
})

describe('readiness · CLI facts', () => {
  test('signed out: the checklist says so, the status line hints, and a run is refused', async ($, on) => {
    const { world } = await start($, on, workspace(), w => {
      w.auth = { code: 1, stdout: 'not signed in — run `rook login`\n' }
    })

    expect(world.statuses.at(-1)).toBe('✓1 ✗1 ?1 · 2 gaps · ↑1 fixed · setup: sign in')
    expect((await $.command.run(command('run'))).text).toBe("can't run yet: not signed in. Next: run `! rook login` (it opens a browser).")
    expect(world.invocations).toEqual([])
  })

  test('signed in since: the refusal probes again and the run goes ahead', async ($, on) => {
    const { world } = await start($, on, workspace(), w => {
      w.auth = { code: 1, stdout: 'not signed in — run `rook login`\n' }
    })

    world.auth = { code: 0, stdout: 'signed in as dev · Org · team\n' }
    expect((await $.command.run(command('run'))).text).toContain('in the background')
  })

  test('rook not installed: the pane shows it first and offers Check again', async ($, on) => {
    const { world } = await start($, on, { '.testmuai/rook/settings.json': YAML_SETTINGS }, w => {
      w.isMissingBinary = true
    })
    const ui = await mountPane($)

    expect((await ui.find({ key: 's-installed' }))?.text).toBe('✗ rook not found')
    expect((await ui.find({ key: 'next' }))?.text).toContain('brew install lambdatest/rook/rook')
    expect(world.statuses.at(-1)).toBe('setup: install rook')

    world.isMissingBinary = false
    await ui.press({ key: 'recheck' })
    expect((await ui.find({ key: 's-installed' }))?.text).toBe('✓ rook 0.1.0')
  })
})

describe('readiness · background failures stay visible', () => {
  test("a pane run rook refuses: the reason stays in the pane until the next run", async ($, on) => {
    const { world, clock } = await start($, on, workspace())
    const ui = await mountPane($)

    world.onRun = () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: 'no project selected — run `rook project use <id>`', remedy: 'pick_project' }) })
    await ui.press({ key: 'run-all' })
    await clock.advance(10)

    expect((await ui.find({ key: 'last-error' }))?.text).toContain('last run failed: no project selected — run `rook project use <id>` (remedy: pick_project)')
    expect((await ui.find({ key: 'last-error' }))?.text).toContain('Next: ask Claude to select a project')
    await clock.advance(6_000)
    expect(await ui.find({ key: 'last-error' })).toBeDefined() // not a vanishing toast
    expect(await ui.find({ key: 'run-all' })).toBeUndefined() // rook said no project: no more Run all
  })

  test('a failed /rook generate stays in the pane', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    world.onRun = () => ({ code: 1, stdout: JSON.stringify({ ok: false, error: 'out of credits', remedy: 'topup' }) })
    expect((await $.command.run(command('generate'))).text).toContain('in the background')
    await clock.advance(10)
    const ui = await mountPane($)

    expect((await ui.find({ key: 'last-error' }))?.text).toBe('last generate failed: generate did not complete: out of credits (remedy: topup)')
  })
})

describe('readiness · command output never repeats "rook"', () => {
  test('pane, status failure, report and scenarios read cleanly after the "rook:" label', async ($, on) => {
    const { world } = await start($, on, workspace())

    world.status = { code: 1, stdout: JSON.stringify({ ok: false, error: 'rook-api answered 500' }) }

    for (const sub of ['', 'status', 'report', 'scenarios', 'explain']) {
      const text = (await $.command.run(command(sub))).text

      expect(text, sub).not.toMatch(/^rook\b/)
    }

    expect((await $.command.run(command(''))).text).toBe('pane opened.')
    expect((await $.command.run(command('status'))).text).toBe('status failed: rook-api answered 500')
    expect((await $.command.run(command('report'))).text).toMatch(/^run 2026-09-28T15-48-44Z \(hardened adversarial matrix\) against agent commercecare/)
  })
})
