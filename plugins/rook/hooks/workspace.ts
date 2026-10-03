import { isMap, list, num, parseMap, str, strings } from './yaml'
import type { YamlMap } from './yaml'
import type { RookCounts, RookRunView, RookScenarioRow, RookStatus } from '../types'

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
  list: (path: string) => Promise<{ name: string; kind: string }[]>
}

export const ROOT = '.testmuai/rook'

/** `2026-09-28T15-54-56Z`, `-2` appended when two start in one second. */
export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/

export const SCENARIO_ID = /^SC-\d{3,}$/

export type Located = { projectDir: string; agentId: string; agentDir: string }

const dirs = async (io: Io, path: string): Promise<string[]> =>
  (await io.list(path).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name)

function projectIdOf(settings: unknown): string | undefined {
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

  const failing = list(verdict.criteria)
    .filter(isMap)
    .filter(criterion => str(criterion.status) === 'Fail')
    .map(criterion => ({
      id: str(criterion.criterion_id) ?? '',
      criterion: str(criterion.criterion) ?? '',
      expected: str(criterion.expected) ?? '',
      achieved: str(criterion.achieved) ?? '',
      evidence: str(criterion.evidence) ?? '',
    }))

  return {
    id: scenarioId,
    title: title ?? '',
    status,
    ...(str(verdict.unverifiable_reason) !== undefined && { reason: str(verdict.unverifiable_reason) }),
    gaps: strings(verdict.verification_gaps),
    compromised: verdict.compromised === true,
    summary: str(verdict.summary) ?? '',
    failing,
  }
}

export const countsOf = (rows: readonly RookScenarioRow[]): RookCounts => ({
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

/** A run as it stands on disk: planned, judged so far, finished or not. */
export async function readRun(io: Io, agentDir: string, runId: string, cache: RowCache): Promise<RookRunView | undefined> {
  const runDir = `${agentDir}/runs/${runId}`
  const runText = await io.read(`${runDir}/run.yaml`)

  if (runText === undefined) {
    return undefined
  }

  const run = parseMap(runText)
  const reportText = await io.read(`${runDir}/report.yaml`)
  const scenarioDirs = (await dirs(io, `${runDir}/scenarios`)).filter(name => SCENARIO_ID.test(name)).sort()
  const rows: RookScenarioRow[] = []

  for (const scenarioId of scenarioDirs) {
    const key = `${runId}/${scenarioId}`
    const cached = cache.get(key)

    if (cached) {
      rows.push(cached)
      continue
    }

    const verdictText = await io.read(`${runDir}/scenarios/${scenarioId}/verdict.yaml`)

    if (verdictText === undefined) {
      continue
    }

    const snapshot = parseMap((await io.read(`${runDir}/scenarios/${scenarioId}/snapshot.yaml`)) ?? '')
    const row = rowOf(scenarioId, verdictText, str(snapshot.title))

    if (row) {
      cache.set(key, row)
      rows.push(row)
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
    ...(num(totals.pass_rate) !== undefined && { passRate: num(totals.pass_rate) }),
    ...(num(metrics.credits) !== undefined && { credits: num(metrics.credits) }),
    ...(str(report.headline) !== undefined && { headline: str(report.headline) }),
  }
}

/** The totals of the newest finished run older than `beforeId`, for the trend. */
export async function previousFinished(
  io: Io,
  agentDir: string,
  ids: readonly string[],
  beforeId: string,
): Promise<{ runId: string; passed: number; failed: number } | undefined> {
  for (const runId of ids) {
    if (compareRunIds(runId, beforeId) >= 0) {
      continue
    }

    const reportText = await io.read(`${agentDir}/runs/${runId}/report.yaml`)

    if (reportText === undefined) {
      continue
    }

    const totals = parseMap(reportText).totals
    const passed = isMap(totals) ? num(totals.passed) : undefined
    const failed = isMap(totals) ? num(totals.failed) : undefined

    if (passed !== undefined && failed !== undefined) {
      return { runId, passed, failed }
    }
  }

  return undefined
}
