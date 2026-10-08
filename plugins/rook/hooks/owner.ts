import type { RookOwner, RookPhase, RookScenarioRow, RookStatus } from '../types'

/**
 * Who acts on a scenario's verdict, and why, from the evidence alone. A QE
 * files agent bugs and fixes scenario and profile problems; a developer fixes
 * agent bugs. Pure.
 *
 * Order matters: a broken hook means the agent was not really tested, so it
 * wins over the judge; a scenario that has never passed points at the
 * scenario before the agent.
 */

export type OwnerInput = {
  row: RookScenarioRow
  /** hooks.json, when read (the drill-down). Without it a hook failure is seen only through `reason`. */
  phases?: readonly RookPhase[]
  /** False when response.json is missing: no reply was recorded. */
  hasReply?: boolean
  /** The scenario's earlier verdicts, oldest first, not counting this one. */
  before?: readonly RookStatus[]
  /** report.yaml's cluster `fault` for this scenario, once `--rca` explained it: rook's own word wins. */
  fault?: string
}

export type OwnerVerdict = { owner: RookOwner; why: string }

/** How many earlier failures make "never passed" a scenario problem rather than a new bug. */
export const NEVER_PASSED_RUNS = 3

const FAULTS: Record<string, RookOwner> = { agent: 'agent', scenario: 'scenario', harness: 'harness' }

/** Hooks that run before or during the agent's turn: if one fails, the agent was not really tested. */
const REACHES_AGENT = new Set(['prepare', 'open', 'execute'])

const REASON_WORDS: Record<string, string> = {
  not_observable: 'what it needed to see was not in the evidence',
  undecidable: 'the evidence does not settle it either way',
}

export const OWNER_LABEL: Record<RookOwner, string> = {
  agent: 'agent bug',
  scenario: 'scenario wrong',
  harness: 'profile broke',
  judge: 'judge unsure',
  passbut: 'passed, but…',
  pass: 'pass',
}

/** The colour each owner is drawn in. */
export const OWNER_COLOR: Record<RookOwner, string> = {
  agent: 'red',
  scenario: 'magenta',
  harness: 'yellow',
  judge: 'blue',
  passbut: 'yellow',
  pass: 'green',
}

export function ownerOf(input: OwnerInput): OwnerVerdict {
  const { row } = input
  const failed = input.phases?.find(p => p.ran && !p.ok)
  // Only a hook before or during the agent's turn means it was not tested; a
  // failed close or collect means some evidence is missing, said beside the verdict.
  const broken = failed !== undefined && REACHES_AGENT.has(failed.name) ? failed : undefined
  const missing = failed !== undefined && broken === undefined ? ` The ${failed.name} hook failed${failed.error ? ` (${clipped(failed.error)})` : ''}, so some evidence may be missing.` : ''

  if (row.status === 'Pass') {
    const reasons = [
      ...(row.forbiddenHits?.length ? [`a forbidden pattern appeared (${row.forbiddenHits.slice(0, 2).join(', ')})`] : []),
      ...(row.weakPasses?.length ? [`${row.weakPasses.join(', ')} passed with Low confidence`] : []),
      ...(row.compliance !== undefined && row.compliance < 100 ? [`compliance is ${row.compliance}%`] : []),
      ...(row.compromised ? ['rook marked it compromised'] : []),
    ]

    return reasons.length > 0 ? { owner: 'passbut', why: `Pass, but ${reasons.join('; ')}.` } : { owner: 'pass', why: 'Every criterion passed.' }
  }

  const fault = input.fault === undefined ? undefined : FAULTS[input.fault]

  if (fault !== undefined) {
    return { owner: fault, why: `rook's root-cause analysis puts the fault on the ${fault === 'harness' ? 'profile' : fault}.` }
  }

  if (broken !== undefined) {
    return { owner: 'harness', why: `The ${broken.name} hook failed${broken.error ? `: ${clipped(broken.error)}` : ''}. The agent was not really tested.` }
  }

  if (row.reason === 'agent_never_ran' || input.hasReply === false) {
    return { owner: 'harness', why: 'No reply from the agent was recorded, so nothing about the agent was tested. Check the profile.' }
  }

  if (row.status === 'Unable to Verify') {
    // rook's own gap note says why in words; a criterion's evidence is often a quote, so it comes last.
    const gap = row.gaps[0] ?? REASON_WORDS[row.reason ?? ''] ?? row.unchecked[0]

    return { owner: 'judge', why: `The judge could not check it${gap ? `: ${clipped(gap)}` : ''}.${missing}` }
  }

  const before = input.before ?? []

  if (before.length >= NEVER_PASSED_RUNS && !before.includes('Pass')) {
    return { owner: 'scenario', why: `It has never passed in ${before.length + 1} runs. The scenario may ask for something this agent or environment cannot do.${missing}` }
  }

  if (row.compromised) {
    return { owner: 'agent', why: `rook marked the run compromised: the agent was manipulated.${missing}` }
  }

  const regressed = before.at(-1) === 'Pass' ? ' It passed the run before.' : ''

  return { owner: 'agent', why: `The agent replied and the judge failed ${row.failing.map(f => f.id).join(', ') || 'it'}.${regressed}${missing}` }
}

/** A Pass nothing undermines: no forbidden hit, no weak criterion, full compliance. */
export const isTrustedPass = (row: RookScenarioRow): boolean => ownerOf({ row }).owner === 'pass'

/** Trusted passes over every judged scenario, 0–1; undefined with none. */
export function trustedRate(rows: readonly RookScenarioRow[]): number | undefined {
  return rows.length === 0 ? undefined : rows.filter(isTrustedPass).length / rows.length
}

/** Pass and Fail swapping places this many times in the window makes a scenario flaky. */
export const FLAKY_FLIPS = 2
export const FLAKY_WINDOW = 8

/**
 * The one flaky rule every view uses: Pass and Fail swap places twice or more
 * in the last 8 verdicts. Unable to Verify says nothing about the agent, so it
 * neither makes nor breaks a flip.
 */
export function isFlaky(statuses: readonly RookStatus[]): boolean {
  const decided = statuses.slice(-FLAKY_WINDOW).filter(s => s !== 'Unable to Verify')

  return decided.filter((s, at) => at > 0 && s !== decided[at - 1]).length >= FLAKY_FLIPS
}

const clipped = (text: string): string => (text.length > 160 ? `${text.slice(0, 157)}…` : text)
