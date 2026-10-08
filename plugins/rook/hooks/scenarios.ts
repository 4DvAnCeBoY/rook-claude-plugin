import { isMap, list, parseMap, str } from './yaml'
import { clip } from './format'
import type { Io } from './workspace'
import { SCENARIO_ID } from './workspace'
import type { RookCurrent, RookScenarioRow, RookStatus } from '../types'

/**
 * The Scenarios tab's pure side: every scenario of the agent as its YAML
 * describes it (excluded ones too), the filters, flaky checks and the prompts
 * the tab hands Claude. No `$`: register.tsx reads through `Io`.
 */

export type ScenarioInfo = {
  id: string
  title: string
  featureId?: string
  /** `functional`, `non-functional` or `adversarial`. */
  class?: string
  category?: string
  excluded: boolean
  /** `description`, or the scenario's `goal`: what is asked of the agent. */
  description?: string
  /** Why rook wrote it: the failure it is meant to catch. */
  why?: string
  /** The acceptance criteria's statements. */
  criteria: string[]
}

/** A scenario beside its newest verdict. */
export type ScenarioView = ScenarioInfo & { status?: RookStatus; runId?: string }

export const FILTERS = [
  { id: 'all', label: 'all' },
  { id: 'failing', label: 'failing' },
  { id: 'unverifiable', label: 'unable to verify' },
  { id: 'never', label: 'never run' },
  { id: 'functional', label: 'functional' },
  { id: 'adversarial', label: 'adversarial' },
] as const

export type ScenarioFilter = (typeof FILTERS)[number]['id']

export const isFilter = (value: string): value is ScenarioFilter => FILTERS.some(f => f.id === value)

/** One scenario file, read as rook writes it. */
export function scenarioOf(id: string, text: string): ScenarioInfo {
  const doc = parseMap(text)
  const featureId = str(doc.feature_id)
  const cls = str(doc.class)
  const category = str(doc.category)
  const description = str(doc.description) ?? str(doc.goal)
  const why = str(doc.why)
  const criteria = list(doc.acceptance_criteria ?? doc.criteria).flatMap(item =>
    typeof item === 'string' ? [item] : isMap(item) && str(item.statement ?? item.criterion) !== undefined ? [str(item.statement ?? item.criterion)!] : [],
  )

  return {
    id,
    title: str(doc.title) ?? '',
    ...(featureId !== undefined && { featureId }),
    ...(cls !== undefined && { class: cls }),
    ...(category !== undefined && { category }),
    excluded: doc.excluded === true,
    ...(description !== undefined && { description: description.trim() }),
    ...(why !== undefined && { why: why.trim() }),
    criteria,
  }
}

/** Every scenario under `<agent>/scenarios/`, excluded ones included, by id. */
export async function readScenarios(io: Io, agentDir: string): Promise<ScenarioInfo[]> {
  const names = (await io.list(`${agentDir}/scenarios`).catch(() => []))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.yaml'))
    .map(entry => entry.name.replace(/\.yaml$/, ''))
    .filter(id => SCENARIO_ID.test(id))
  const found: ScenarioInfo[] = []

  for (const id of names) {
    const text = await io.read(`${agentDir}/scenarios/${id}.yaml`)

    if (text !== undefined) {
      found.push(scenarioOf(id, text))
    }
  }

  return found.sort((a, b) => a.id.localeCompare(b.id))
}

/** The scenarios beside their newest verdicts. */
export function withVerdicts(scenarios: readonly ScenarioInfo[], current: readonly RookCurrent[]): ScenarioView[] {
  const latest = new Map(current.map(row => [row.id, row]))

  return scenarios.map(s => {
    const row = latest.get(s.id)

    return row === undefined ? { ...s } : { ...s, status: row.status, runId: row.runId }
  })
}

export function filterScenarios(rows: readonly ScenarioView[], filter: string): ScenarioView[] {
  switch (filter) {
    case 'failing':
      return rows.filter(row => row.status === 'Fail')
    case 'unverifiable':
      return rows.filter(row => row.status === 'Unable to Verify')
    case 'never':
      return rows.filter(row => row.status === undefined)
    case 'functional':
    case 'adversarial':
      return rows.filter(row => row.class === filter)
    default:
      return [...rows]
  }
}

/** The selection with `ids` toggled, `add`ed or removed. */
export const toggled = (selected: readonly string[], id: string): string[] =>
  selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id].sort()

export const withAll = (selected: readonly string[], ids: readonly string[]): string[] => [...new Set([...selected, ...ids])].sort()

/** Verdicts that disagree: the scenario is flaky. */
export const isFlaky = (verdicts: readonly RookStatus[] | undefined): boolean => new Set(verdicts ?? []).size > 1

export const FLAKY_DEFAULT = 3
export const FLAKY_MAX = 10

/** `/rook flaky <id> [n]`. */
export function parseFlakyArgs(args: readonly string[]): { id: string; times: number } | { error: string } {
  const [id, times] = args

  if (id === undefined || !/^SC-\d{3,6}$/.test(id)) {
    return { error: 'usage: /rook flaky SC-001 [times] (runs one scenario several times in a row; spends credits each time)' }
  }

  if (times === undefined) {
    return { id, times: FLAKY_DEFAULT }
  }

  const n = Number(times)

  return Number.isInteger(n) && n >= 2 && n <= FLAKY_MAX ? { id, times: n } : { error: `times is a whole number from 2 to ${FLAKY_MAX}.` }
}

/** What a finished flaky check says; `prior` is the scenario's newest verdict from before the check. */
export function flakyText(id: string, verdicts: readonly RookStatus[], times: number, prior?: RookStatus): string {
  const said = verdicts.join(', ')

  if (verdicts.length < times) {
    return `flaky check of ${id} stopped after ${verdicts.length}/${times} runs${said ? `: ${said}` : ''}.`
  }

  const before = prior === undefined ? '' : `earlier ${prior}, then `

  if (isFlaky(prior === undefined ? verdicts : [prior, ...verdicts])) {
    return isFlaky(verdicts) ? `${id} is FLAKY: ${before}${times} runs disagreed (${said}).` : `${id} is FLAKY: ${before}${said}. Its verdict changed between runs.`
  }

  return `${id} is stable: ${before}${times} runs, all ${verdicts[0] ?? '?'}.`
}

/** The instruction for `rook generate` that turns a failure into a regression scenario of its feature. */
export function regressionInstruction(info: ScenarioInfo, row: RookScenarioRow | undefined): string {
  const broke = row?.failing[0]
  const what = broke !== undefined ? `${clip(broke.criterion, 240)} (achieved instead: ${clip(broke.achieved, 240)})` : clip(row?.summary || info.title, 300)

  return (
    `Regression scenario for feature ${info.featureId ?? '(the feature of ' + info.id + ')'}: pin the bug ${info.id} found — ${what}. ` +
    'Write one focused scenario that fails while this bug is present and passes once it is fixed. Cover only this feature.'
  )
}

/** The prompt that asks Claude to write the regression scenario with the rook generate tool. */
export function regressionPrompt(info: ScenarioInfo, row: RookScenarioRow | undefined, verdictPath: string | undefined): string {
  return [
    `rook scenario ${info.id}${info.title ? ` (${info.title})` : ''} failed${info.featureId ? ` in feature ${info.featureId}` : ''}.`,
    ...(verdictPath === undefined ? [] : [`Its verdict: ${verdictPath}`]),
    'Turn this bug into a regression test: call the rook generate tool with this instruction (keep it scoped to the feature):',
    '',
    regressionInstruction(info, row),
    '',
    'It spends credits; do not pass force. Then tell me the new scenario id.',
  ].join('\n')
}
