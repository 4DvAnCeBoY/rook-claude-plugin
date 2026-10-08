import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { budgetRefusal, envSetCommand, parseBudget, profileView, spentOf, syncArgs, syncStateOf, syncText, wizardOf } from '../hooks/setup'
import { command, PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, CWD, HOME, workspace } from './fixtures/workspace'

const PLUGIN = 'rook'
const SURFACES = ['terminal', 'desktop'] as const
const SECRET = 'tok-0123456789SECRETVALUE'

type Ran = { result?: unknown; deny?: string; text?: string }

const asText = (ran: Ran): string => (typeof ran.result === 'string' ? ran.result : (ran.deny ?? ran.text ?? JSON.stringify(ran)))

/** A profile as rook 5be0db96 writes it: scripts per step, and the variables they read. */
const PROFILE_HTTP = `id: http
name: http
hooks:
  open: hooks/open.mjs
  execute:
    script: hooks/execute.mjs
    timeout_seconds: 300
  collect: hooks/collect.mjs
env:
  - variable: SHOP_TOKEN
    purpose: bearer token for the staging shop
  - variable: SHOP_BASE_URL
`

const ENV_FILE = `${HOME}/.testmuai/rook/env.json`

/** The fixture workspace with a second profile, rook's env store holding one of its variables, and state.json verifying commerce-http. */
function withProfiles(overrides: Record<string, string> = {}): Record<string, string> {
  return workspace({
    [`${AGENT_DIR}/profiles/http.yaml`]: PROFILE_HTTP,
    [`${AGENT_DIR}/state.json`]: JSON.stringify({ version: 1, verified_profiles: { 'commerce-http': '2026-10-01T10:00:00Z' } }),
    [ENV_FILE]: JSON.stringify({
      version: 1,
      projects: { [CWD]: { SHOP_TOKEN: SECRET, COMMERCE_BASE_URL: 'https://env-only.shop.example', DEMO_API_TOKEN: `${SECRET}-2` } },
    }),
    ...overrides,
  })
}

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
  const world = worldOf(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })

  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return { world, clock }
}

async function setupTab($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  await $.command.run(command('tab setup'))

  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })
}

describe('setup tab · profiles', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: every profile with its target, verified or not, and its variables set or unset — never a value`, async ($, on) => {
      await start($, on, withProfiles())
      const ui = await setupTab($, surface)

      expect(await ui.find({ text: 'rook · setup' })).toBeDefined()
      expect(await ui.find({ text: /✓ profile commerce-http/ })).toBeDefined() // the checklist is still there

      const active = (await ui.find({ key: 'pl-commerce-http' }))?.text ?? ''
      expect(active).toContain('● commerce-http')
      expect(active).toContain('active')
      expect(active).toContain('· verified')
      expect(active).toContain('https://staging.shop.example/v1/agent')

      const other = (await ui.find({ key: 'pl-http' }))?.text ?? ''
      expect(other).toContain('○ http')
      expect(other).toContain('not verified')
      expect(other).toContain('script hooks/execute.mjs')
      expect((await ui.find({ key: 'ps-http' }))?.text).toContain('open, execute, collect')

      expect((await ui.find({ key: 'v-http-SHOP_TOKEN' }))?.text).toContain('✓ SHOP_TOKEN set')
      expect((await ui.find({ key: 'v-http-SHOP_BASE_URL' }))?.text).toContain('✗ SHOP_BASE_URL unset')
      expect((await ui.find({ key: 'v-commerce-http-DEMO_API_TOKEN' }))?.text).toContain('set')

      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).not.toContain(SECRET)
      expect(drawn).not.toContain('env-only.shop.example')

      // Use on the other profile, Test on any; the active one has no Use
      expect(await ui.find({ key: 'use-commerce-http' })).toBeUndefined()
      expect(await ui.find({ key: 'use-http' })).toBeDefined()
      expect(await ui.find({ key: 'test-commerce-http' })).toBeDefined()

      // the active profile is verified and its variables are set: no wizard
      expect(await ui.find({ text: /Reaching the agent/ })).toBeUndefined()
      await ui.unmount()
    })
  }

  test('Use switches the profile through rook profile use', async ($, on) => {
    const { world } = await start($, on, withProfiles())
    world.replies['profile use'] = { code: 0, stdout: 'active profile: http\n', writes: { [`${AGENT_DIR}/profiles/active`]: 'http\n' } }
    const ui = await setupTab($)

    await ui.press({ key: 'use-http' })

    expect(world.invocations.at(-1)).toEqual(['rook', 'profile', 'use', 'http'])
    expect(world.toasts.at(-1)).toContain('active profile: http')
    await ui.unmount()
  })

  test('Test waits behind the Confirm bar (it spends credits), then calls the agent once', async ($, on) => {
    const { world, clock } = await start($, on, withProfiles())
    world.onRun = () => ({ code: 0, stdout: 'http: answered in 812ms — verified\n' })
    const ui = await setupTab($)
    const before = world.invocations.length

    await ui.press({ key: 'test-http' })

    expect(world.invocations.length).toBe(before) // nothing ran yet
    expect((await ui.find({ text: /Test profile http/ }))?.text).toContain('spends credits')

    await ui.press({ key: 'confirm-yes' })
    await clock.advance(10)

    expect(world.invocations.at(-1)?.slice(0, 4)).toEqual(['rook', 'profile', 'test', 'http'])
    expect(world.toasts.some(text => text.includes('testing http'))).toBe(true)
    await ui.unmount()
  })
})

describe('setup tab · profile wizard', () => {
  test('pure: no profile → profile add from the connection file found; unset variables → env set per name', () => {
    expect(wizardOf([], 'connection.md')?.commands[0]?.text).toBe('! rook profile add http --from connection.md')
    expect(wizardOf([], 'openapi.yaml')?.commands[0]?.text).toBe('! rook profile add http --from openapi.yaml')
    expect(wizardOf([], undefined)?.commands[0]?.why).toContain('first write connection.md')

    const view = profileView('http', PROFILE_HTTP, true, false, new Set(['SHOP_TOKEN']))
    const wizard = wizardOf([view], undefined)

    expect(wizard?.reason).toBe('http is not verified · 1 variable unset')
    expect(wizard?.defined).toEqual(['open', 'execute', 'collect'])
    expect(wizard?.commands.map(c => c.text)).toEqual([`! rook env set '{"SHOP_BASE_URL":"…"}'`, '/rook profile test http'])
    expect(envSetCommand('X')).toBe(`! rook env set '{"X":"…"}'`)
    expect(wizardOf([profileView('http', PROFILE_HTTP, true, true, new Set(['SHOP_TOKEN', 'SHOP_BASE_URL']))], undefined)).toBeUndefined()
  })

  for (const surface of SURFACES) {
    test(`on ${surface}: with no profile on disk, the five steps and the exact command for the connection file in the repo`, async ($, on) => {
      const files = withProfiles({ 'connection.md': 'curl https://staging.shop.example/v1/agent -d …', 'README.md': '# shop' })
      delete files[`${AGENT_DIR}/profiles/http.yaml`]
      delete files[`${AGENT_DIR}/profiles/commerce-http.yaml`]
      delete files[`${AGENT_DIR}/profiles/active`]
      await start($, on, files)
      const ui = await setupTab($, surface)

      expect(await ui.find({ text: /Reaching the agent: no profile yet/ })).toBeDefined()
      for (const step of ['prepare', 'open', 'execute', 'close', 'collect']) {
        expect(await ui.find({ key: `ws-${step}` })).toBeDefined()
      }
      expect(await ui.find({ text: 'found connection.md in the repository root' })).toBeDefined()
      expect((await ui.find({ key: 'w-text-0' }))?.text?.trim()).toBe('! rook profile add http --from connection.md')
      await ui.unmount()
    })
  }

  test('the active profile unverified with a variable unset: env set for it, then profile test', async ($, on) => {
    await start($, on, withProfiles({ [`${AGENT_DIR}/profiles/active`]: 'http\n' }))
    const ui = await setupTab($)

    expect(await ui.find({ text: /http is not verified · 1 variable unset/ })).toBeDefined()
    expect((await ui.find({ key: 'w-text-0' }))?.text?.trim()).toBe(`! rook env set '{"SHOP_BASE_URL":"…"}'`)
    expect((await ui.find({ key: 'w-text-1' }))?.text?.trim()).toBe('/rook profile test http')
    expect(JSON.stringify(await ui.drawn())).not.toContain(SECRET)
    await ui.unmount()
  })
})

const STATUS_AHEAD = JSON.stringify({
  project_id: 'P',
  offline: false,
  agents: [
    { local_id: 'commercecare', name: 'CommerceCare', tree: 'ahead', local_version_number: 3, features: { added: [], changed: [], removed: [] }, scenarios: { added: ['SC-007'], changed: ['SC-004'], removed: [] }, profiles: { added: [], changed: [], removed: [] }, unfinished_runs: 0, owed_runs: 0 },
  ],
})
const STATUS_CLEAN = JSON.stringify({
  project_id: 'P',
  offline: false,
  agents: [{ local_id: 'commercecare', name: 'CommerceCare', tree: 'clean', local_version_number: 4, features: {}, scenarios: {}, profiles: {}, unfinished_runs: 0, owed_runs: 0 }],
})
const SYNC_SAID = 'commercecare: 1 scenario added: SC-007\ncommercecare: 1 scenario changed: SC-004\ncommercecare: recorded\n1 agent(s) recorded\n'

describe('setup tab · sync', () => {
  test('pure: argv, prose read back, status read back', () => {
    expect(syncArgs()).toEqual({ argv: ['sync'] })
    expect(syncArgs('commercecare')).toEqual({ argv: ['sync', '--agent', 'commercecare'] })
    expect(syncArgs('--yes')).toHaveProperty('error')

    const said = syncText(0, SYNC_SAID, '')
    expect(said.split('\n')[0]).toBe('rook sync: 1 agent(s) recorded')
    expect(said).toContain('SC-007')
    expect(said).toContain('no credits')
    expect(syncText(1, '', 'no active project — rook project use <id>\n')).toBe('rook sync failed: no active project — rook project use <id>')

    const state = syncStateOf(JSON.parse(STATUS_AHEAD), 5)
    expect(state.agents[0]).toEqual({ id: 'commercecare', tree: 'ahead', version: 3, changes: ['1 scenario added: SC-007', '1 scenario changed: SC-004'], owedRuns: 0 })
  })

  test('/rook sync runs rook sync with a fake rook, then reads rook status --json', async ($, on) => {
    const { world } = await start($, on, workspace())
    world.onRun = argv => ({ code: 0, stdout: argv[1] === 'sync' ? SYNC_SAID : '' })
    world.status = { code: 0, stdout: STATUS_CLEAN }

    const ran = (await $.command.run(command('sync'))) as Ran

    expect(world.invocations.some(argv => argv.join(' ') === 'rook sync')).toBe(true)
    expect(world.invocations.at(-1)).toEqual(['rook', 'status', '--json'])
    expect(asText(ran)).toContain('sync: 1 agent(s) recorded')
    expect(asText(ran)).toContain('commercecare v4 · up to date')
    expect(asText(ran)).toContain('no credits')
  })

  test('the sync tool: check reports the state and writes nothing; agent narrows the sync', async ($, on) => {
    const { world } = await start($, on, workspace())
    world.status = { code: 0, stdout: STATUS_AHEAD }

    const checked = asText((await $.tool.call({ tool: 'mcp__rook__sync', check: true } as never)) as Ran)

    expect(checked).toContain('commercecare v3 · local work not recorded upstream')
    expect(checked).toContain('1 scenario added: SC-007')
    expect(world.invocations.some(argv => argv[1] === 'sync')).toBe(false)

    world.onRun = () => ({ code: 0, stdout: SYNC_SAID })
    world.status = { code: 0, stdout: STATUS_CLEAN }
    const synced = asText((await $.tool.call({ tool: 'mcp__rook__sync', agent: 'commercecare' } as never)) as Ran)

    expect(world.invocations.find(argv => argv[1] === 'sync')).toEqual(['rook', 'sync', '--agent', 'commercecare'])
    expect(synced).toContain('up to date')
  })

  test('a failed sync says why', async ($, on) => {
    const { world } = await start($, on, workspace())
    world.onRun = () => ({ code: 1, stdout: '', stderr: 'could not reach rook-api\n' })

    const ran = asText((await $.command.run(command('sync'))) as Ran)

    expect(ran).toContain('sync failed: could not reach rook-api')
  })

  for (const surface of SURFACES) {
    test(`on ${surface}: the tab checks the sync state and syncs upstream`, async ($, on) => {
      const { world } = await start($, on, workspace())
      world.status = { code: 0, stdout: STATUS_AHEAD }
      const ui = await setupTab($, surface)

      expect(await ui.find({ text: 'sync state not checked yet.' })).toBeDefined()
      expect(await ui.find({ text: /no credits/ })).toBeDefined()

      await ui.press({ key: 'check-sync' })
      expect((await ui.find({ key: 'sy-commercecare' }))?.text).toContain('local work not recorded upstream')

      world.onRun = () => ({ code: 0, stdout: SYNC_SAID })
      world.status = { code: 0, stdout: STATUS_CLEAN }
      await ui.press({ key: 'sync-upstream' })

      expect(world.invocations.some(argv => argv.join(' ') === 'rook sync')).toBe(true)
      expect((await ui.find({ key: 'sy-commercecare' }))?.text).toContain('v4 · up to date')
      expect((await ui.find({ key: 'sync-said' }))?.text).toContain('1 agent(s) recorded')
      await ui.unmount()
    })
  }
})

describe('budget', () => {
  test('pure: parse, spent from the balance, refuse or allow', () => {
    expect(parseBudget(['50'])).toBe(50)
    expect(parseBudget(['off'])).toBeNull()
    expect(parseBudget([])).toBeUndefined()
    expect(parseBudget(['status'])).toBeUndefined()
    expect(parseBudget(['-5'])).toHaveProperty('error')

    expect(spentOf({ limit: 10, spent: 0, startBalance: 120.5 }, 115)).toBe(5.5)
    expect(spentOf({ limit: 10, spent: 2, startBalance: 120.5 }, null)).toBe(2)

    expect(budgetRefusal(null, 'run', 1000)).toBeUndefined()
    expect(budgetRefusal({ limit: 10, spent: 5.5 }, 'run', 4)).toBeUndefined()
    expect(budgetRefusal({ limit: 10, spent: 5.5 }, 'run', 12.5)).toContain('would take about 12.5 credits, more than the 4.5 credits left')
    expect(budgetRefusal({ limit: 10, spent: 10 }, 'generate', undefined)).toContain('budget reached')
  })

  test('/rook budget sets, reports and lifts it; runs past it are refused, runs inside it start', async ($, on) => {
    const { world, clock } = await start($, on, workspace())

    expect(asText((await $.command.run(command('budget 10'))) as Ran)).toContain('budget 10 credits · 0 credits spent · 10 credits left')

    world.plan = { code: 0, stdout: JSON.stringify({ credits: 115 }) } // 5.5 spent since
    expect(asText((await $.command.run(command('budget'))) as Ran)).toContain('5.5 credits spent · 4.5 credits left')

    // the whole suite at the latest run's rate (12.5 credits for 3 scenarios) does not fit
    const all = asText((await $.command.run(command('run'))) as Ran)
    expect(all).toContain('would take about 12.5 credits')
    expect(world.invocations.some(argv => argv[1] === 'run')).toBe(false)

    // one scenario (~4.17) does
    expect(asText((await $.command.run(command('run --only SC-004'))) as Ran)).toContain('running SC-004')
    await clock.advance(10) // the background run lands; the balance is unchanged by the fake

    // the model's run is refused the same way
    const denied = (await $.tool.call({ tool: 'mcp__rook__run' } as never)) as Ran
    expect(denied.deny).toContain('budget')

    // a generate is assumed to cost more than is left
    const generated = asText((await $.tool.call({ tool: 'mcp__rook__generate' } as never)) as Ran)
    expect(generated).toContain('this generate would take about 50 credits')

    expect(asText((await $.command.run(command('budget off'))) as Ran)).toContain('budget off')
  })

  test('spent reaching the limit refuses everything until it is raised', async ($, on) => {
    const { world } = await start($, on, workspace())

    await $.command.run(command('budget 5'))
    world.plan = { code: 0, stdout: JSON.stringify({ credits: 110 }) }

    expect(asText((await $.command.run(command('run --only SC-004'))) as Ran)).toContain('budget reached')

    expect(asText((await $.command.run(command('budget 100'))) as Ran)).toContain('10.5 credits spent') // a raise keeps counting from the first balance
    expect(asText((await $.command.run(command('run --only SC-004'))) as Ran)).toContain('running SC-004')
  })

  for (const surface of SURFACES) {
    test(`on ${surface}: the Setup tab shows the budget`, async ($, on) => {
      await start($, on, workspace())
      await $.command.run(command('budget 25'))
      const ui = await setupTab($, surface)

      expect((await ui.find({ key: 'budget-line' }))?.text).toContain('budget 25 credits · 0 credits spent · 25 credits left · balance 120.5 credits')
      await ui.unmount()
    })
  }
})

describe('the no-agent checklist still draws', () => {
  test('outside an agent the pane is the checklist alone', async ($, on) => {
    await start($, on, { '.testmuai/rook/settings.json': JSON.stringify({ version: 1 }) })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

    expect(await ui.find({ text: 'rook · setup' })).toBeDefined()
    expect(await ui.find({ text: /no project selected/ })).toBeDefined()
    expect(await ui.find({ text: 'Profiles' })).toBeUndefined()
    await ui.unmount()
  })
})
