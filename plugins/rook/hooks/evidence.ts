import type { RookConfidence, RookCriterion, RookEvidence, RookPhase, RookStatus, RookTurn, RookVerdictHistory } from '../types'
import { compareRunIds, SCENARIO_ID, statusOf } from './workspace'
import type { Io } from './workspace'
import { isMap, list, num, parseMap, str, strings } from './yaml'

/**
 * Everything one scenario's run left on disk, read on demand for the
 * drill-down, and each scenario's verdicts across recent runs. Pure: reads
 * through `Io`, never the engine.
 *
 *   runs/<run>/scenarios/<SC>/verdict.yaml   criteria (passes too) with confidence, usage, latency
 *   runs/<run>/scenarios/<SC>/snapshot.yaml  goal, why, feature_id, title
 *   runs/<run>/scenarios/<SC>/hooks.json     each profile hook: ran, ok, durationMs, error, data.calls
 *   runs/<run>/scenarios/<SC>/request.json   what rook asked
 *   runs/<run>/scenarios/<SC>/response.json  transcript, output, raw_response.calls
 */

/** The order rook's hooks run a scenario in. */
export const PHASE_ORDER = ['prepare', 'open', 'execute', 'close', 'collect', 'judge'] as const

const CONFIDENCES: readonly RookConfidence[] = ['High', 'Medium', 'Low']

const confidenceOf = (value: string | undefined): RookConfidence | undefined => {
  const word = value === undefined ? undefined : value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()

  return CONFIDENCES.find(c => c === word)
}

/** Every criterion of a verdict, passes included, in the order rook wrote them. */
export function criteriaOf(verdictText: string): RookCriterion[] {
  return list(parseMap(verdictText).criteria)
    .filter(isMap)
    .flatMap(c => {
      const status = statusOf(str(c.status))
      const confidence = confidenceOf(str(c.confidence))

      return status === undefined
        ? []
        : [
            {
              id: str(c.criterion_id) ?? '?',
              criterion: str(c.criterion) ?? '',
              status,
              expected: str(c.expected) ?? '',
              achieved: str(c.achieved) ?? '',
              evidence: str(c.evidence) ?? '',
              ...(confidence !== undefined && { confidence }),
            },
          ]
    })
}

type Json = Record<string, unknown>

const asObject = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined)

function parseJson(text: string | undefined): Json | undefined {
  if (text === undefined) {
    return undefined
  }

  try {
    return asObject(JSON.parse(text))
  } catch {
    return undefined
  }
}

const callsIn = (value: unknown): { name: string; arguments?: unknown }[] =>
  Array.isArray(value)
    ? value.flatMap(call => {
        const record = asObject(call)

        return typeof record?.name === 'string' ? [{ name: record.name, ...(record.arguments !== undefined && { arguments: record.arguments }) }] : []
      })
    : []

/** The profile hooks hooks.json recorded, in run order. Unknown phase names go last. */
export function phasesOf(hooksText: string | undefined): RookPhase[] {
  const phases = asObject(parseJson(hooksText)?.phases)

  if (phases === undefined) {
    return []
  }

  const rank = (name: string) => {
    const at = (PHASE_ORDER as readonly string[]).indexOf(name)

    return at < 0 ? PHASE_ORDER.length : at
  }

  return Object.entries(phases)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([name, raw]) => {
      const phase = asObject(raw) ?? {}
      const calls = callsIn(asObject(phase.data)?.calls)

      return {
        name,
        ran: phase.ran === true,
        ok: phase.ok !== false,
        ...(typeof phase.durationMs === 'number' && { durationMs: phase.durationMs }),
        ...(typeof phase.error === 'string' && { error: phase.error }),
        ...(calls.length > 0 && { calls }),
      }
    })
}

/** Quotes the judge used as evidence, without the quote marks rook wraps them in. */
const quotesOf = (criteria: readonly RookCriterion[]): string[] =>
  criteria
    .filter(c => c.status !== 'Pass')
    .flatMap(c => c.evidence.split(/"\s*[,;]\s*"|\n/))
    .map(q => q.trim().replace(/^["'“]+|["'”.]+$/g, '').trim())
    .filter(q => q.length >= 12)

/** The conversation from response.json, each agent turn the judge quoted marked `isCited`. */
export function transcriptOf(response: Json | undefined, criteria: readonly RookCriterion[]): RookTurn[] {
  const quotes = quotesOf(criteria)
  const turns = Array.isArray(response?.transcript) ? response.transcript : []

  return turns.flatMap(turn => {
    const record = asObject(turn)
    const content = typeof record?.content === 'string' ? record.content : undefined

    if (content === undefined) {
      return []
    }

    const role = typeof record?.role === 'string' ? record.role : 'agent'
    const isCited = role !== 'user' && quotes.some(q => content.includes(q) || (content.length >= 12 && q.includes(content.trim())))

    return [{ role, content, ...(isCited && { isCited: true }) }]
  })
}

/** One scenario's full record in one run: undefined when it has no verdict yet. */
export async function readEvidence(io: Io, agentDir: string, runId: string, id: string): Promise<RookEvidence | undefined> {
  const dir = `${agentDir}/runs/${runId}/scenarios/${id}`
  const verdictText = await io.read(`${dir}/verdict.yaml`)

  if (verdictText === undefined) {
    return undefined
  }

  const verdict = parseMap(verdictText)
  const status = statusOf(str(verdict.status))

  if (status === undefined) {
    return undefined
  }

  const [snapshotText, hooksText, responseText, requestText] = await Promise.all([
    io.read(`${dir}/snapshot.yaml`),
    io.read(`${dir}/hooks.json`),
    io.read(`${dir}/response.json`),
    io.read(`${dir}/request.json`),
  ])
  const snapshot = parseMap(snapshotText ?? '')
  const response = parseJson(responseText)
  const criteria = criteriaOf(verdictText)
  const phases = phasesOf(hooksText)
  const raw = parseJson(typeof response?.raw_response === 'string' ? response.raw_response : undefined)
  const hookCalls = phases.flatMap(p => p.calls ?? [])
  const toolCalls = hookCalls.length > 0 ? hookCalls : callsIn(raw?.calls)
  const usage = isMap(verdict.usage) ? verdict.usage : undefined
  const goal = str(snapshot.goal)
  const why = str(snapshot.why)
  const featureId = str(snapshot.feature_id)
  const output = typeof response?.output === 'string' ? response.output : undefined
  const compliance = num(verdict.compliance_percentage)
  const latencyMs = num(verdict.latency_ms)
  const turns = num(verdict.turns)

  return {
    id,
    runId,
    title: str(snapshot.title) ?? '',
    status,
    ...(goal !== undefined && { goal: goal.trim() }),
    ...(why !== undefined && { why: why.trim() }),
    ...(featureId !== undefined && { featureId }),
    criteria,
    phases,
    transcript: transcriptOf(response, criteria),
    ...(output !== undefined && { output }),
    toolCalls,
    summary: (str(verdict.summary) ?? '').trim(),
    gaps: strings(verdict.verification_gaps),
    ...(compliance !== undefined && { compliance }),
    forbiddenHits: list(verdict.forbidden_hits).flatMap(hit => (typeof hit === 'string' ? [hit] : isMap(hit) && str(hit.pattern) !== undefined ? [str(hit.pattern)!] : [])),
    ...(latencyMs !== undefined && { latencyMs }),
    ...(turns !== undefined && { turns }),
    ...(usage !== undefined && { tokens: { input: num(usage.input_tokens) ?? 0, output: num(usage.output_tokens) ?? 0 } }),
    paths: {
      verdict: `${dir}/verdict.yaml`,
      ...(responseText !== undefined && { response: `${dir}/response.json` }),
      ...(hooksText !== undefined && { hooks: `${dir}/hooks.json` }),
      ...(requestText !== undefined && { request: `${dir}/request.json` }),
    },
  }
}

/** How many runs back the history and the heat grid look. */
export const VERDICT_RUNS = 8

/** A verdict's status line, read without parsing the whole file. */
const statusLine = (text: string): RookStatus | undefined => statusOf(/^status:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text)?.[1])

/**
 * Each scenario's verdicts in the newest `limit` runs that judged anything
 * (`ids` newest first), oldest first per scenario. Skipped scenarios have no
 * entry for that run.
 */
export async function verdictHistory(
  io: Io,
  agentDir: string,
  ids: readonly string[],
  limit = VERDICT_RUNS,
  /** Statuses by verdict path: rook writes a verdict once, so a file read is never read again. */
  cache?: Map<string, RookStatus>,
): Promise<RookVerdictHistory[]> {
  const byId = new Map<string, { runId: string; status: RookStatus }[]>()
  let used = 0

  for (const runId of ids) {
    if (used >= limit) {
      break
    }

    const dir = `${agentDir}/runs/${runId}/scenarios`
    const scenarios = (await io.list(dir).catch(() => [])).filter(entry => entry.kind === 'dir' && SCENARIO_ID.test(entry.name))
    let judged = 0

    for (const { name } of scenarios) {
      const path = `${dir}/${name}/verdict.yaml`
      let status = cache?.get(path)

      if (status === undefined) {
        const text = await io.read(path)

        status = text === undefined ? undefined : statusLine(text)

        if (status !== undefined) {
          cache?.set(path, status)
        }
      }

      if (status !== undefined) {
        judged++
        byId.set(name, [...(byId.get(name) ?? []), { runId, status }])
      }
    }

    if (judged > 0) {
      used++
    }
  }

  return [...byId]
    .map(([id, runs]) => ({ id, runs: [...runs].sort((a, b) => compareRunIds(a.runId, b.runId)) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** The run ids the history covers, oldest first: the heat grid's columns. */
export const historyRuns = (history: readonly RookVerdictHistory[]): string[] =>
  [...new Set(history.flatMap(h => h.runs.map(r => r.runId)))].sort(compareRunIds)
