import type { RookCriterion, RookEvidence } from '../types'
import { clip, excerpt } from './format'
import { OWNER_LABEL } from './owner'
import type { OwnerVerdict } from './owner'

/**
 * What the drill-down hands Claude: a bug report, a fix to the agent, the
 * scenario or the profile. Each is grounded in the scenario's evidence on
 * disk (the judge's words, the turns it quoted, the tool calls, the hooks,
 * the files that changed) so Claude starts from what rook saw, not from a
 * summary of it. Pure.
 */

/** A tracked source modified since the scenario last passed (hooks/changes.ts `changedSince`). */
export type ChangedFile = { path: string; mtimeMs: number }

/** What the evidence files do not say but the pane knows. */
export type PromptAbout = {
  agentId?: string
  profileId?: string
  /** The scenario file's `class`: `adversarial` raises a bug's severity. */
  cls?: string
  /** verdict.yaml `compromised`: the agent was manipulated. */
  compromised?: boolean
  /** The scenario's own file, for prompts that change it. */
  scenarioPath?: string
  /** The profile's file, for prompts that fix it. */
  profilePath?: string
}

/** How a scenario-side fix is framed: wrong outright, too vague for the judge, or too loose to catch a weak pass. */
export type ScenarioFixMode = 'fix' | 'sharpen' | 'tighten'

const TURN_MAX = 400
const FIELD_MAX = 500

const args = (value: unknown): string => {
  if (value === undefined) {
    return ''
  }

  try {
    return clip(JSON.stringify(value), 160)
  } catch {
    return ''
  }
}

const callLine = (call: { name: string; arguments?: unknown }) => `${call.name}(${args(call.arguments)})`

/** Criteria the prompt is about: everything not passed, then passes the judge was unsure of. */
const doubtful = (e: RookEvidence): RookCriterion[] => [
  ...e.criteria.filter(c => c.status !== 'Pass'),
  ...e.criteria.filter(c => c.status === 'Pass' && c.confidence === 'Low'),
]

const criterionLines = (c: RookCriterion): string[] => [
  `- ${c.id} [${c.status}${c.confidence === undefined ? '' : `, ${c.confidence} confidence`}${c.status === 'Pass' && c.confidence === 'Low' ? ', weak pass' : ''}] ${clip(c.criterion, 300)}`,
  ...(c.expected ? [`  expected: ${clip(c.expected, FIELD_MAX)}`] : []),
  ...(c.achieved ? [`  achieved: ${clip(c.achieved, FIELD_MAX)}`] : []),
  ...(c.evidence ? [`  evidence: ${clip(c.evidence, FIELD_MAX)}`] : []),
]

const roleOf = (role: string) => (role === 'user' ? 'rook (as the user)' : role)

/** The scenario as rook judged it: owner, criteria, cited turns, tool calls, hooks, changed files, evidence files. */
export function evidenceBlock(e: RookEvidence, owner: OwnerVerdict, changed: readonly ChangedFile[] = [], about: PromptAbout = {}): string {
  const criteria = doubtful(e)
  const cited = e.transcript.filter(t => t.isCited)
  const broken = e.phases.filter(p => p.ran && !p.ok)
  const paths = [e.paths.verdict, e.paths.response, e.paths.hooks, e.paths.request].filter((p): p is string => p !== undefined)

  return [
    `rook scenario ${e.id}${e.title ? ` (${e.title})` : ''} in run ${e.runId}${about.agentId ? ` against agent ${about.agentId}` : ''}: ${e.status}.`,
    `Owner: ${OWNER_LABEL[owner.owner]} — ${owner.why}`,
    ...(e.goal ? [`Goal rook pursued as the user: ${clip(e.goal, FIELD_MAX)}`] : []),
    ...(e.why ? [`What the scenario is meant to catch: ${clip(e.why, 300)}`] : []),
    ...(e.summary ? [`Judge's summary: ${clip(e.summary, FIELD_MAX)}`] : []),
    ...(criteria.length > 0 ? ['', 'Criteria in question:', ...criteria.flatMap(criterionLines)] : []),
    ...(e.forbiddenHits.length > 0 ? [`Forbidden patterns that appeared: ${e.forbiddenHits.join(', ')}`] : []),
    ...(e.gaps.length > 0 ? [`What the judge could not see: ${e.gaps.map(g => clip(g, 200)).join('; ')}`] : []),
    ...(cited.length > 0 ? ['', 'Turns the judge quoted:', ...cited.map(t => `- ${roleOf(t.role)}: "${excerpt(t.content, TURN_MAX)}"`)] : []),
    ...(e.toolCalls.length > 0 ? [`Tool calls the agent made: ${e.toolCalls.map(callLine).join(', ')}`] : ['Tool calls the agent made: none recorded']),
    ...broken.map(p => `The ${p.name} hook failed${p.error ? `: ${clip(p.error, 300)}` : ''}`),
    ...(changed.length > 0 ? [`Files changed since it last passed: ${changed.slice(0, 10).map(f => f.path).join(', ')}`] : []),
    '',
    `Evidence files: ${paths.join(', ')}`,
  ].join('\n')
}

/** The exact re-test: one scenario through the rook run tool. */
export const retestLine = (id: string): string =>
  `Re-test with the rook run tool, passing only=["${id}"] (it calls the agent for real and spends credits).`

const isHigh = (e: RookEvidence, about: PromptAbout) => about.compromised === true || about.cls === 'adversarial' || e.forbiddenHits.length > 0

/** A bug report for the agent's owner, from the evidence alone. */
export function bugReportPrompt(e: RookEvidence, owner: OwnerVerdict, changed: readonly ChangedFile[] = [], about: PromptAbout = {}): string {
  const severity = isHigh(e, about) ? 'high' : e.status === 'Fail' ? 'medium' : 'low'
  const said = e.output ?? [...e.transcript].reverse().find(t => t.role !== 'user')?.content

  return [
    evidenceBlock(e, owner, changed, about),
    '',
    'Draft a bug report against the agent from this evidence. Read the evidence files first. Give it:',
    `- a one-line title naming the behaviour, not the scenario id`,
    `- severity: ${severity}${severity === 'high' ? ` (${about.compromised ? 'rook marked the run compromised' : about.cls === 'adversarial' ? 'an adversarial scenario' : 'a forbidden pattern appeared'})` : ''}`,
    `- steps to reproduce: the goal and each turn rook sent as the user, in order${about.profileId ? `, through profile ${about.profileId}` : ''}`,
    '- expected: what the failing criteria ask for',
    `- actual: quote the agent${said ? ` (its last reply: "${excerpt(said, TURN_MAX)}")` : ''} and list the tool calls it made`,
    '- evidence: the file paths above',
    '',
    'Use only what the evidence shows; if it does not support an agent bug, say so instead of writing one.',
    `Once it is fixed: ${retestLine(e.id)}`,
  ].join('\n')
}

/** Fix the agent: the failing criteria are the spec, the changed files the first suspects. */
export function fixAgentPrompt(e: RookEvidence, owner: OwnerVerdict, changed: readonly ChangedFile[] = [], about: PromptAbout = {}): string {
  return [
    evidenceBlock(e, owner, changed, about),
    '',
    'Fix the agent so it meets the criteria in question. Read the evidence files first' +
      (changed.length > 0 ? ', then the files changed since it last passed: the regression is most likely there.' : ', then the agent code behind the tool calls above.'),
    'If the evidence shows the criterion is wrong rather than the agent, say so and stop instead of changing the agent.',
    retestLine(e.id),
  ].join('\n')
}

const SCENARIO_ASK: Record<ScenarioFixMode, string> = {
  fix: 'The scenario, not the agent, looks wrong: it asks for something this agent or its environment cannot do, or its criterion does not match what the goal asks.',
  sharpen: 'The judge could not decide this scenario. Make the criterion observable and decidable from what the profile records (the reply, the tool calls), or say what the profile must record.',
  tighten: 'It passed, but not convincingly. Tighten the scenario so a pass means the behaviour really happened: a criterion that names the exact reply or tool call expected.',
}

/** Fix the scenario: propose a corrected criterion and write it through rook, never touching the agent. */
export function fixScenarioPrompt(e: RookEvidence, owner: OwnerVerdict, about: PromptAbout = {}, mode: ScenarioFixMode = 'fix'): string {
  return [
    evidenceBlock(e, owner, [], about),
    '',
    SCENARIO_ASK[mode],
    `Read the evidence files${about.scenarioPath ? ` and the scenario file ${about.scenarioPath}` : ''}, then propose a corrected criterion (old and new wording) and why the evidence supports it.`,
    'Apply it through rook: write the replacement with the rook generate tool (an instruction naming this feature and the corrected criterion), ' +
      `and leave ${e.id} out of runs with the rook curate tool (action exclude) once the replacement exists. Ask me before either: both change what is tested, and generate spends credits.`,
    'Do not change the agent.',
    `Then: ${retestLine(e.id)}`,
  ].join('\n')
}

/** Fix the profile: the hook that broke, read before it is changed, tested before the scenario is re-run. */
export function fixProfilePrompt(e: RookEvidence, owner: OwnerVerdict, about: PromptAbout = {}): string {
  return [
    evidenceBlock(e, owner, [], about),
    '',
    'The profile, not the agent, broke: the agent was not really tested.',
    `Read the profile${about.profilePath ? ` ${about.profilePath}` : about.profileId ? ` ${about.profileId}` : ''} and the hook script it invokes` +
      `${e.paths.request ? ` (request.json names it under "invoked")` : ''}, and the hooks.json above for the hook that failed and its error.`,
    'Fix the hook script or the profile so the hook succeeds and records the reply and the tool calls. Do not change the agent or the scenario.',
    `Then check it with the rook profile_test tool${about.profileId ? ` (profile ${about.profileId})` : ''} before re-running the scenario.`,
    retestLine(e.id),
  ].join('\n')
}
