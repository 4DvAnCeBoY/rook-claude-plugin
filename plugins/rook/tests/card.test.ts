import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cardFacts, runIdOf } from '../hooks/card'
import { PANE, SESSION, worldOf } from './fixtures/world'
import { AGENT_DIR, inFlight, NEW_RUN, reportYaml, runYaml, VERDICT_PASS_GAP, withRca, workspace } from './fixtures/workspace'

const PLUGIN = 'rook'
const SURFACES = ['terminal', 'desktop'] as const
const FRESH_RUN = '2026-09-29T09-00-00Z'

type Ran = { result?: unknown; deny?: string }

/** Every string in a drawn tree, joined: what the row reads as. */
const textOf = (node: unknown): string =>
  typeof node === 'string' ? node : typeof node === 'object' && node !== null ? ((node as { children?: unknown[] }).children ?? []).map(textOf).join('') : ''

async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
  const world = worldOf(on, files)
  const clock = mock.clock(on, { now: 1_000_000 })

  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return { world, clock }
}

const resultRow = (tool: string, output: unknown, surface: 'terminal' | 'desktop' = 'terminal', isErrored = false) =>
  ({
    component: 'ToolResult',
    surface,
    requestId: 'toolu_1',
    viewport: PANE.viewport,
    props: { tool_use_id: 'toolu_1', tool, output, isErrored },
  }) as never

const useRow = (isRunning: boolean, tool = 'mcp__rook__run') =>
  ({
    component: 'ToolUse',
    surface: 'terminal',
    requestId: 'toolu_1',
    viewport: PANE.viewport,
    props: { tool_use_id: 'toolu_1', tool, input: {}, isRunning, isErrored: false, isInterrupted: false },
  }) as never

/** The report tool's text for the newest run, exactly as the model reads it. */
async function reportResult($: Engine): Promise<string> {
  const ran = (await $.tool.call({ tool: 'mcp__rook__report' } as never)) as Ran

  return ran.result as string
}

describe('card · helpers', () => {
  test('the run id comes from the first line of the result, in any shape the row carries it', () => {
    expect(runIdOf(`rook run ${NEW_RUN} against agent x finished: …`)).toBe(NEW_RUN)
    expect(runIdOf([{ type: 'text', text: `rook run ${NEW_RUN} (name) against agent x` }])).toBe(NEW_RUN)
    expect(runIdOf({ result: `rook run ${NEW_RUN} against` })).toBe(NEW_RUN)
    expect(runIdOf('rook run finished, but returned no run id to read.')).toBeUndefined()
    expect(runIdOf(`note\nrook run ${NEW_RUN}`)).toBeUndefined()
    expect(runIdOf(undefined)).toBeUndefined()
  })
})

describe('card · the verdict card in the transcript', () => {
  for (const surface of SURFACES) {
    test(`on ${surface}: a finished run's result draws as a card with counts, metrics, failures and buttons`, async ($, on) => {
      const { world } = await start($, on, workspace())
      const text = await reportResult($)

      expect(text.startsWith(`rook run ${NEW_RUN}`)).toBe(true)

      const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'ToolResult', requestId: 'toolu_1', props: { tool_use_id: 'toolu_1', tool: 'mcp__rook__run', output: text, isErrored: false }, viewport: PANE.viewport } as never)

      expect(await ui.find({ text: new RegExp(`rook run ${NEW_RUN}`) })).toBeDefined()
      expect(await ui.find({ text: '✓ 1 Pass' })).toBeDefined()
      expect(await ui.find({ text: '✗ 1 Fail' })).toBeDefined()
      expect(await ui.find({ text: '? 1 Unable to Verify' })).toBeDefined()
      expect(await ui.find({ text: /12\.5 credits/ })).toBeDefined()
      expect((await ui.find({ key: 'card-SC-004' }))?.text).toContain('Manager-approval override')
      expect(await ui.find({ key: 'card-open' })).toBeDefined()

      await ui.press({ key: 'card-fix' })
      expect(world.submitted.at(-1)).toContain('SC-004')
      expect(world.submitted.at(-1)).toContain('Fix these failures.')

      // Open in pane: from another tab back to Health, and the pane asked for
      const pane = await $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', props: PANE.props, requestId: 'rook', viewport: PANE.viewport })

      await pane.press({ key: 'tab-runs' })
      expect((await pane.find({ key: 'tab-health' }))?.type).toBe('Button')
      world.opened = []
      await ui.press({ key: 'card-open' })
      expect(world.opened).toEqual(['rook'])
      expect(await pane.find({ key: 'tab-health' })).toBeUndefined() // the open tab is drawn as text, not a button
      expect((await pane.find({ key: 'tab-runs' }))?.type).toBe('Button')
      await pane.unmount()
      await ui.unmount()
    })
  }

  test('clusters stand in for the scenarios they group, three at most', async ($, on) => {
    const { world } = await start($, on, withRca())
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolResult', requestId: 'toolu_1', props: { tool_use_id: 'toolu_1', tool: 'mcp__rook__report', output: await reportResult($), isErrored: false }, viewport: PANE.viewport } as never)

    expect(await ui.find({ key: 'card-CL-01' })).toBeDefined()
    expect(await ui.find({ key: 'card-SC-004' })).toBeUndefined()
    expect(world.submitted).toEqual([])
    await ui.unmount()
  })

  test("the model's result is untouched: Claude's own run comes back as text, the card draws from disk", async ($, on) => {
    const { world } = await start($, on, workspace())

    world.onRun = () => ({
      code: 0,
      stdout: JSON.stringify({ ok: true, run_id: FRESH_RUN, halted: false, credits: 4.25 }),
      writes: {
        [`${AGENT_DIR}/runs/${FRESH_RUN}/run.yaml`]: runYaml(FRESH_RUN, 'from claude', ['SC-002']),
        [`${AGENT_DIR}/runs/${FRESH_RUN}/scenarios/SC-002/verdict.yaml`]: VERDICT_PASS_GAP,
        [`${AGENT_DIR}/runs/${FRESH_RUN}/report.yaml`]: reportYaml(FRESH_RUN, 1, 0, 0, 4),
      },
    })
    const ran = (await $.tool.call({ tool: 'mcp__rook__run', only: ['SC-002'] } as never)) as Ran

    expect(typeof ran.result).toBe('string')
    expect(ran.result as string).toContain(`rook run ${FRESH_RUN} against agent commercecare: 1 Pass, 0 Fail`)

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'ToolResult', requestId: 'toolu_1', props: { tool_use_id: 'toolu_1', tool: 'mcp__rook__run', output: ran.result, isErrored: false }, viewport: PANE.viewport } as never)

    expect(await ui.find({ text: '✓ 1 Pass' })).toBeDefined()
    expect(await ui.find({ key: 'card-fix' })).toBeUndefined() // nothing failed: nothing to fix
    expect(await ui.find({ key: 'card-open' })).toBeDefined()
    await ui.unmount()
  })

  test('falls back to the engine row when the run cannot be read, the result is not a run, or the call errored', async ($, on) => {
    await start($, on, workspace())
    const text = await reportResult($)

    expect(await $.ui.render(resultRow('mcp__rook__run', 'rook run 2026-01-01T00-00-00Z against agent commercecare finished: 1 Pass'))).not.toMatchObject({ type: 'Box' })
    expect(await $.ui.render(resultRow('mcp__rook__run', 'rook: a run is already in progress.'))).not.toMatchObject({ type: 'Box' })
    expect(await $.ui.render(resultRow('mcp__rook__run', text, 'terminal', true))).not.toMatchObject({ type: 'Box' })
    expect(await $.ui.render(resultRow('mcp__rook__run', text))).toMatchObject({ type: 'Box' })
  })

  test('a run still in flight on disk is not drawn as a verdict', async ($, on) => {
    await start($, on, inFlight())

    expect(await $.ui.render(resultRow('mcp__rook__report', `rook run ${NEW_RUN} against agent commercecare finished: 1 Pass`))).not.toMatchObject({ type: 'Box' })
  })

  test("other tools' rows are untouched", async ($, on) => {
    await start($, on, workspace())
    const text = await reportResult($)

    expect(await $.ui.render(resultRow('Bash', text))).not.toMatchObject({ type: 'Box' })
    expect(await $.ui.render(resultRow('mcp__rook__status', text))).not.toMatchObject({ type: 'Box' })
    expect(await $.ui.render(resultRow('mcp__other__run', text))).not.toMatchObject({ type: 'Box' })
    expect(await $.ui.render(useRow(true, 'Bash'))).not.toMatchObject({ type: 'Box' })
  })
})

describe('card · the run row while Claude runs', () => {
  test('shows judged so far and the lanes in flight, then hands the row back', async ($, on) => {
    const { world } = await start($, on, inFlight())
    let during: unknown

    world.onRun = () => ({ code: 0, stdout: JSON.stringify({ ok: true, run_id: NEW_RUN }) })
    world.during = async () => {
      during = await $.ui.render(useRow(true))
    }

    expect(await $.ui.render(useRow(true))).not.toMatchObject({ type: 'Box' }) // not Claude's run
    await $.tool.call({ tool: 'mcp__rook__run' } as never)

    expect(during).toMatchObject({ type: 'Box' })
    expect(textOf(during)).toContain('rook run ▸ 2/3 judged · 1 failing')
    expect(textOf(during)).toContain('SC-007 starting')
    expect(await $.ui.render(useRow(false))).not.toMatchObject({ type: 'Box' })
  })

  test('cardFacts: counts, metrics and at most three items with the rest counted', () => {
    const run = {
      runId: NEW_RUN,
      planned: 5,
      done: 5,
      finished: true,
      counts: { pass: 1, fail: 4, unverifiable: 0 },
      rows: ['SC-001', 'SC-002', 'SC-003', 'SC-004'].map(id => ({ id, title: `t ${id}`, status: 'Fail' as const, gaps: [], unchecked: [], compromised: false, summary: '', failing: [] })),
      lanes: [],
      clusters: [],
      passRate: 0.2,
      credits: 3,
      durationMs: 64_000,
      next: [],
    }
    const card = cardFacts(run)

    expect(card.items.map(item => item.id)).toEqual(['SC-001', 'SC-002', 'SC-003'])
    expect(card.more).toBe(1)
    expect(card.metrics).toBe('pass rate 20% · 3 credits · 1m04s')
    expect(card.hasFailures).toBe(true)
  })
})
