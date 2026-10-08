import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { elapsed } from '../hooks/format'
import { failureOf } from '../hooks/rook'
import { flakyText } from '../hooks/scenarios'
import { changedSources, sourceStamps } from '../hooks/sources'
import type { Io } from '../hooks/workspace'
import { BAND, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, runYaml, workspace } from './fixtures/workspace'
import { command } from './fixtures/world'

/**
 * Fixes from a live test of 0.2.0 in a real Claude Code session against a
 * real rook project: edits made through the shell, the compare and flaky
 * wording, the sync hint, live timers.
 */

/** A tiny disk: path → [content, mtime]. */
const ioOver = (files: Record<string, number>): Io => ({
  read: async path => (path in files ? '' : undefined),
  list: async path => {
    const dir = path === '.' ? '' : path
    const names = new Map<string, { kind: string; mtimeMs?: number }>()

    for (const [file, mtimeMs] of Object.entries(files)) {
      if (dir === '' || file.startsWith(`${dir}/`)) {
        const rest = dir === '' ? file : file.slice(dir.length + 1)
        const [head] = rest.split('/')

        names.set(head!, rest.includes('/') ? { kind: 'dir' } : { kind: 'file', mtimeMs })
      }
    }

    return [...names].map(([name, entry]) => ({ name, ...entry }))
  },
})

describe('re-test band · edits Claude made through the shell', () => {
  test('tracked files and directories are stamped; dependency folders are skipped', async () => {
    const stamps = await sourceStamps(
      ioOver({ 'PRD.md': 1, 'src/agent.mjs': 2, 'src/lib/tools.mjs': 3, 'src/node_modules/x/index.js': 4, 'other.txt': 5 }),
      ['PRD.md', 'src', './missing.md'],
    )

    expect([...stamps.keys()].sort()).toEqual(['PRD.md', 'src/agent.mjs', 'src/lib/tools.mjs'])
  })

  test('a changed or new file is reported; untouched ones are not', () => {
    const before = new Map([
      ['a.mjs', 1],
      ['b.mjs', 1],
    ])
    const after = new Map([
      ['a.mjs', 1],
      ['b.mjs', 2],
      ['c.mjs', 1],
    ])

    expect(changedSources(before, after)).toEqual(['b.mjs', 'c.mjs'])
  })

  test('a file appearing under a tracked directory, with no Edit tool call, raises the band on the next poll', async ($: Engine, on) => {
    const world = worldOf(on, workspace())
    const clock = mock.clock(on, { now: 1_000_000 })

    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.session.start(SESSION)
    await clock.advance(3_100) // a poll takes the baseline

    // As a shell command, an editor or another terminal would: no tool call the mod sees.
    world.files.set('mcp/refunds.mjs', 'export const refund = () => {}\n')
    await clock.advance(3_100)

    const ui = await $.ui.mount({ plugin: 'rook', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND.props, bodyColumns: 170 }, viewport: BAND.viewport })

    expect(await ui.find({ text: /mcp\/refunds\.mjs/ })).toBeDefined()
    expect(await ui.find({ key: 'retest' })).toBeDefined()
  })
})

describe('flaky check · the verdict from before counts', () => {
  test('Pass before, then two Fails, is flaky', () => {
    expect(flakyText('SC-002', ['Fail', 'Fail'], 2, 'Pass')).toBe('SC-002 is FLAKY: earlier Pass, then Fail, Fail. Its verdict changed between runs.')
  })

  test('the same verdict before and after is stable', () => {
    expect(flakyText('SC-002', ['Pass', 'Pass'], 2, 'Pass')).toBe('SC-002 is stable: earlier Pass, then 2 runs, all Pass.')
    expect(flakyText('SC-002', ['Pass', 'Pass'], 2)).toBe('SC-002 is stable: 2 runs, all Pass.')
  })
})

describe('run refused for being ahead of upstream', () => {
  test('the failure says how to sync', () => {
    const text = failureOf({ exitCode: 1, doc: { discarded: 'refused', reason: 'profile ahead of upstream' }, stderr: '' })

    expect(text).toContain('nothing ran')
    expect(text).toContain('/rook sync')
  })

  test('other refusals are left as they were', () => {
    expect(failureOf({ exitCode: 1, doc: { discarded: 'refused', reason: 'no runnable scenarios' }, stderr: '' })).not.toContain('/rook sync')
  })
})

describe('live timers', () => {
  test('whole seconds under a minute, then minutes', () => {
    expect(elapsed(35_900)).toBe('35s')
    expect(elapsed(125_000)).toBe('2m05s')
  })
})

describe('budget · priced while the newest run has no credits', () => {
  test('an unfinished or cancelled newest run does not let a run past the budget', async ($: Engine, on) => {
    const files = { ...workspace(), [`${AGENT_DIR}/runs/2026-09-28T16-00-00Z/run.yaml`]: runYaml('2026-09-28T16-00-00Z', 'cut off', ['SC-004']) }
    const world = worldOf(on, files)
    const clock = mock.clock(on, { now: 1_000_000 })

    on('tool.call', () => ({ result: 'ok' }) as never)
    await $.session.start(SESSION)
    await clock.advance(3_100)

    expect((await $.command.run(command('budget 5'))).text).toContain('budget 5 credits')
    const refused = (await $.command.run(command('run'))).text

    expect(refused).toContain('was not started')
    expect(world.invocations.filter(argv => argv[1] === 'run')).toEqual([])
  })
})
