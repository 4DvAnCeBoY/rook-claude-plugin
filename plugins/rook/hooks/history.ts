import type { PluginState } from 'claude-code'

import type { RookRunSummary, RookRunView, RookStatus } from '../types'
import { credits, duration } from './format'
import { compareRunIds, plannedIds } from './workspace'
import type { Io } from './workspace'
import { isMap, num, parseMap, str } from './yaml'

/**
 * The Runs tab's pure half: the agent's finished runs as a list, and what
 * changed between two of them, scenario by scenario. Reads files through an
 * `Io` only; never the engine.
 */

/** How many runs back the Runs tab lists. */
export const HISTORY_LIMIT = 50

/** The agent's finished runs, newest first, from run.yaml and report.yaml (never the verdicts). */
export async function historyOf(io: Io, agentDir: string, ids: readonly string[], limit = HISTORY_LIMIT): Promise<RookRunSummary[]> {
  const out: RookRunSummary[] = []

  for (const runId of ids) {
    if (out.length >= limit) {
      break
    }

    const runDir = `${agentDir}/runs/${runId}`
    const runText = await io.read(`${runDir}/run.yaml`)
    const reportText = runText === undefined ? undefined : await io.read(`${runDir}/report.yaml`)

    if (runText === undefined || reportText === undefined) {
      continue // not a run, or not finished
    }

    const run = parseMap(runText)
    const report = parseMap(reportText)
    const totals = isMap(report.totals) ? report.totals : {}
    const metrics = isMap(report.metrics) ? report.metrics : {}
    const name = str(run.name)
    const created = str(run.created)
    const passRate = num(totals.pass_rate)
    const spent = num(metrics.credits)
    const durationMs = num(metrics.duration_ms)

    out.push({
      runId,
      ...(name !== undefined && name !== '' && { name }),
      ...(created !== undefined && { created }),
      planned: num(totals.planned) ?? plannedIds(run).length,
      counts: { pass: num(totals.passed) ?? 0, fail: num(totals.failed) ?? 0, unverifiable: num(totals.unverifiable) ?? 0 },
      ...(passRate !== undefined && { passRate }),
      ...(spent !== undefined && { credits: spent }),
      ...(durationMs !== undefined && { durationMs }),
      ...(run.test_mode === true && { isTest: true }),
    })
  }

  return out
}

/** What a list signature of the agent's runs looks like: cheap to compare every poll. */
export const historySignature = (agentDir: string, ids: readonly string[], isLatestFinished: boolean): string =>
  `${agentDir}#${ids.join(',')}#${isLatestFinished ? 'done' : 'open'}`

/** Two runs diffed scenario by scenario; declared in types/index.d.ts (PluginState rook.runDiff). */
export type RunDiff = NonNullable<PluginState['rook']['runDiff']>

/** One scenario between two runs. */
export type RunDiffRow = RunDiff['fixed'][number]

type DiffSide = Pick<RookRunView, 'runId' | 'name' | 'counts' | 'passRate' | 'credits' | 'durationMs' | 'finished'> & {
  rows: readonly { id: string; title: string; status: RookStatus }[]
}

const sideOf = (run: DiffSide): RunDiff['base'] => ({
  runId: run.runId,
  ...(run.name !== undefined && run.name !== '' && { name: run.name }),
  counts: run.counts,
  ...(run.passRate !== undefined && { passRate: run.passRate }),
  ...(run.credits !== undefined && { credits: run.credits }),
  ...(run.durationMs !== undefined && { durationMs: run.durationMs }),
  finished: run.finished,
})

/** Scenario by scenario, what changed from `base` to `head`. */
export function diffRuns(base: DiffSide, head: DiffSide): RunDiff {
  const before = new Map(base.rows.map(row => [row.id, row]))
  const after = new Map(head.rows.map(row => [row.id, row]))
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b))
  const diff: RunDiff = {
    base: sideOf(base),
    head: sideOf(head),
    fixed: [],
    regressed: [],
    added: [],
    missing: [],
    stillFailing: [],
    stillUnverified: [],
    stillPassing: 0,
    delta: {
      pass: head.counts.pass - base.counts.pass,
      fail: head.counts.fail - base.counts.fail,
      unverifiable: head.counts.unverifiable - base.counts.unverifiable,
      ...(base.passRate !== undefined && head.passRate !== undefined && { passRate: head.passRate - base.passRate }),
      ...(base.credits !== undefined && head.credits !== undefined && { credits: head.credits - base.credits }),
    },
  }

  for (const id of ids) {
    const was = before.get(id)
    const now = after.get(id)
    const row: RunDiffRow = { id, title: now?.title || was?.title || '', ...(was && { base: was.status }), ...(now && { head: now.status }) }

    if (was === undefined) {
      diff.added.push(row)
    } else if (now === undefined) {
      diff.missing.push(row)
    } else if (was.status === 'Pass' && now.status === 'Pass') {
      diff.stillPassing += 1
    } else if (now.status === 'Pass') {
      diff.fixed.push(row)
    } else if (was.status === 'Pass') {
      diff.regressed.push(row)
    } else if (now.status === 'Fail') {
      diff.stillFailing.push(row)
    } else {
      diff.stillUnverified!.push(row)
    }
  }

  return diff
}

/** Which two runs a compare means: `[base, head]`, or why it cannot. Defaults to the two newest. */
export function comparePair(ids: readonly string[], baseRef?: string, headRef?: string): { base: string; head: string } | { error: string } {
  for (const ref of [baseRef, headRef]) {
    if (ref !== undefined && !ids.includes(ref)) {
      return { error: `no run ${ref} for this agent.` }
    }
  }

  if (baseRef !== undefined && headRef !== undefined) {
    return baseRef === headRef ? { error: 'pick two different runs.' } : { base: baseRef, head: headRef }
  }

  if (baseRef !== undefined) {
    const head = ids.find(id => id !== baseRef && compareRunIds(id, baseRef) > 0) ?? ids.find(id => id !== baseRef)

    return head === undefined ? { error: 'there is no other run to compare with.' } : { base: baseRef, head }
  }

  if (headRef !== undefined) {
    const base = ids.find(id => compareRunIds(id, headRef) < 0) ?? ids.find(id => id !== headRef)

    return base === undefined ? { error: 'there is no other run to compare with.' } : { base, head: headRef }
  }

  return ids.length < 2 ? { error: 'comparing needs two runs; this agent has fewer.' } : { base: ids[1]!, head: ids[0]! }
}

/** Two picked runs, oldest first: the base is the earlier run. */
export const ordered = (a: string, b: string): [string, string] => (compareRunIds(a, b) <= 0 ? [a, b] : [b, a])

const signed = (n: number, digits = 0): string => {
  const fixed = Number(n.toFixed(digits))

  return fixed > 0 ? `+${fixed}` : String(fixed)
}

export const pct = (rate: number | undefined): string => (rate === undefined ? '–' : `${Math.round(rate * 100)}%`)

/** `+1 Pass · −1 Fail · ±0 ?` style, with pass-rate and credits deltas. */
export function deltaLine(diff: RunDiff): string {
  const { delta } = diff

  return [
    `Pass ${signed(delta.pass)}`,
    `Fail ${signed(delta.fail)}`,
    `Unable to Verify ${signed(delta.unverifiable)}`,
    delta.passRate === undefined ? undefined : `pass rate ${pct(diff.base.passRate)} → ${pct(diff.head.passRate)} (${signed(delta.passRate * 100)} pts)`,
    delta.credits === undefined ? undefined : `credits ${signed(delta.credits, 2)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

const short = (status: RookStatus | undefined): string => (status === undefined ? '–' : status === 'Unable to Verify' ? '?' : status)

const rowLine = (row: RunDiffRow): string => `  ${row.id}${row.title ? ` — ${row.title}` : ''} (${short(row.base)} → ${short(row.head)})`

const sideLine = (label: string, side: RunDiff['base']): string =>
  `${label} ${side.runId}${side.name ? ` "${side.name}"` : ''}${side.finished ? '' : ' (unfinished)'}: ` +
  [
    `${side.counts.pass} Pass · ${side.counts.fail} Fail · ${side.counts.unverifiable} Unable to Verify`,
    side.passRate === undefined ? undefined : `pass rate ${pct(side.passRate)}`,
    credits(side.credits),
    side.durationMs === undefined ? undefined : duration(side.durationMs),
  ]
    .filter(Boolean)
    .join(' · ')

/** The diff as text: for `/rook compare` and the compare tool. */
export function compareText(agentId: string, diff: RunDiff): string {
  const section = (title: string, rows: readonly RunDiffRow[]) => (rows.length === 0 ? [] : [`${title} (${rows.length}):`, ...rows.map(rowLine)])

  return [
    `rook compare for agent ${agentId}:`,
    sideLine('base', diff.base),
    sideLine('head', diff.head),
    `Change: ${deltaLine(diff)}`,
    ...section('Fixed (Fail or Unable to Verify → Pass)', diff.fixed),
    ...section('Regressed (Pass → Fail or Unable to Verify)', diff.regressed),
    ...section('New in head', diff.added),
    ...section('Not re-run in head', diff.missing),
    ...section('Still failing', diff.stillFailing),
    ...section('Still Unable to Verify (not Fail)', diff.stillUnverified ?? []),
    `${diff.stillPassing} still passing.`,
    'Unable to Verify is not Fail. Read either run with the rook report tool and its run_id.',
  ].join('\n')
}
