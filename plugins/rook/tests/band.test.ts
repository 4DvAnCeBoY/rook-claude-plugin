import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { retestPrompt, staleLine } from '../hooks/format'
import { importsFile, importsIn, indexAgent, mergeReach, namesIn, reach } from '../hooks/impact'
import type { Io } from '../hooks/workspace'
import type { RookStale } from '../types'
import { bankWorkspace, DOMAIN, ENGINE, PLAIN_ENGINE, TOOLS } from './fixtures/band'
import { BAND, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR } from './fixtures/workspace'

const PLUGIN = 'rook'
const SURFACES = ['terminal', 'desktop'] as const

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

async function reachIn(files: Record<string, string>, rel: string) {
  const index = await indexAgent(ioOver(files), AGENT_DIR)

  return { index, reach: await reach(index, rel, async path => files[path]) }
}

const ids = (r: { scenarios: { id: string }[] } | undefined) => r?.scenarios.map(s => s.id)

describe('band · what a shared file reaches', () => {
  test('names a file defines: exports, tool names in string literals; not words or module paths', () => {
    // every identifier-like literal; `reach` keeps the known tools and the code-like ones
    expect(namesIn(TOOLS)).toEqual(['TOOLS', 'get_account', 'transfer', 'From', 'USD', 'get_policy', 'search_transactions', 'Reference'])
    expect(namesIn(ENGINE)).toEqual(['createSession', 'executeTurn', 'evidence', 'vulnerable', 'fixture', 'none', 'slow_tool', 'poisoned_context'])
    expect(namesIn('def lookup_order(id):\n  pass\nclass Agent:\n  pass\n')).toEqual(['lookup_order', 'Agent'])
    expect(namesIn('export { run as alpha, beta }\nexports.gamma = 1')).toEqual(['run', 'alpha', 'beta', 'gamma'])
  })

  test('a tools file narrows to the scenarios that call or name its tools, and says so', async () => {
    const { reach: r } = await reachIn(bankWorkspace(), 'source/shared/tools.mjs')

    // SC-005 says "Transfer USD 200" in prose: a word, not the tool
    expect(ids(r)).toEqual(['SC-001', 'SC-002', 'SC-003', 'SC-004', 'SC-006'])
    expect(r?.isWholeAgent).toBe(false)
    expect(r?.reason).toBe('shared code: matched 5 scenarios by tool names get_account, transfer, get_policy +1')
    expect(r?.scenarios.find(s => s.id === 'SC-002')?.why).toBe('calls transfer')
    expect(r?.scenarios.find(s => s.id === 'SC-004')?.why).toBe('names search_transactions')
    expect(r?.scenarios.find(s => s.id === 'SC-001')?.why).toBe('calls get_account') // through its feature's calls
  })

  test('an engine-like shared file narrows by the names its scenarios carry', async () => {
    const { reach: r } = await reachIn(bankWorkspace(), 'source/shared/engine.mjs')

    expect(ids(r)).toEqual(['SC-003', 'SC-005'])
    expect(r?.reason).toBe('shared code: matched 2 scenarios by names poisoned_context, slow_tool')
    expect(r?.scenarios.map(s => s.why)).toEqual(['names poisoned_context', 'names slow_tool'])
  })

  test('nothing narrows it: the whole agent, labelled why', async () => {
    const plain = await reachIn(bankWorkspace({ 'source/shared/engine.mjs': PLAIN_ENGINE }), 'source/shared/engine.mjs')

    expect(plain.reach?.isWholeAgent).toBe(true)
    expect(ids(plain.reach)).toHaveLength(6)
    expect(plain.reach?.reason).toBe('shared code, no scenario names what it defines: all 6 scenarios may be affected')

    const gone = await reachIn(bankWorkspace(), 'source/shared/deleted.mjs')

    expect(gone.reach?.isWholeAgent).toBe(true)
    expect(gone.reach?.reason).toBe('no feature cites it: all 6 scenarios may be affected')
  })

  test('imports are followed one level: a cited file that imports the edited one counts', async () => {
    const { reach: r } = await reachIn(bankWorkspace(), 'source/shared/domain.mjs')

    expect(ids(r)).toEqual(['SC-001', 'SC-006'])
    expect(r?.reason).toBe('shared code: matched 2 scenarios through source/demos/bank/agent.mjs, which imports it')
    expect(r?.scenarios[0]?.why).toBe('F-003 cites source/demos/bank/agent.mjs, which imports it')
    expect(DOMAIN).toContain('objectSchema') // its own names reach no scenario: the import alone narrowed it

    // rook's explore cites `path: symbol`
    const symbol = bankWorkspace({
      [`${AGENT_DIR}/features/F-003.yaml`]: "local_id: F-003\nname: Read an owned account\nsources:\n  - 'source/demos/bank/agent.mjs: invoke(''get_account'')'\n",
    })

    expect(ids((await reachIn(symbol, 'source/shared/domain.mjs')).reach)).toEqual(['SC-001', 'SC-006'])
  })

  test('import specifiers resolve against the importing file', () => {
    expect(importsIn("import a from './x.js'\nconst b = require('../y')\nawait import('./z.mjs')\nimport 'lodash'")).toEqual(['./x.js', 'lodash', '../y', './z.mjs'])
    expect(importsFile('src/a/agent.mjs', '../shared/engine.mjs', 'src/shared/engine.mjs')).toBe(true)
    expect(importsFile('src/a/agent.ts', '../shared/engine', 'src/shared/engine.ts')).toBe(true)
    expect(importsFile('src/a/agent.ts', '../shared', 'src/shared/index.ts')).toBe(true)
    expect(importsFile('src/a/agent.ts', 'engine', 'src/a/engine.ts')).toBe(false) // a package
    expect(importsFile('src/agent.ts', '../../up', 'up.ts')).toBe(false)
    expect(importsIn('from .tools import transfer\nimport app.engine\n')).toEqual(['py:.tools', 'py:app.engine'])
    expect(importsFile('app/agent.py', 'py:.tools', 'app/tools.py')).toBe(true)
    expect(importsFile('app/agent.py', 'py:app.engine', 'app/engine.py')).toBe(true)
  })

  test('a cited file keeps the feature answer; untracked files reach nothing', async () => {
    const { reach: r } = await reachIn(bankWorkspace(), 'source/demos/bank/agent.mjs')

    expect(ids(r)).toEqual(['SC-001', 'SC-006'])
    expect(r?.reason).toBeUndefined()
    expect(r?.scenarios[0]?.why).toBe('F-003 cites it')
    expect((await reachIn(bankWorkspace(), 'README.md')).reach).toBeUndefined()
  })

  test('several files merge into one band; the whole agent wins when one file reaches it', async () => {
    const files = bankWorkspace()
    const index = await indexAgent(ioOver(files), AGENT_DIR)
    const read = async (path: string) => files[path]
    const engine = (await reach(index, 'source/shared/engine.mjs', read))!
    const domain = (await reach(index, 'source/shared/domain.mjs', read))!
    const merged = mergeReach(index, [engine, domain])

    expect(merged.files).toEqual(['source/shared/engine.mjs', 'source/shared/domain.mjs'])
    expect(ids(merged)).toEqual(['SC-001', 'SC-003', 'SC-005', 'SC-006'])
    expect(merged.isWholeAgent).toBe(false)
    expect(merged.scenarios[1]?.why).toBe('source/shared/engine.mjs: names poisoned_context')

    const gone = (await reach(index, 'source/shared/gone.mjs', read))!
    const whole = mergeReach(index, [engine, gone])

    expect(whole.isWholeAgent).toBe(true)
    expect(ids(whole)).toHaveLength(6)
    expect(whole.reason).toBe('source/shared/gone.mjs: no feature cites it: all 6 scenarios may be affected')
  })
})

describe('band · line and prompt', () => {
  const stale: RookStale = {
    files: ['source/shared/tools.mjs'],
    scenarios: [
      { id: 'SC-002', title: 'Transfer over the approval limit', why: 'calls transfer' },
      { id: 'SC-003', title: 'Poisoned policy note', why: 'calls get_policy' },
      { id: 'SC-004', title: 'SQL in a transaction search', why: 'names search_transactions' },
    ],
    isWholeAgent: false,
    reason: 'shared code: matched 3 scenarios by tool names transfer, get_policy, search_transactions',
    estimate: 12.5,
    since: 0,
  }

  test('the line carries the reason, and the cost of the ticked scenarios only', () => {
    expect(staleLine(stale)).toBe(
      'Agent changed since last run: source/shared/tools.mjs · shared code: matched 3 scenarios by tool names transfer, get_policy, search_transactions · ~12.5 credits',
    )
    expect(staleLine(stale, ['SC-003'])).toContain('· 2 of 3 ticked · ~8.33 credits')
  })

  test('Re-test asks for the ticked ids only, with why they were chosen', () => {
    const prompt = retestPrompt(stale, ['SC-003'])

    expect(prompt).toContain('re-test scenarios SC-002, SC-004 (pass them as `only`)')
    expect(prompt).toContain('about 8.33 credits')
    expect(prompt).toContain('chosen as shared code: matched 3 scenarios by tool names')
    expect(prompt).toContain('SC-002 (calls transfer), SC-004 (names search_transactions)')
    expect(prompt).toContain('The person left out SC-003; do not run those.')
  })

  test('the whole agent: every scenario unless some are unticked, then only the ticked', () => {
    const whole: RookStale = { ...stale, isWholeAgent: true, reason: 'no feature cites it: all 3 scenarios may be affected' }

    expect(retestPrompt(whole)).toContain('re-test every scenario,')
    expect(retestPrompt(whole)).toContain('every scenario may be affected (no feature cites it: all 3 scenarios may be affected)')
    expect(retestPrompt(whole, ['SC-002'])).toContain('re-test scenarios SC-003, SC-004 (pass them as `only`)')
  })
})

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
  const world = worldOf(on, files)

  mock.clock(on, { now: 1_000_000 })
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return world
}

const WIDE = { ...BAND.props, bodyColumns: 170 }

describe('band · toggles, Details, Re-test', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: a shared file's band ticks its scenarios, totals the ticked, and re-tests only those`, async ($, on) => {
      const world = await start($, on, bankWorkspace())

      await $.tool.call({ tool: 'Edit', file_path: '/work/source/shared/engine.mjs', old_string: 'a', new_string: 'b' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: WIDE, viewport: BAND.viewport })

      expect(await ui.find({ text: /source\/shared\/engine\.mjs · shared code: matched 2 scenarios by names poisoned_context, slow_tool · ~8\.33 credits/ })).toBeDefined()
      expect((await ui.find({ key: 'tick-SC-003' }))?.text).toContain('☑ SC-003')
      expect((await ui.find({ key: 'retest' }))?.text).toContain('Re-test 2')

      await ui.press({ key: 'tick-SC-005' })
      expect(await ui.find({ text: /1 of 2 ticked · ~4\.17 credits/ })).toBeDefined()
      expect((await ui.find({ key: 'tick-SC-005' }))?.text).toContain('☐ SC-005')
      expect((await ui.find({ key: 'retest' }))?.text).toContain('Re-test 1')

      // Details: each scenario with its title, why it matched and its cost
      expect(await ui.find({ text: /Poisoned policy note/ })).toBeUndefined()
      await ui.press({ key: 'details' })
      expect(await ui.find({ text: /Poisoned policy note · names poisoned_context · ~4\.17 credits/ })).toBeDefined()
      expect(await ui.find({ text: /A slow tool during a small transfer · names slow_tool/ })).toBeDefined()
      await ui.press({ key: 'details' })
      expect(await ui.find({ text: /Poisoned policy note/ })).toBeUndefined()

      await ui.press({ key: 'retest' })
      expect(world.submitted).toHaveLength(1)
      expect(world.submitted[0]).toContain('re-test scenarios SC-003 (pass them as `only`)')
      expect(world.submitted[0]).toContain('The person left out SC-005')
      expect(await $.ui.render({ ...BAND, props: WIDE })).not.toMatchObject({ type: 'Box' })
      await ui.unmount()
    })

    test(`on ${surface}: narrow, the band stays one line and the toggles move into Details`, async ($, on) => {
      await start($, on, bankWorkspace())
      await $.tool.call({ tool: 'Edit', file_path: '/work/source/shared/tools.mjs', old_string: 'a', new_string: 'b' } as never)
      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...BAND.props, bodyColumns: 60 }, viewport: BAND.viewport })

      expect(await ui.find({ text: '5/5 scenarios · ~20.83 credits' })).toBeDefined()
      expect(await ui.find({ key: 'tick-SC-001' })).toBeUndefined()

      await ui.press({ key: 'details' })
      await ui.press({ key: 'tick-SC-001' })
      expect(await ui.find({ text: '4/5 scenarios · ~16.67 credits' })).toBeDefined()
      expect(await ui.find({ text: /shared code: matched 5 scenarios by tool names/ })).toBeDefined()
      await ui.unmount()
    })
  }

  test('with every scenario unticked, Re-test asks for nothing and says why', async ($, on) => {
    const world = await start($, on, bankWorkspace())

    await $.tool.call({ tool: 'Edit', file_path: '/work/source/shared/domain.mjs', old_string: 'a', new_string: 'b' } as never)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: WIDE, viewport: BAND.viewport })

    await ui.press({ key: 'tick-SC-001' })
    await ui.press({ key: 'tick-SC-006' })
    await ui.press({ key: 'retest' })

    expect(world.submitted).toEqual([])
    expect(world.toasts.at(-1)).toContain('tick at least one scenario')
    expect(await ui.find({ key: 'retest' })).toBeDefined()
    await ui.unmount()
  })

  test('a cited file keeps the familiar line; Re-test sends every affected id', async ($, on) => {
    const world = await start($, on, bankWorkspace())

    await $.tool.call({ tool: 'Edit', file_path: '/work/source/demos/bank/agent.mjs', old_string: 'a', new_string: 'b' } as never)
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: BAND.props, viewport: BAND.viewport })

    expect(await ui.find({ text: /source\/demos\/bank\/agent\.mjs · 2 scenarios touch it · ~8\.33 credits/ })).toBeDefined()
    await ui.press({ key: 'retest' })
    expect(world.submitted[0]).toContain('re-test scenarios SC-001, SC-006 (pass them as `only`)')
    expect(world.submitted[0]).not.toContain('left out')
  })
})
