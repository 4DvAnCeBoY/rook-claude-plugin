import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { KEYS_HINT } from '../hooks/views/fresh'
import { BAND, command, PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, CWD, HOME, NEW_RUN, workspace } from './fixtures/workspace'

/**
 * Keys: the pane takes the keyboard when the person asked for it and never
 * on its own; every action a tab offers has a key; a folder without rook gets
 * a guided start; an agent never run here leads with what is missing.
 */

const PLUGIN = 'rook'
type On = Parameters<typeof worldOf>[0]
type Ran = { result?: unknown; deny?: string; text?: string }

/** Keys other features own in the pane: the tabs, the lens, back, confirm, cancel, open and the letters set aside. */
const RESERVED = new Set([...'12345', ...'lbycorfvxdeptgkansw', 'm'])
/** Reused on purpose, each with the meaning it has elsewhere: Run (r), Cancel on the confirm bar (n). */
const SAME_MEANING = new Set(['r', 'n', 'y'])

async function start($: Engine, on: On, files: Record<string, string>) {
  const world = worldOf(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })
  const fills: string[] = []
  const configured: { key: string; value: unknown }[] = []
  const config: { deny?: string } = {}

  on('prompt.fill', ($, e) => {
    fills.push(e.text)

    return { isFilled: true, box: { text: e.text, cursor: e.text.length } } as never
  })
  on('config.set', ($, e) => {
    configured.push({ key: e.key, value: e.value })

    return config.deny === undefined ? { value: e.value } : { deny: config.deny }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)
  await clock.advance(10)

  return { world, clock, opens: world.opens, fills, configured, config }
}

const mountPane = ($: Engine, isFocused = false) =>
  $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: { ...PANE.props, isFocused }, requestId: 'rook', viewport: PANE.viewport })

/** Every Button drawn, with its key and hotkey. */
async function buttons(ui: Awaited<ReturnType<typeof mountPane>>): Promise<{ key: string; hotkey: string | undefined }[]> {
  return (await ui.findAll({ type: 'Button' })).map(button => ({ key: button.key ?? '', hotkey: button.props.hotkey as string | undefined }))
}

/** A fresh folder: agent code, a PRD, a connection doc and CI, and no `.testmuai/rook/`. */
const FRESH = {
  'main.py': 'from agents import Agent, Runner\n',
  'PRD.md': '# Support\n## Refunds\n',
  'connection.md': 'curl https://staging.example/agent',
  '.github/workflows/ci.yml': 'jobs: {}\n',
  'node_modules/x/index.js': "require('@openai/agents')",
}

/** The fixture workspace as pulled from git: an agent, scenarios and a profile, no runs. */
function neverRun(overrides: Record<string, string> = {}): Record<string, string> {
  const files = workspace(overrides)

  for (const path of Object.keys(files)) {
    if (path.includes('/runs/')) delete files[path]
  }

  return files
}

describe('keys · who gets the keyboard', () => {
  test('session start opens the pane without the keys; /rook and /rook tab take them', async ($, on) => {
    const { opens } = await start($, on, workspace())

    expect(opens).toEqual([{ id: 'rook' }])

    await $.command.run(command(''))
    await $.command.run(command('tab runs'))

    expect(opens.slice(1)).toEqual([
      { id: 'rook', focus: true },
      { id: 'rook', focus: true },
    ])
  })

  test("Claude's run opens it without the keys; the card's Open in pane takes them", async ($, on) => {
    const { opens, world } = await start($, on, workspace())

    opens.length = 0
    const ran = (await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-004'] } as never)) as Ran

    expect(opens).toEqual([{ id: 'rook' }])

    const card = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_1',
      props: { tool_use_id: 'toolu_1', tool: 'mcp__rook__report', output: (await $.tool.call({ tool: 'mcp__rook__report' } as never) as Ran).result, isErrored: false },
      viewport: PANE.viewport,
    } as never)

    expect(typeof ran.result).toBe('string')
    expect((await card.find({ key: 'card-open' }))?.props.hotkey).toBe('o')
    expect((await card.find({ key: 'card-fix' }))?.props.hotkey).toBe('x')
    world.opened = []
    await card.press({ key: 'card-open' })
    expect(opens.at(-1)).toEqual({ id: 'rook', focus: true })
    await card.unmount()
  })

  test('the tab bar says how to drive the pane, under the tabs, focused or not', async ($, on) => {
    await start($, on, workspace())

    for (const isFocused of [false, true]) {
      const ui = await mountPane($, isFocused)

      expect((await ui.find({ key: 'tabs-hint-row' }))?.text).toContain('Tab move · Enter press · 1-5 tabs · Esc prompt')
      expect((await ui.find({ key: 'lens' }))?.text).toContain('view: QE')
      await ui.unmount()
    }
  })
})

describe('keys · every pane action has a key', () => {
  const valid = (hotkey: string | undefined) => hotkey !== undefined && /^[0-9a-z]$/.test(hotkey)

  test('Scenarios: filters, select all, clear, run selected, exclude, include, generate — each its own key', async ($, on) => {
    await start($, on, workspace())
    await $.command.run(command('tab scenarios'))
    const ui = await mountPane($, true)

    await ui.press({ key: 'sel-SC-004' })
    const drawn = (await buttons(ui)).filter(button => !button.key.startsWith('tab-') && button.key !== 'lens' && !/^(sel|sc)-SC-/.test(button.key))

    expect(drawn.map(b => b.key).sort()).toEqual(
      ['exclude-selected', 'filter-adversarial', 'filter-failing', 'filter-functional', 'filter-never', 'filter-unverifiable', 'generate', 'include-selected', 'run-selected', 'select-all', 'select-clear'].sort(),
    )
    for (const button of drawn) {
      expect(valid(button.hotkey), button.key).toBe(true)
      expect(!RESERVED.has(button.hotkey!) || SAME_MEANING.has(button.hotkey!), `${button.key} uses ${button.hotkey}`).toBe(true)
    }

    const all = (await buttons(ui)).map(b => b.hotkey).filter(Boolean)
    expect(new Set(all).size).toBe(all.length) // no two buttons on screen share a key
    expect((await ui.find({ key: 'run-selected' }))?.props.autoFocus).toBe(true)

    // the key reaches the same action: the never-run filter, then drawn as the open one with its key
    await ui.press({ key: 'filter-never' })
    expect(await ui.find({ key: 'filter-never' })).toBeUndefined()
    expect(await ui.find({ text: '8: never run' })).toBeDefined()
    await ui.unmount()
  })

  test('Setup: use, test, refresh, sync, check sync, budget off and the settings — each its own key', async ($, on) => {
    const files = workspace({ [`${AGENT_DIR}/profiles/http.yaml`]: 'id: http\nname: http\n' })
    await start($, on, files)
    await $.command.run(command('budget 20'))
    await $.command.run(command('tab setup'))
    const ui = await mountPane($, true)
    const drawn = await buttons(ui)
    const keyOf = (key: string) => drawn.find(b => b.key === key)?.hotkey

    expect(keyOf('use-http')).toBe('u')
    expect(keyOf('test-commerce-http')).toBe('i')
    expect(keyOf('test-http')).toBeUndefined() // one Test key: the active profile's
    expect(keyOf('refresh-setup')).toBe('h')
    expect(keyOf('sync-upstream')).toBe('q')
    expect(keyOf('check-sync')).toBe('0')
    expect(keyOf('budget-off')).toBe('z')
    expect(keyOf('setting-pane')).toBe('6')
    expect(keyOf('setting-retestBand')).toBe('7')
    expect(keyOf('setting-failureContext')).toBe('8')
    expect(keyOf('setting-prodGuard')).toBeUndefined() // turned off deliberately, never by a stray key

    const all = drawn.map(b => b.hotkey).filter(Boolean)
    expect(new Set(all).size).toBe(all.length)
    for (const button of drawn.filter(b => b.hotkey !== undefined && !b.key.startsWith('tab-') && b.key !== 'lens')) {
      expect(!RESERVED.has(button.hotkey!) || SAME_MEANING.has(button.hotkey!), `${button.key} uses ${button.hotkey}`).toBe(true)
    }
    await ui.unmount()
  })

  test('the confirm bar: Confirm y, Cancel n; the re-test band: Re-test a, Details i, Dismiss z', async ($, on) => {
    await start($, on, workspace())
    const ui = await mountPane($, true)

    await ui.press({ key: 'run-all' })
    expect((await ui.find({ key: 'confirm-yes' }))?.props.hotkey).toBe('y')
    expect((await ui.find({ key: 'confirm-no' }))?.props.hotkey).toBe('n')
    await ui.press({ key: 'confirm-no' })
    expect(await ui.find({ key: 'confirm-yes' })).toBeUndefined()
    await ui.unmount()

    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/tools.mjs`, old_string: 'a', new_string: 'b' } as never)
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND.props, requestId: 'band', viewport: BAND.viewport })

    expect((await band.find({ key: 'retest' }))?.props.hotkey).toBe('a')
    expect((await band.find({ key: 'details' }))?.props.hotkey).toBe('i')
    expect((await band.find({ key: 'dismiss' }))?.props.hotkey).toBe('z')
    await band.unmount()
  })
})

describe('keys · a folder without rook', () => {
  test('the scan lands on the snapshot once, and the pane shows what it found and the next step', async ($, on) => {
    const { world, clock } = await start($, on, FRESH)
    const ui = await mountPane($, true)

    expect(await ui.find({ text: "rook isn't set up in this folder" })).toBeDefined()
    expect(await ui.find({ text: 'Found in this repo' })).toBeDefined()
    expect((await ui.find({ key: 'found-main.py' }))?.text).toContain('an agent: OpenAI Agents SDK')
    expect((await ui.find({ key: 'found-PRD.md' }))?.text).toContain('requirements: 2 headings')
    expect((await ui.find({ key: 'found-connection.md' }))?.text).toContain('how to reach the agent')
    expect((await ui.find({ key: 'found-.github/workflows/ci.yml' }))?.text).toContain('CI workflow')
    expect(await ui.find({ key: 'found-node_modules/x/index.js' })).toBeUndefined()
    expect((await ui.find({ key: 's-project' }))?.text).toBe('✗ no project selected')

    // the next step's button holds the ring; the other way beside it
    const go = await ui.find({ key: 'start-go' })
    expect(go?.props.label).toBe('Create project “work”')
    expect(go?.props.autoFocus).toBe(true)
    expect(go?.props.hotkey).toBe('j')
    expect((await ui.find({ key: 'start-other' }))?.props.hotkey).toBe('u')

    // one scan per top-level listing: polls with nothing new read nothing again
    const reads = world.files.size
    await clock.advance(9_000)
    expect(world.files.size).toBe(reads)

    await ui.press({ key: 'start-other' })
    expect(world.submitted.at(-1)).toContain('rook project tool')

    world.replies['project create'] = { code: 0, stdout: 'created project work (01M0EXAMP1EPR0JECT0000000B) and selected it\n' }
    await ui.press({ key: 'start-go' })
    expect(world.invocations.at(-1)).toEqual(['rook', 'project', 'create', 'work'])
    expect(world.toasts.at(-1)).toContain('created project work')
    await ui.unmount()
  })

  test('a project and no agent: Explore waits behind the confirm bar, then runs told where the agent is', async ($, on) => {
    const { world, clock } = await start($, on, { ...FRESH, '.testmuai/rook/settings.json': JSON.stringify({ version: 1, active_project_id: '01M0EXAMP1EPR0JECT0000000A' }) })
    const ui = await mountPane($, true)

    expect(await ui.find({ text: "rook isn't set up in this folder" })).toBeUndefined() // the workspace exists
    expect(await ui.find({ text: 'rook · setup' })).toBeDefined()
    expect((await ui.find({ key: 'start-go' }))?.props.label).toBe('Explore the agent (spends credits)')

    await ui.press({ key: 'start-go' })
    expect(world.invocations.some(argv => argv[1] === 'explore')).toBe(false)
    expect((await ui.find({ text: /Explore this repository/ }))?.text).toContain('spends credits')
    expect((await ui.find({ text: /Explore this repository/ }))?.text).not.toContain('calls your agent')

    world.onRun = () => ({ code: 0, stdout: 'nothing changed\n' })
    await ui.press({ key: 'confirm-yes' })
    await clock.advance(10)

    const explore = world.invocations.find(argv => argv[1] === 'explore')
    expect(explore?.slice(0, 3)).toEqual(['rook', 'explore', '.'])
    expect(explore?.join(' ')).toContain('The agent is in main.py (OpenAI Agents SDK).')
    await ui.unmount()
  })
})

describe('keys · an agent never run here', () => {
  test('the Release tab leads with the missing variables and their exact command, into the prompt', async ($, on) => {
    const { fills } = await start($, on, neverRun())
    const ui = await mountPane($, true)

    expect(await ui.find({ text: 'Before the first run' })).toBeDefined()
    expect((await ui.find({ key: 'start-s-env' }))?.text).toContain('COMMERCE_BASE_URL, DEMO_API_TOKEN unset for commerce-http')
    expect((await ui.find({ key: 'start-next' }))?.text).toContain(`! rook env set '{"COMMERCE_BASE_URL":"…","DEMO_API_TOKEN":"…"}'`)
    expect((await ui.find({ key: 'start-s-verify' }))?.text).toContain('commerce-http not tested yet')
    expect((await ui.find({ key: 'start-s-run' }))?.text).toContain('no runs yet')
    expect((await ui.find({ key: 'start-go' }))?.props.autoFocus).toBe(true)

    await ui.press({ key: 'start-go' })
    expect(fills).toEqual([`! rook env set '{"COMMERCE_BASE_URL":"…","DEMO_API_TOKEN":"…"}'`])
    await ui.unmount()
  })

  test('variables set: Test the profile (one call, behind the confirm bar) before the first run', async ($, on) => {
    const env = JSON.stringify({ version: 1, projects: { [CWD]: { COMMERCE_BASE_URL: 'https://x', DEMO_API_TOKEN: 't' } } })
    const { world, clock } = await start($, on, neverRun({ [`${HOME}/.testmuai/rook/env.json`]: env }))
    await $.command.run(command('tab setup'))
    const ui = await mountPane($, true)

    expect((await ui.find({ key: 'start-go' }))?.props.label).toBe('Test commerce-http: one call (spends credits)')
    await ui.press({ key: 'start-go' })
    expect((await ui.find({ text: /Test profile commerce-http/ }))?.text).toContain('one call to your agent')

    world.onRun = () => ({ code: 0, stdout: 'commerce-http: answered — verified\n', writes: { [`${AGENT_DIR}/state.json`]: JSON.stringify({ verified_profiles: { 'commerce-http': 'now' } }) } })
    await ui.press({ key: 'confirm-yes' })
    await clock.advance(10)
    expect(world.invocations.at(-1)?.slice(0, 4)).toEqual(['rook', 'profile', 'test', 'commerce-http'])

    // verified: the first run is next
    expect((await ui.find({ key: 'start-go' }))?.props.label).toBe('First run: 3 scenarios (spends credits)')
    await ui.unmount()
  })

  test('once it has run, nothing leads', async ($, on) => {
    await start($, on, workspace())
    const ui = await mountPane($)

    expect(await ui.find({ text: 'Before the first run' })).toBeUndefined()
    expect(await ui.find({ key: 'start-go' })).toBeUndefined()
    expect((await ui.find({ key: 'latest' }))?.text ?? (await ui.find({ text: new RegExp(NEW_RUN) }))?.text).toContain(NEW_RUN)
    await ui.unmount()
  })
})

describe('keys · settings in the Setup tab', () => {
  test('each option with its value; a toggle writes the plugin’s own /config row and applies at once', async ($, on) => {
    const { configured, world } = await start($, on, workspace())
    await $.command.run(command('tab setup'))
    const ui = await mountPane($, true)

    expect((await ui.find({ key: 'setting-pane' }))?.props.label).toBe('Pane opens: auto (at session start)')
    expect((await ui.find({ key: 'setting-retestBand' }))?.props.label).toBe('Re-test band: on')
    expect((await ui.find({ key: 'setting-failureContext' }))?.props.label).toBe('Failures as context: on')
    expect((await ui.find({ key: 'setting-prodGuard' }))?.props.label).toBe('Production guard: on')
    expect((await ui.find({ key: 'setting-lens' }))?.props.label).toBe('Pane view: QE')
    expect((await ui.find({ key: 'set-retestBand' }))?.text).toContain('kept')

    await ui.press({ key: 'setting-retestBand' })
    expect(configured.at(-1)).toEqual({ key: 'rook.retestBand', value: false })
    expect((await ui.find({ key: 'setting-retestBand' }))?.props.label).toBe('Re-test band: off')

    // applied now: an edit to the agent raises no band
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/tools.mjs`, old_string: 'a', new_string: 'b' } as never)
    const band = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND.props, requestId: 'band', viewport: BAND.viewport })
    expect(await band.find({ key: 'retest' })).toBeUndefined()
    await band.unmount()

    await ui.press({ key: 'setting-pane' })
    expect(configured.at(-1)).toEqual({ key: 'rook.pane', value: 'command' })

    await ui.press({ key: 'setting-lens' })
    expect((await ui.find({ key: 'setting-lens' }))?.props.label).toBe('Pane view: Developer')
    expect(world.toasts.some(text => text.includes('this session'))).toBe(false)
    await ui.unmount()
  })

  test('when /config refuses, the change holds for this session and the row says so', async ($, on) => {
    const { world, config } = await start($, on, workspace())
    config.deny = 'managed by your organization'
    await $.command.run(command('tab setup'))
    const ui = await mountPane($, true)

    await ui.press({ key: 'setting-failureContext' })

    expect((await ui.find({ key: 'setting-failureContext' }))?.props.label).toBe('Failures as context: off')
    expect((await ui.find({ key: 'set-failureContext' }))?.text).toContain('this session')
    expect(world.toasts.at(-1)).toContain('managed by your organization')
    await ui.unmount()
  })

  test('the budget box sets a session budget; Budget off lifts it', async ($, on) => {
    const { world } = await start($, on, workspace())
    await $.command.run(command('tab setup'))
    const ui = await mountPane($, true)

    expect(await ui.find({ key: 'budget-off' })).toBeUndefined()
    await ui.input({ key: 'budget-input', text: '15' })
    expect(world.toasts.at(-1)).toContain('budget 15 credits')
    expect((await ui.find({ key: 'budget-off' }))?.props.hotkey).toBe('z')

    await ui.press({ key: 'budget-off' })
    expect(world.toasts.at(-1)).toContain('budget off')
    await ui.unmount()
  })
})

describe('keys · inline or docked', () => {
  test('inline above the prompt, the pane says how to get the side pane; docked, it says nothing', async ($, on) => {
    await start($, on, workspace())
    const docked = await mountPane($)

    expect(await docked.find({ key: 'inline-hint' })).toBeUndefined()
    await docked.unmount()

    const inline = await $.ui.mount({ plugin: 'rook', surface: 'terminal', component: 'Pane', requestId: PANE.requestId, props: { ...PANE.props, placement: 'inline' }, viewport: { ...PANE.viewport!, isFullscreen: false } } as never)

    expect((await inline.find({ key: 'inline-hint' }))?.text).toContain('/tui fullscreen')
    await inline.unmount()
  })
})
