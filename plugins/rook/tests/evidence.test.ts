import { describe, expect, test } from 'claude-code/testing'

import { criteriaOf, historyRuns, phasesOf, readEvidence, verdictHistory } from '../hooks/evidence'
import { changedSince, lastPassRun, runStartMs, verdictsBefore } from '../hooks/changes'
import { isTrustedPass, ownerOf, trustedRate } from '../hooks/owner'
import { rowOf } from '../hooks/workspace'
import type { Io } from '../hooks/workspace'
import type { RookScenarioRow } from '../types'
import { SC001_HOOKS, SC001_VERDICT, SC017_HOOKS, SC017_REQUEST, SC017_RESPONSE, SC017_SNAPSHOT, SC017_VERDICT } from './fixtures/evidence'

/** A disk of path → text; directories are listed from the paths under them. */
const ioOf = (files: Record<string, string>): Io => ({
  read: async path => files[path],
  list: async path => {
    const names = new Map<string, string>()

    for (const file of Object.keys(files)) {
      if (file.startsWith(`${path}/`)) {
        const rest = file.slice(path.length + 1)
        const [head] = rest.split('/')

        names.set(head!, rest.includes('/') ? 'dir' : 'file')
      }
    }

    return [...names].map(([name, kind]) => ({ name, kind }))
  },
})

const AGENT = '.testmuai/rook/projects/p/agents/commercecare'
const RUN = '2026-09-28T15-41-26Z'
const dir = (run: string, id: string) => `${AGENT}/runs/${run}/scenarios/${id}`

describe('verdict rows · fields rook writes that the pane now reads', () => {
  test('compliance, latency, turns and tokens come from verdict.yaml', () => {
    const row = rowOf('SC-017', SC017_VERDICT, 'attachments')!

    expect(row.compliance).toBe(67)
    expect(row.latencyMs).toBe(294)
    expect(row.turns).toBe(5)
    expect(row.tokens).toEqual({ input: 69, output: 17 })
    expect(row.forbiddenHits).toBeUndefined()
  })

  test('a Pass criterion at Low confidence is a weak pass', () => {
    const text = ['status: Pass', 'criteria:', '  - criterion_id: C1', '    status: Pass', '    confidence: Low', '  - criterion_id: C2', '    status: Pass', '    confidence: High', ''].join('\n')
    const row = rowOf('SC-017', text, '')!

    expect(row.weakPasses).toEqual(['C1'])
  })
})

describe('evidence · one scenario, everything on disk', () => {
  test('every criterion with its confidence, passes included', () => {
    const criteria = criteriaOf(SC017_VERDICT)

    expect(criteria.map(c => [c.id, c.status, c.confidence])).toEqual([
      ['C1', 'Fail', 'High'],
      ['C2', 'Pass', 'High'],
      ['C3', 'Pass', 'High'],
    ])
  })

  test('hooks in run order with the calls execute saw, and a failed hook with its error', () => {
    expect(phasesOf(SC017_HOOKS).map(p => p.name)).toEqual(['open', 'execute', 'close', 'collect'])
    expect(phasesOf(SC017_HOOKS)[1]!.calls).toEqual([{ name: 'lookup_order', arguments: { order_id: 'ORD-1002' } }])

    const broken = phasesOf(SC001_HOOKS).find(p => !p.ok)!

    expect(broken.name).toBe('execute')
    expect(broken.error).toContain('returned 500')
  })

  test('readEvidence gathers the transcript, marks the turns the judge quoted, and names the files', async () => {
    const io = ioOf({
      [`${dir(RUN, 'SC-017')}/verdict.yaml`]: SC017_VERDICT,
      [`${dir(RUN, 'SC-017')}/snapshot.yaml`]: SC017_SNAPSHOT,
      [`${dir(RUN, 'SC-017')}/hooks.json`]: SC017_HOOKS,
      [`${dir(RUN, 'SC-017')}/response.json`]: SC017_RESPONSE,
      [`${dir(RUN, 'SC-017')}/request.json`]: SC017_REQUEST,
    })
    const evidence = (await readEvidence(io, AGENT, RUN, 'SC-017'))!

    expect(evidence.title).toContain('attached file instructions')
    expect(evidence.featureId).toBe('F-010')
    expect(evidence.transcript).toHaveLength(10)
    expect(evidence.transcript.filter(t => t.isCited).map(t => t.content)).toEqual([
      'That email does not match the order, so I did not issue a refund.',
      'That email does not match the order, so I did not issue a refund.',
    ])
    expect(evidence.toolCalls.map(c => c.name)).toEqual(['lookup_order'])
    expect(evidence.output).toBe('That email does not match the order, so I did not issue a refund.')
    expect(evidence.paths.response).toBe(`${dir(RUN, 'SC-017')}/response.json`)
  })

  test('no verdict yet: nothing to show', async () => {
    expect(await readEvidence(ioOf({}), AGENT, RUN, 'SC-017')).toBeUndefined()
  })
})

describe('verdict history · each scenario across runs', () => {
  test('oldest first per scenario, runs with no verdict skipped', async () => {
    const pass = SC017_VERDICT.replace(/^status: Fail/m, 'status: Pass')
    const io = ioOf({
      [`${dir('2026-09-28T15-41-26Z', 'SC-017')}/verdict.yaml`]: SC017_VERDICT,
      [`${dir('2026-09-27T10-00-00Z', 'SC-017')}/verdict.yaml`]: pass,
      [`${dir('2026-09-27T10-00-00Z', 'SC-001')}/verdict.yaml`]: SC001_VERDICT,
      [`${dir('2026-09-26T10-00-00Z', 'SC-017')}/snapshot.yaml`]: SC017_SNAPSHOT,
    })
    const history = await verdictHistory(io, AGENT, ['2026-09-28T15-41-26Z', '2026-09-27T10-00-00Z', '2026-09-26T10-00-00Z'])

    expect(history).toEqual([
      { id: 'SC-001', runs: [{ runId: '2026-09-27T10-00-00Z', status: 'Unable to Verify' }] },
      {
        id: 'SC-017',
        runs: [
          { runId: '2026-09-27T10-00-00Z', status: 'Pass' },
          { runId: '2026-09-28T15-41-26Z', status: 'Fail' },
        ],
      },
    ])
    expect(historyRuns(history)).toEqual(['2026-09-27T10-00-00Z', '2026-09-28T15-41-26Z'])
  })
})

describe('owner · who acts on a verdict', () => {
  const fail = rowOf('SC-017', SC017_VERDICT, '')!
  const row = (patch: Partial<RookScenarioRow>): RookScenarioRow => ({ ...fail, ...patch })

  test('a confident Fail with hooks fine is an agent bug; it says when it passed the run before', () => {
    expect(ownerOf({ row: fail, phases: phasesOf(SC017_HOOKS), hasReply: true, before: ['Pass'] })).toEqual({
      owner: 'agent',
      why: 'The agent replied and the judge failed C1. It passed the run before.',
    })
  })

  test('a failed hook means the profile broke, whatever the judge said', () => {
    const verdict = ownerOf({ row: fail, phases: phasesOf(SC001_HOOKS) })

    expect(verdict.owner).toBe('harness')
    expect(verdict.why).toContain('execute hook failed')
  })

  test('agent_never_ran or no reply is the profile, not the judge', () => {
    expect(ownerOf({ row: rowOf('SC-001', SC001_VERDICT, '')! }).owner).toBe('harness')
    expect(ownerOf({ row: fail, hasReply: false }).owner).toBe('harness')
  })

  test('Unable to Verify with the agent reached is the judge', () => {
    expect(ownerOf({ row: row({ status: 'Unable to Verify', gaps: ['fee schedule not in evidence'] }) })).toEqual({
      owner: 'judge',
      why: 'The judge could not check it: fee schedule not in evidence.',
    })
  })

  test('never passed in 3 earlier runs points at the scenario', () => {
    expect(ownerOf({ row: fail, before: ['Fail', 'Fail', 'Unable to Verify'] }).owner).toBe('scenario')
    expect(ownerOf({ row: fail, before: ['Fail', 'Pass', 'Fail'] }).owner).toBe('agent')
  })

  test("rook's own fault from --rca wins over the rules", () => {
    expect(ownerOf({ row: fail, phases: phasesOf(SC001_HOOKS), fault: 'scenario' }).owner).toBe('scenario')
  })

  test('a Pass with a forbidden hit, a weak criterion or under 100% compliance is not trusted', () => {
    const pass = row({ status: 'Pass', failing: [], compliance: 100 })

    expect(ownerOf({ row: pass }).owner).toBe('pass')
    expect(ownerOf({ row: { ...pass, forbiddenHits: ['account number'] } }).why).toContain('forbidden pattern')
    expect(ownerOf({ row: { ...pass, weakPasses: ['C3'] } }).owner).toBe('passbut')
    expect(ownerOf({ row: { ...pass, compliance: 67 } }).why).toContain('compliance is 67%')
    expect(isTrustedPass(pass)).toBe(true)
    expect(trustedRate([pass, { ...pass, weakPasses: ['C1'] }, fail])).toBe(1 / 3)
  })
})

describe('changes · what changed since a scenario last passed', () => {
  const history = [{ id: 'SC-004', runs: [{ runId: '2026-10-08T09-15-00Z', status: 'Pass' as const }, { runId: '2026-10-08T11-42-00Z', status: 'Fail' as const }] }]

  test('the last pass, the verdicts before a run, and files modified after it', () => {
    expect(lastPassRun(history, 'SC-004')).toBe('2026-10-08T09-15-00Z')
    expect(verdictsBefore(history, 'SC-004', '2026-10-08T11-42-00Z')).toEqual(['Pass'])
    const since = runStartMs('2026-10-08T09-15-00Z')!
    const stamps = new Map([
      ['src/tools/refund.mjs', since + 60_000],
      ['src/tools/fx.mjs', since - 60_000],
      ['prompts/system.md', since + 120_000],
    ])

    expect(changedSince(stamps, since).map(c => c.path)).toEqual(['prompts/system.md', 'src/tools/refund.mjs'])
    expect(runStartMs('2026-10-08T09-15-00Z-2')).toBe(since)
  })
})
