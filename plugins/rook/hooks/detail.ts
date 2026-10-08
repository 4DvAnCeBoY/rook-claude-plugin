import type { RookCluster, RookEvidence, RookLens, RookOwner, RookPhase, RookScenarioRow, RookStatus, RookVerdictHistory } from '../types'
import { changedSince, lastPassRun, runStartMs, verdictsBefore } from './changes'
import { duration } from './format'
import { isFlaky, ownerOf } from './owner'
import type { OwnerVerdict } from './owner'

/**
 * The scenario drill-down's pure side: which sections it shows in which
 * order for whom, which actions the owner and the lens call for, the verdict
 * history strip and the hooks waterfall. No `$`.
 */

export type DetailSection = 'why' | 'changed' | 'criteria' | 'history' | 'conversation' | 'phases' | 'cost'

/**
 * A QE asks "is this a real bug, and how sure is the judge?", so criteria and
 * history lead; a developer asks "what did my change do?", so the files they
 * touched and what the agent said lead.
 */
const ORDER: Record<RookLens, readonly DetailSection[]> = {
  qe: ['why', 'criteria', 'history', 'conversation', 'phases', 'cost'],
  dev: ['why', 'changed', 'conversation', 'phases', 'criteria', 'cost'],
}

/** The sections in the lens's order; "changed since it last passed" only while it is not passing. */
export function sectionsFor(lens: RookLens, status: RookStatus | undefined): DetailSection[] {
  return ORDER[lens].filter(s => s !== 'changed' || (status !== undefined && status !== 'Pass'))
}

export type DetailActionId = 'bug' | 'fixAgent' | 'fixScenario' | 'sharpen' | 'tighten' | 'fixProfile' | 'testProfile' | 'rerun3' | 'retest' | 'regression'

export type DetailAction = { id: DetailActionId; label: string; hotkey: string; isPrimary?: boolean; spendsCredits?: boolean }

const A: Record<DetailActionId, Omit<DetailAction, 'isPrimary'>> = {
  bug: { id: 'bug', label: 'Draft bug report', hotkey: 'd' },
  fixAgent: { id: 'fixAgent', label: 'Fix with Claude', hotkey: 'x' },
  fixScenario: { id: 'fixScenario', label: 'Fix the scenario with Claude', hotkey: 'e' },
  sharpen: { id: 'sharpen', label: 'Sharpen the criterion', hotkey: 'e' },
  tighten: { id: 'tighten', label: 'Tighten the scenario', hotkey: 'e' },
  fixProfile: { id: 'fixProfile', label: 'Fix the profile with Claude', hotkey: 'p' },
  testProfile: { id: 'testProfile', label: 'Test the profile', hotkey: 't', spendsCredits: true },
  rerun3: { id: 'rerun3', label: 'Re-run 3×', hotkey: 'k', spendsCredits: true },
  retest: { id: 'retest', label: 'Re-test this', hotkey: 'a', spendsCredits: true },
  regression: { id: 'regression', label: 'Turn into regression test', hotkey: 'g' },
}

/** A developer's shorter labels where the QE's would say "with Claude" twice over. */
const DEV_LABEL: Partial<Record<DetailActionId, string>> = {
  fixScenario: 'Fix the scenario',
  fixProfile: 'Fix the profile',
}

const PLAN: Record<RookLens, Record<RookOwner, readonly DetailActionId[]>> = {
  // A QE files agent bugs and fixes what is theirs: the scenario, the profile, the criterion.
  qe: {
    agent: ['bug', 'regression'],
    scenario: ['fixScenario'],
    harness: ['fixProfile', 'testProfile'],
    judge: ['sharpen', 'rerun3'],
    passbut: ['bug', 'tighten'],
    pass: ['rerun3'],
  },
  // A developer fixes the agent, and re-tests it.
  dev: {
    agent: ['fixAgent', 'retest', 'regression'],
    scenario: ['fixScenario', 'fixAgent'],
    harness: ['fixProfile'],
    judge: ['rerun3'],
    passbut: ['fixAgent'],
    pass: ['retest'],
  },
}

/**
 * The drill-down's actions for this owner and lens, the main one first.
 * Without `canRun` the credit-spending ones are left out, as the Scenarios
 * tab leaves out its Re-run 3× while a run is in flight.
 */
export function actionsFor(owner: RookOwner, lens: RookLens, canRun = true): DetailAction[] {
  return PLAN[lens][owner]
    .map((id, at) => ({ ...A[id], ...(lens === 'dev' && DEV_LABEL[id] !== undefined && { label: DEV_LABEL[id]! }), ...(at === 0 && { isPrimary: true }) }))
    .filter(a => canRun || a.spendsCredits !== true)
}

/** How many verdicts the header's strip shows. */
export const STRIP_RUNS = 8

export const GLYPH: Record<RookStatus, string> = { Pass: '✓', Fail: '✗', 'Unable to Verify': '?' }

/** The scenario's verdicts up to and including `runId`, oldest first, the newest `STRIP_RUNS`. */
export function historyOf(history: readonly RookVerdictHistory[], id: string, runId: string): { runId: string; status: RookStatus }[] {
  const runs = history.find(h => h.id === id)?.runs ?? []
  const at = runs.findIndex(r => r.runId === runId)

  return (at < 0 ? runs : runs.slice(0, at + 1)).slice(-STRIP_RUNS)
}

export const strip = (runs: readonly { status: RookStatus }[]): string => runs.map(r => GLYPH[r.status]).join('')

/** Not passing now, passing the run before. */
export const isRegressed = (status: RookStatus | undefined, before: readonly RookStatus[]): boolean => status !== undefined && status !== 'Pass' && before.at(-1) === 'Pass'

/** The verdict flipped between Pass and not-Pass at least twice: it does not hold still. */
export function isFlip(statuses: readonly RookStatus[]): boolean {
  return isFlaky(statuses)
}

/** The cluster of `runId` that holds the scenario and names a fault (report.yaml after `--rca`). */
export const faultOf = (clusters: readonly RookCluster[], id: string): string | undefined =>
  clusters.find(c => c.fault !== undefined && c.scenarios.some(s => s.id === id))?.fault

/** `12s`, `4m`, `3h`, `2d` ago. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))

  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}

export type WaterfallRow = { name: string; bar: string; ms: string; isFailed: boolean; error?: string; calls: string[]; ran: boolean }

const callText = (call: { name: string; arguments?: unknown }): string => {
  if (call.arguments === undefined) {
    return call.name
  }

  try {
    const text = JSON.stringify(call.arguments)

    return `${call.name}(${text.length > 80 ? `${text.slice(0, 79)}…` : text})`
  } catch {
    return call.name
  }
}

/**
 * A waterfall: each hook's bar starts where the hooks before it ended and is
 * sized by its share of the whole, so the slow one stands out and the order
 * reads left to right. Capped so the durations beside it still fit; a hook
 * that ran gets at least one cell.
 */
export function waterfall(phases: readonly RookPhase[], width: number): WaterfallRow[] {
  const total = Math.max(1, phases.reduce((sum, p) => sum + (p.durationMs ?? 0), 0))
  const room = Math.max(8, Math.min(width, 48))
  let elapsedMs = 0

  return phases.map(p => {
    const offset = Math.min(room - 1, Math.round((elapsedMs / total) * room))
    const cells = p.durationMs === undefined ? 0 : Math.max(p.ran ? 1 : 0, Math.round((p.durationMs / total) * room))

    elapsedMs += p.durationMs ?? 0

    return {
      name: p.name,
      bar: cells === 0 ? '' : ' '.repeat(offset) + '█'.repeat(Math.max(1, Math.min(cells, room - offset))),
      ms: p.durationMs === undefined ? (p.ran ? '' : 'not run') : duration(p.durationMs),
      isFailed: p.ran && !p.ok,
      ...(p.error !== undefined && { error: p.error }),
      calls: (p.calls ?? []).map(callText),
      ran: p.ran,
    }
  })
}

/** `5 turns · 69→17 tokens · 294ms`, and the same scenario's previous run beside it when known. */
export function costLine(cost: { turns?: number; tokens?: { input: number; output: number }; latencyMs?: number }): string {
  return [
    cost.turns === undefined ? undefined : `${cost.turns} turn${cost.turns === 1 ? '' : 's'}`,
    cost.tokens === undefined ? undefined : `${cost.tokens.input + cost.tokens.output} tokens (${cost.tokens.input} in, ${cost.tokens.output} out)`,
    cost.latencyMs === undefined ? undefined : duration(cost.latencyMs),
  ]
    .filter(Boolean)
    .join(' · ')
}

export type DetailInput = {
  id: string
  runId: string
  lens: RookLens
  evidence: RookEvidence | null
  /** The verdict as a row (hooks/workspace.ts `rowOf`): what the owner rules read. */
  row: RookScenarioRow | undefined
  verdicts: readonly RookVerdictHistory[]
  /** The clusters of the run shown, when it is the latest: a `fault` there is rook's own word. */
  clusters: readonly RookCluster[]
  /** The agent's tracked sources and their modification times (register.tsx `sourceStampsNow`). */
  stamps: ReadonlyMap<string, number> | undefined
  /** A flaky check's verdicts this session, the earlier verdict first. */
  checked?: readonly RookStatus[]
  canRun: boolean
}

export type DetailModel = {
  owner?: OwnerVerdict
  /** Verdicts before this run, oldest first. */
  before: RookStatus[]
  history: { runId: string; status: RookStatus }[]
  isRegressed: boolean
  isFlaky: boolean
  changed: { path: string; mtimeMs: number }[]
  sections: DetailSection[]
  actions: DetailAction[]
}

/** Everything the drill-down decides from what is already read: whose it is, what changed, what to show and offer. */
export function detailModel(input: DetailInput): DetailModel {
  const { id, runId, evidence, row } = input
  const status = evidence?.status ?? row?.status
  const before = verdictsBefore(input.verdicts, id, runId)
  const history = historyOf(input.verdicts, id, runId)
  const fault = faultOf(input.clusters, id)
  const owner =
    row === undefined || evidence === null
      ? undefined
      : ownerOf({ row, phases: evidence.phases, hasReply: evidence.paths.response !== undefined, before, ...(fault !== undefined && { fault }) })
  const isPassing = status === 'Pass'

  return {
    ...(owner !== undefined && { owner }),
    before,
    history,
    isRegressed: isRegressed(status, before),
    isFlaky: isFlip(history.map(h => h.status)) || new Set(input.checked ?? []).size > 1,
    changed: isPassing ? [] : changedSince(input.stamps, runStartMs(lastPassRun(input.verdicts, id) ?? '')),
    sections: sectionsFor(input.lens, status),
    actions: owner === undefined ? [] : actionsFor(owner.owner, input.lens, input.canRun),
  }
}
