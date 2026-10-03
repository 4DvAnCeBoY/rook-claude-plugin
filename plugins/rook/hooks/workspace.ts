import { isMap, list, num, parseMap, str, strings } from './yaml'
import type { YamlMap } from './yaml'
import type { RookCluster, RookCounts, RookCurrent, RookLane, RookRunView, RookScenarioRow, RookStatus } from '../types'

/**
 * Where rook keeps a project's files, read the way the published headless
 * contract describes them (skill-installer/skills/references/headless-contract.md):
 *
 *   .testmuai/rook/settings.json                     selects the project
 *   .testmuai/rook/projects/<id | slug--id>/active   names the active agent
 *   .../agents/<agent>/agent.yaml, features/, scenarios/, profiles/
 *   .../agents/<agent>/runs/<run-id>/run.yaml        the run's plan
 *   .../agents/<agent>/runs/<run-id>/report.yaml     written last: the run is over
 *   .../runs/<run-id>/scenarios/<SC-id>/verdict.yaml one per judged scenario
 *
 * Every read goes through `Io`, so the same code runs over `$.fs` in a session
 * and over a map of strings in a test.
 */

export type Io = {
  read: (path: string) => Promise<string | undefined>
  list: (path: string) => Promise<{ name: string; kind: string; mtimeMs?: number }[]>
}

export const ROOT = '.testmuai/rook'

/** `2026-09-28T15-54-56Z`, `-2` appended when two start in one second. */
export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/

export const SCENARIO_ID = /^SC-\d{3,}$/

export type Located = { projectDir: string; agentId: string; agentDir: string }

const dirs = async (io: Io, path: string): Promise<string[]> =>
  (await io.list(path).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name)

export function projectIdOf(settings: unknown): string | undefined {
  if (typeof settings !== 'object' || settings === null) {
    return undefined
  }

  const record = settings as { active_project_id?: unknown; selections?: unknown }

  if (typeof record.active_project_id === 'string' && record.active_project_id !== '') {
    return record.active_project_id
  }

  if (typeof record.selections === 'object' && record.selections !== null) {
    for (const selection of Object.values(record.selections as Record<string, unknown>)) {
      const id = (selection as { project_id?: unknown } | null)?.project_id

      if (typeof id === 'string' && id !== '') {
        return id
      }
    }
  }

  return undefined
}

/** The active project's agent, or undefined when this directory holds no rook workspace. */
export async function locate(io: Io): Promise<Located | undefined> {
  const settingsText = await io.read(`${ROOT}/settings.json`)

  if (settingsText === undefined) {
    return undefined
  }

  let projectId: string | undefined

  try {
    projectId = projectIdOf(JSON.parse(settingsText))
  } catch {
    projectId = undefined
  }

  const projects = await dirs(io, `${ROOT}/projects`)
  const project =
    projects.find(name => projectId !== undefined && (name === projectId || name.endsWith(`--${projectId}`))) ??
    (projects.length === 1 ? projects[0] : undefined)

  if (project === undefined) {
    return undefined
  }

  const projectDir = `${ROOT}/projects/${project}`
  const agents = await dirs(io, `${projectDir}/agents`)
  const active = (await io.read(`${projectDir}/active`))?.trim()
  const agentId = active !== undefined && agents.includes(active) ? active : agents.length === 1 ? agents[0] : undefined

  return agentId === undefined ? undefined : { projectDir, agentId, agentDir: `${projectDir}/agents/${agentId}` }
}

/** Run ids of an agent, newest first (the ids sort by the second they started). */
export async function runIds(io: Io, agentDir: string): Promise<string[]> {
  const ids = (await dirs(io, `${agentDir}/runs`)).filter(name => RUN_ID.test(name))

  return ids.sort((a, b) => compareRunIds(b, a))
}

/** Orders two run ids by start time, then by the same-second suffix. */
export function compareRunIds(a: string, b: string): number {
  const [stampA = '', suffixA = '0'] = a.split(/Z-?/)
  const [stampB = '', suffixB = '0'] = b.split(/Z-?/)

  return stampA === stampB ? Number(suffixA || 0) - Number(suffixB || 0) : stampA < stampB ? -1 : 1
}

const STATUSES: readonly RookStatus[] = ['Pass', 'Fail', 'Unable to Verify']

export const statusOf = (value: string | undefined): RookStatus | undefined =>
  STATUSES.find(status => status === value)


/** One scenario's verdict as the panel and the failure notes need it. */
export function rowOf(scenarioId: string, verdictText: string, title: string | undefined): RookScenarioRow | undefined {
  const verdict = parseMap(verdictText)
  const status = statusOf(str(verdict.status))

  if (status === undefined) {
    return undefined
  }

  const criteria = list(verdict.criteria).filter(isMap)
  const failing = criteria
    .filter(criterion => str(criterion.status) === 'Fail')
    .map(criterion => ({
      id: str(criterion.criterion_id) ?? '',
      criterion: str(criterion.criterion) ?? '',
      expected: str(criterion.expected) ?? '',
      achieved: str(criterion.achieved) ?? '',
      evidence: str(criterion.evidence) ?? '',
    }))
  // rook's evidence on a criterion it could not check says what would make it checkable.
  const unchecked = criteria
    .filter(criterion => str(criterion.status) === 'Unable to Verify')
    .flatMap(criterion => {
      const evidence = str(criterion.evidence)

      return evidence === undefined ? [] : [`${str(criterion.criterion_id) ?? '?'}: ${evidence}`]
    })

  return {
    id: scenarioId,
    title: title ?? '',
    status,
    ...(str(verdict.unverifiable_reason) !== undefined && { reason: str(verdict.unverifiable_reason) }),
    gaps: strings(verdict.verification_gaps),
    unchecked,
    compromised: verdict.compromised === true,
    summary: str(verdict.summary) ?? '',
    failing,
  }
}

export const countsOf = (rows: readonly { status: RookStatus }[]): RookCounts => ({
  pass: rows.filter(row => row.status === 'Pass').length,
  fail: rows.filter(row => row.status === 'Fail').length,
  unverifiable: rows.filter(row => row.status === 'Unable to Verify').length,
})

/** `included` scenario ids from run.yaml: what the run set out to execute. */
export const plannedIds = (run: YamlMap): string[] =>
  list(run.included).flatMap(item => (isMap(item) && str(item.scenario_id) !== undefined ? [str(item.scenario_id)!] : []))

/**
 * Verdict rows keyed by `<run>/<scenario>`. A verdict is written once and not
 * rewritten in place, so a finished file is read once per session.
 */
export type RowCache = Map<string, RookScenarioRow>

/** A scenario's verdict, read once: undefined while it has none. */
async function cachedRow(io: Io, runDir: string, runId: string, scenarioId: string, cache: RowCache): Promise<RookScenarioRow | undefined> {
  const key = `${runId}/${scenarioId}`
  const cached = cache.get(key)

  if (cached) {
    return cached
  }

  const verdictText = await io.read(`${runDir}/scenarios/${scenarioId}/verdict.yaml`)

  if (verdictText === undefined) {
    return undefined
  }

  const snapshot = parseMap((await io.read(`${runDir}/scenarios/${scenarioId}/snapshot.yaml`)) ?? '')
  const row = rowOf(scenarioId, verdictText, str(snapshot.title))

  if (row) {
    cache.set(key, row)
  }

  return row
}

/** The order rook's hooks run a scenario in (`rook run --phases`). */
const PHASES = ['prepare', 'open', 'execute', 'close', 'collect', 'judge'] as const

/**
 * What an unjudged scenario is doing, from what it has written so far: a
 * response means the judge has it; otherwise the phase after the last one its
 * hooks finished; otherwise a request means the agent has it.
 */
async function laneOf(io: Io, scenarioDir: string, id: string, since: number): Promise<RookLane> {
  const snapshot = parseMap((await io.read(`${scenarioDir}/snapshot.yaml`)) ?? '')
  const title = str(snapshot.title) ?? ''
  const entries = await io.list(scenarioDir).catch(() => [])
  const names = new Set(entries.map(entry => entry.name))
  // snapshot.yaml is written as the scenario starts; the folder's own time moves with every file.
  const started = entries.find(entry => entry.name === 'snapshot.yaml')?.mtimeMs
  since = started !== undefined && started > 0 ? started : since

  if (names.has('response.json') || names.has('output.txt')) {
    return { id, title, phase: 'judging', since }
  }

  let phase = names.has('request.json') ? 'execute' : 'starting'

  if (names.has('hooks.json')) {
    try {
      const hooks = JSON.parse((await io.read(`${scenarioDir}/hooks.json`)) ?? '{}') as { phases?: Record<string, { ran?: boolean }> }
      const ran = PHASES.filter(name => hooks.phases?.[name]?.ran === true)
      const last = ran.at(-1)

      phase = last === undefined ? phase : (PHASES[PHASES.indexOf(last) + 1] ?? 'judge')
    } catch {
      // half-written: keep what the file names said
    }
  }

  return { id, title, phase: phase === 'judge' ? 'judging' : phase, since }
}

/** The cause and remedy of `remedies/<cluster>.md`, which `--rca` writes beside report.yaml. */
export function remedyFile(text: string): { cause?: string; remedy?: string } {
  const sections = new Map<string, string[]>()
  let current: string[] | undefined
  let isFenced = false

  // A `## ` line inside a fenced block (a diff adding a heading) is content, not a section.
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      isFenced = !isFenced
    }

    const heading = isFenced ? null : /^## (.+?)\s*$/.exec(line)

    if (heading) {
      current = []
      sections.set(heading[1]!, current)
    } else {
      current?.push(line)
    }
  }

  const section = (name: string) => {
    const body = sections.get(name)?.join('\n').trim()

    return body === undefined || body === '' ? undefined : body
  }
  const cause = section('Cause')
  const remedy = section('Remedy')

  return { ...(cause !== undefined && { cause }), ...(remedy !== undefined && { remedy }) }
}

async function clustersOf(io: Io, runDir: string, report: YamlMap): Promise<RookCluster[]> {
  const clusters: RookCluster[] = []

  for (const item of list(report.clusters).filter(isMap)) {
    const id = str(item.id)

    if (id === undefined) {
      continue
    }

    let cause = str(item.cause)
    let remedy = str(item.remedy)

    // report.yaml carries the short form; the file carries all of it, diffs included.
    if (/^CL-\d+$/.test(id)) {
      const file = await io.read(`${runDir}/remedies/${id}.md`)

      if (file !== undefined) {
        const full = remedyFile(file)
        cause = full.cause ?? cause
        remedy = full.remedy ?? remedy
      }
    }

    const fault = str(item.fault)
    const confidence = str(item.confidence)
    const featureId = str(item.feature_id)

    clusters.push({
      id,
      why: str(item.why) ?? '',
      kind: str(item.kind) ?? 'failed',
      ...(featureId !== undefined && { featureId }),
      scenarios: list(item.scenarios)
        .filter(isMap)
        .flatMap(s => (str(s.scenario_id) === undefined ? [] : [{ id: str(s.scenario_id)!, title: str(s.title) ?? '' }])),
      ...(cause !== undefined && { cause }),
      ...(remedy !== undefined && { remedy }),
      ...(fault !== undefined && { fault }),
      ...(confidence !== undefined && { confidence }),
      where: strings(item.where),
    })
  }

  return clusters
}

/** A run as it stands on disk: planned, judged so far, in flight, finished or not. */
export async function readRun(io: Io, agentDir: string, runId: string, cache: RowCache): Promise<RookRunView | undefined> {
  const runDir = `${agentDir}/runs/${runId}`
  const runText = await io.read(`${runDir}/run.yaml`)

  if (runText === undefined) {
    return undefined
  }

  const run = parseMap(runText)
  const reportText = await io.read(`${runDir}/report.yaml`)
  const scenarioDirs = (await io.list(`${runDir}/scenarios`).catch(() => []))
    .filter(entry => entry.kind === 'dir' && SCENARIO_ID.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const rows: RookScenarioRow[] = []
  const lanes: RookLane[] = []

  for (const entry of scenarioDirs) {
    const row = await cachedRow(io, runDir, runId, entry.name, cache)

    if (row) {
      rows.push(row)
    } else if (reportText === undefined) {
      lanes.push(await laneOf(io, `${runDir}/scenarios/${entry.name}`, entry.name, entry.mtimeMs ?? 0))
    }
  }

  const planned = plannedIds(run)
  const view: RookRunView = {
    runId,
    ...(str(run.name) !== undefined && { name: str(run.name) }),
    ...(str(run.created) !== undefined && { created: str(run.created) }),
    planned: Math.max(planned.length, rows.length),
    done: rows.length,
    finished: reportText !== undefined,
    counts: countsOf(rows),
    rows,
    lanes,
    clusters: [],
    next: [],
  }

  if (reportText === undefined) {
    return view
  }

  const report = parseMap(reportText)
  const totals = isMap(report.totals) ? report.totals : {}
  const metrics = isMap(report.metrics) ? report.metrics : {}
  const passed = num(totals.passed)
  const failed = num(totals.failed)
  const unverifiable = num(totals.unverifiable)
  const executed = num(totals.planned)

  return {
    ...view,
    ...(executed !== undefined && { planned: executed }),
    counts: {
      pass: passed ?? view.counts.pass,
      fail: failed ?? view.counts.fail,
      unverifiable: unverifiable ?? view.counts.unverifiable,
    },
    clusters: await clustersOf(io, runDir, report),
    next: strings(report.next),
    ...(num(totals.pass_rate) !== undefined && { passRate: num(totals.pass_rate) }),
    ...(num(metrics.credits) !== undefined && { credits: num(metrics.credits) }),
    ...(num(metrics.duration_ms) !== undefined && { durationMs: num(metrics.duration_ms) }),
    ...(str(report.headline) !== undefined && { headline: str(report.headline) }),
    ...(str(report.narrative) !== undefined && { narrative: str(report.narrative) }),
  }
}

/** How many runs back the per-scenario view looks. */
export const HISTORY = 30

/**
 * Each scenario's newest verdict across the agent's runs, and the verdict it
 * had in the run before that. A re-test of two scenarios then moves two rows
 * instead of standing in for the whole agent, and "fixed" or "regressed" is
 * measured per scenario, never between runs of different scope.
 */
export async function currentVerdicts(io: Io, agentDir: string, ids: readonly string[], cache: RowCache): Promise<RookCurrent[]> {
  const current = new Map<string, RookCurrent>()

  for (const runId of ids.slice(0, HISTORY)) {
    const runDir = `${agentDir}/runs/${runId}`
    const scenarioIds = (await dirs(io, `${runDir}/scenarios`)).filter(name => SCENARIO_ID.test(name))

    for (const scenarioId of scenarioIds) {
      const seen = current.get(scenarioId)

      if (seen !== undefined && seen.was !== undefined) {
        continue
      }

      const row = await cachedRow(io, runDir, runId, scenarioId, cache)

      if (row === undefined) {
        continue
      }

      if (seen === undefined) {
        current.set(scenarioId, { id: scenarioId, title: row.title, status: row.status, runId })
      } else {
        current.set(scenarioId, { ...seen, title: seen.title || row.title, was: row.status })
      }
    }
  }

  return [...current.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Scenarios of the latest run whose verdict changed against their previous one. */
export function changesIn(current: readonly RookCurrent[], runId: string | undefined): { fixed: RookCurrent[]; regressed: RookCurrent[] } {
  const moved = current.filter(row => row.runId === runId && row.was !== undefined && row.was !== row.status)

  return {
    fixed: moved.filter(row => row.status === 'Pass'),
    regressed: moved.filter(row => row.was === 'Pass'),
  }
}
