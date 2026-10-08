import type { RookBudget, RookCurrent, RookJob, RookLens, RookRunning, RookRunView, RookScenarioRow, RookSnapshot, RookStale, RookStatus, RookVerdictHistory } from '../types'
import { changedSince, lastPassRun, runStartMs, verdictsBefore } from './changes'
import { creditsPerScenario, joinParts, elapsed } from './format'
import type { StatusPart } from './format'
import { doingText, etaShort, isOwnRun, JUST_FINISHED_MS, sourceText } from './live'
import type { LiveState } from './live'
import { isTrustedPass, ownerOf } from './owner'
import { setupLine } from './readiness'
import type { Io } from './workspace'
import { changesIn, countsOf } from './workspace'
import { isMap, num, parseMap } from './yaml'

/**
 * The status line beyond the score: a trend of recent pass rates, an ETA while
 * a run is in flight, and markers for an untested edit, low credits, the
 * session budget and a generate or explore in flight. Pure: register.tsx reads
 * the atoms and the disk, this decides what fits.
 */

/** One finished run, as the trend and the ETA need it. */
export type TrendPoint = { runId: string; passRate?: number; executed: number; credits?: number; durationMs?: number }

/** How many finished runs the trend shows. */
export const TREND_RUNS = 8

/** The longest the line gets before parts are shortened, then dropped. Claude Code prefixes `rook `. */
export const STATUS_MAX = 72

const BARS = '▁▂▃▄▅▆▇█'

/**
 * The newest finished, non-test runs among `ids` (newest first), returned
 * oldest first, at most `limit`: read from report.yaml (and run.yaml's test flag).
 */
export async function trendOf(io: Io, agentDir: string, ids: readonly string[], limit = TREND_RUNS): Promise<TrendPoint[]> {
  const points: TrendPoint[] = []

  for (const runId of ids.slice(0, limit * 3)) {
    if (points.length >= limit) {
      break
    }

    const runDir = `${agentDir}/runs/${runId}`
    const reportText = await io.read(`${runDir}/report.yaml`)

    if (reportText === undefined) {
      continue
    }

    const runText = await io.read(`${runDir}/run.yaml`)

    if (runText !== undefined && parseMap(runText).test_mode === true) {
      continue
    }

    const report = parseMap(reportText)
    const totals = isMap(report.totals) ? report.totals : {}
    const metrics = isMap(report.metrics) ? report.metrics : {}
    const passRate = num(totals.pass_rate)
    const credits = num(metrics.credits)
    const durationMs = num(metrics.duration_ms)

    points.push({
      runId,
      ...(passRate !== undefined && { passRate }),
      executed: num(totals.executed) ?? num(totals.planned) ?? 0,
      ...(credits !== undefined && { credits }),
      ...(durationMs !== undefined && { durationMs }),
    })
  }

  return points.reverse()
}

/** `▁▅█`: one bar per pass rate (0–1, or a percentage), on a fixed 0–100% scale. */
export function sparkline(rates: readonly number[]): string {
  return rates
    .map(rate => {
      const share = Math.min(1, Math.max(0, rate > 1 ? rate / 100 : rate))

      return BARS[Math.round(share * (BARS.length - 1))]
    })
    .join('')
}

/** The trend beside the score: only with three or more runs that decided something. */
export function trendText(points: readonly TrendPoint[]): string | undefined {
  const rates = points.flatMap(point => (point.passRate === undefined ? [] : [point.passRate])).slice(-TREND_RUNS)

  return rates.length >= 3 ? sparkline(rates) : undefined
}

/** Milliseconds per scenario in recent finished runs: the median, so one slow run does not skew it. */
export function msPerScenario(points: readonly TrendPoint[]): number | undefined {
  const paces = points
    .slice(-5)
    .flatMap(point => (point.durationMs !== undefined && point.executed > 0 ? [point.durationMs / point.executed] : []))
    .sort((a, b) => a - b)

  if (paces.length === 0) {
    return undefined
  }

  const mid = Math.floor(paces.length / 2)

  return paces.length % 2 === 1 ? paces[mid]! : (paces[mid - 1]! + paces[mid]!) / 2
}

/**
 * How long the run in flight has left: at its own pace once two scenarios
 * are judged, otherwise at recent runs' pace per scenario.
 */
export function etaMs(run: RookRunView, running: RookRunning | null, now: number, points: readonly TrendPoint[]): number | undefined {
  const remaining = run.planned - run.done

  if (run.finished || remaining <= 0) {
    return undefined
  }

  if (run.done >= 2) {
    const started = running?.startedAt ?? (run.created === undefined ? Number.NaN : Date.parse(run.created))

    if (Number.isFinite(started) && now > started) {
      return ((now - started) / run.done) * remaining
    }
  }

  const pace = msPerScenario(points)

  return pace === undefined ? undefined : pace * remaining
}

/** `<1m left`, `~4m left`, `~1h20m left`. */
export function etaText(ms: number): string {
  if (ms < 60_000) {
    return '<1m left'
  }

  const minutes = Math.round(ms / 60_000)

  return minutes < 60 ? `~${minutes}m left` : `~${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m left`
}

const baseName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

/** `⚠ edited tools.mjs +1`, shortened to `⚠ edited`. */
export function editedPart(stale: RookStale): StatusPart {
  const first = stale.files[0]
  const more = stale.files.length > 1 ? ` +${stale.files.length - 1}` : ''

  return first === undefined ? { text: '⚠ edited', rank: 2 } : { text: `⚠ edited ${baseName(first)}${more}`, short: '⚠ edited', rank: 2 }
}

/** The balance will not cover one full run of every scenario at the latest rate. */
export function isLowCredits(balance: number | null, snapshot: RookSnapshot | null, points: readonly TrendPoint[]): boolean {
  if (balance === null || snapshot === null) {
    return false
  }

  const newest = [...points].reverse().find(point => point.credits !== undefined && point.executed > 0)
  const rate = creditsPerScenario(snapshot.latest) ?? (newest === undefined ? undefined : newest.credits! / newest.executed)
  const count = snapshot.current.length + snapshot.neverRun

  return rate !== undefined && count > 0 && balance < rate * count
}

/** `120/500 cr`. */
export const budgetText = (budget: RookBudget): string => `${Math.round(budget.spent)}/${Math.round(budget.limit)} cr`

/** `▸ generate · 3/7 · 2m10s`. */
export function jobText(job: RookJob, now: number): string {
  const count = job.planned !== undefined && job.planned > 0 ? ` · ${job.done ?? 0}/${job.planned}` : ''

  return `▸ ${job.kind}${count} · ${elapsed(Math.max(0, now - job.startedAt))}`
}

/**
 * Fits parts into `max`: first the highest ranks take their short form, then
 * they are dropped, until the line fits or only rank 0 is left; a long form
 * comes back when a drop left room for it.
 */
export function fitParts(parts: readonly StatusPart[], max = STATUS_MAX): string {
  let kept = [...parts]
  const order = [...new Set(kept.map(part => part.rank))].filter(rank => rank > 0).sort((a, b) => b - a)

  for (const rank of order) {
    if (joinParts(kept).length <= max) {
      break
    }

    kept = kept.map(part => (part.rank === rank && part.short !== undefined ? { ...part, text: part.short, short: undefined } : part))
  }

  for (const rank of order) {
    if (joinParts(kept).length <= max) {
      break
    }

    kept = kept.filter(part => part.rank !== rank)
  }

  // A drop may have made room for a long form again, most important first.
  for (const original of [...parts].filter(part => part.short !== undefined).sort((a, b) => a.rank - b.rank)) {
    const i = kept.findIndex(part => part.rank === original.rank && part.text === original.short)
    const restored = kept.map((part, j) => (j === i ? original : part))

    if (i >= 0 && joinParts(restored).length <= max) {
      kept = restored
    }
  }

  return joinParts(kept)
}

export type StatusInput = {
  snapshot: RookSnapshot | null
  running: RookRunning | null
  stale: RookStale | null
  balance: number | null
  budget: RookBudget | null
  job: RookJob | null
  /** Recent finished runs, oldest first (trendOf). */
  trend: readonly TrendPoint[]
  /** The setup checklist's next step, when the workspace cannot run yet. */
  setup?: string
  now: number
  max?: number
  /** Who is looking: the idle line leads with release readiness (qe) or the effect of a change (dev). */
  lens?: RookLens
  /** The run in flight and the one that just landed (hooks/live.ts). */
  live?: LiveState | null
  /** Each scenario's newest verdicts across runs, oldest first per scenario. */
  verdicts?: readonly RookVerdictHistory[]
  /** A scenario's row as judged in a run, when it has been read. */
  rowAt?: (runId: string, id: string) => RookScenarioRow | undefined
  /** The tracked sources' modification times as of the last poll. */
  stamps?: ReadonlyMap<string, number>
}

/** Marker ranks: the right end of the line, so the first to go when it is too long. */
const EDITED_RANK = 9
const LOW_CREDITS_RANK = 10
const BUDGET_RANK = 11

/** `✓7 ✗3 ?2` over every scenario's latest verdict. */
export function scoreText(current: readonly { status: RookStatus }[]): string {
  const { pass, fail, unverifiable } = countsOf(current)

  return `✓${pass} ✗${fail} ?${unverifiable}`
}

/** `SC-001,SC-002 +3`. */
export function idsText(ids: readonly string[], shown = 2): string {
  return `${ids.slice(0, shown).join(',')}${ids.length > shown ? ` +${ids.length - shown}` : ''}`
}

/** `<1m ago`, `3m ago`, `1h05m ago`. */
export function agoText(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  return minutes < 1 ? '<1m ago' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m ago`
}

/** Scenarios whose verdict changed at least `minFlips` times across recent runs. */
export function flakyIds(verdicts: readonly RookVerdictHistory[], minFlips = 2): string[] {
  return verdicts.filter(h => h.runs.filter((r, i) => i > 0 && r.status !== h.runs[i - 1]!.status).length >= minFlips).map(h => h.id)
}

/** The newest run in which every scenario it judged passed. */
export function greenRun(verdicts: readonly RookVerdictHistory[]): string | undefined {
  const byRun = new Map<string, boolean>()

  for (const h of verdicts) {
    for (const r of h.runs) {
      byRun.set(r.runId, (byRun.get(r.runId) ?? true) && r.status === 'Pass')
    }
  }

  return [...byRun]
    .filter(([, isGreen]) => isGreen)
    .map(([runId]) => runId)
    .sort()
    .at(-1)
}

/** Current non-Pass scenarios that passed in an earlier run. */
export function regressedSinceGreen(current: readonly RookCurrent[], verdicts: readonly RookVerdictHistory[]): string[] {
  return current.filter(c => c.status !== 'Pass' && lastPassRun(verdicts, c.id) !== undefined).map(c => c.id)
}

/** The run's tokens against the same scenarios' previous verdicts, in percent; undefined when no scenario has both. */
export function tokenDelta(
  run: RookRunView,
  verdicts: readonly RookVerdictHistory[],
  rowAt: (runId: string, id: string) => RookScenarioRow | undefined,
): number | undefined {
  let now = 0
  let before = 0

  for (const row of run.rows) {
    const runs = verdicts.find(h => h.id === row.id)?.runs ?? []
    const at = runs.findIndex(r => r.runId === run.runId)
    const prev = (at < 0 ? runs.filter(r => r.runId < run.runId) : runs.slice(0, at)).at(-1)
    const old = prev === undefined ? undefined : rowAt(prev.runId, row.id)

    if (row.tokens !== undefined && old?.tokens !== undefined) {
      now += row.tokens.input + row.tokens.output
      before += old.tokens.input + old.tokens.output
    }
  }

  return before === 0 ? undefined : Math.round(((now - before) / before) * 100)
}

/** A repository with no workspace: `not set up · next: select a project · found agent, requirements`. */
function freshParts(snapshot: RookSnapshot | null): StatusPart[] {
  const readiness = snapshot?.readiness
  const found = snapshot?.repoFound ?? []

  if (readiness === undefined || readiness.hasWorkspace || found.length === 0) {
    return []
  }

  const next = setupLine({ ...readiness, hasWorkspace: true })?.replace(/^setup: /, '')
  const kinds = [...new Set(found.map(f => f.kind))]

  return [
    { text: 'not set up', rank: 0 },
    ...(next === undefined ? [] : [{ text: `next: ${next}`, rank: 3 }]),
    { text: `found ${kinds.join(', ')}`, rank: 4 },
  ]
}

function runningParts(input: StatusInput): StatusPart[] {
  const { snapshot, running, live, now, trend } = input
  const run = snapshot?.latest
  const source = { text: sourceText(running, run !== undefined && isOwnRun(live ?? null, run.runId)), rank: 6, glue: ' ' }

  if (run === undefined || run.finished) {
    return [{ text: '◐', rank: 0 }, source, { text: 'starting', rank: 0, glue: ' ' }]
  }

  const doing = doingText(run, now)
  const eta = etaMs(run, running, now, trend)

  return [
    { text: '◐', rank: 0 },
    source,
    { text: `${run.done}/${run.planned}`, rank: 0, glue: ' ' },
    ...(run.counts.fail > 0 ? [{ text: `✗${run.counts.fail}`, rank: 0, glue: ' ' }] : []),
    ...(doing === undefined ? [] : [{ text: doing, rank: 4 }]),
    ...(eta === undefined ? [] : [{ text: etaShort(eta), rank: 5 }]),
  ]
}

function neverRunParts(snapshot: RookSnapshot, setup: string | undefined, trend: readonly TrendPoint[]): StatusPart[] {
  const count = snapshot.neverRun + snapshot.current.length
  const newest = [...trend].reverse().find(point => point.credits !== undefined && point.executed > 0)
  const cost = newest === undefined || count === 0 ? '' : ` ~${Math.round((newest.credits! / newest.executed) * count)}cr`
  const next = setup !== undefined && setup !== '' ? setup.replace(/^setup: /, '') : `first run${cost}`

  return [
    { text: `${count} scenario${count === 1 ? '' : 's'}`, rank: 0 },
    { text: 'never run', rank: 0 },
    { text: `next: ${next}`, rank: 3 },
  ]
}

function finishedParts(snapshot: RookSnapshot, run: RookRunView, landedAt: number, now: number): StatusPart[] {
  const { pass, fail, unverifiable } = run.counts
  const { fixed, regressed } = changesIn(snapshot.current, run.runId)
  const fresh = new Set(regressed.map(row => row.id))
  const still = run.rows.filter(row => row.status === 'Fail' && !fresh.has(row.id)).map(row => row.id)

  return [
    { text: `${fail > 0 ? '✗' : '✓'} ${pass}/${pass + fail + unverifiable}`, rank: 0 },
    { text: agoText(Math.max(0, now - landedAt)), rank: 0, glue: ' ' },
    ...(fixed.length > 0 ? [{ text: `fixed ${idsText(fixed.map(row => row.id))}`, rank: 5 }] : []),
    ...(still.length > 0 ? [{ text: `✗ ${idsText(still)}`, rank: 4 }] : []),
    // The newest failures are what the person needs most: kept longest.
    ...(regressed.length > 0 ? [{ text: `new ✗ ${idsText([...fresh])}`, rank: 3 }] : []),
  ]
}

function qeParts(input: StatusInput, snapshot: RookSnapshot): StatusPart[] {
  const { current } = snapshot
  const verdicts = input.verdicts ?? []
  const { pass, fail, unverifiable } = countsOf(current)
  const total = pass + fail + unverifiable
  const pct = total === 0 ? undefined : Math.round((pass / total) * 100)
  const rowAt = input.rowAt
  const trustedCount =
    rowAt === undefined
      ? undefined
      : current.filter(c => {
          const row = c.status === 'Pass' ? rowAt(c.runId, c.id) : undefined

          return c.status === 'Pass' && (row === undefined || isTrustedPass(row))
        }).length
  const trusted = trustedCount === undefined || total === 0 ? undefined : Math.round((trustedCount / total) * 100)
  const blockers =
    rowAt === undefined
      ? 0
      : current.filter(c => {
          const row = c.status === 'Pass' ? undefined : rowAt(c.runId, c.id)

          return row !== undefined && ownerOf({ row, before: verdictsBefore(verdicts, c.id, c.runId) }).owner === 'agent'
        }).length
  const flaky = flakyIds(verdicts).length
  const trend = trendText(input.trend)

  return [
    { text: scoreText(current), rank: 0 },
    ...(pct === undefined ? [] : [{ text: `${pct}%`, rank: 3, glue: ' ' }]),
    ...(trusted === undefined || trusted === pct ? [] : [{ text: `(${trusted}% trusted)`, rank: 4, glue: ' ' }]),
    ...(trend === undefined ? [] : [{ text: trend, rank: 5, glue: ' ' }]),
    ...(blockers > 0 ? [{ text: `${blockers} blocker${blockers === 1 ? '' : 's'}`, rank: 6 }] : []),
    ...(flaky > 0 ? [{ text: `${flaky} flaky`, rank: 7 }] : []),
  ]
}

function devParts(input: StatusInput, snapshot: RookSnapshot): StatusPart[] {
  const verdicts = input.verdicts ?? []
  const regressed = regressedSinceGreen(snapshot.current, verdicts).length
  const green = greenRun(verdicts)
  const changed = green === undefined || input.stamps === undefined ? undefined : changedSince(input.stamps, runStartMs(green)).length
  const stale = input.stale?.scenarios.length ?? 0
  const run = snapshot.latest
  const tokens = run === undefined || input.rowAt === undefined ? undefined : tokenDelta(run, verdicts, input.rowAt)

  return [
    { text: scoreText(snapshot.current), rank: 0 },
    ...(regressed > 0 ? [{ text: `${regressed} regressed since green`, short: `${regressed} regressed`, rank: 3 }] : []),
    ...(changed !== undefined && changed > 0 ? [{ text: `Δ${changed} file${changed === 1 ? '' : 's'}`, rank: 4 }] : []),
    ...(stale > 0 ? [{ text: `${stale} stale`, rank: 5 }] : []),
    ...(tokens === undefined ? [] : [{ text: `tokens ${tokens > 0 ? '+' : tokens < 0 ? '−' : '±'}${Math.abs(tokens)}%`, rank: 6 }]),
  ]
}

export type StatusState = 'none' | 'fresh' | 'setup' | 'running' | 'never' | 'finished' | 'idle-qe' | 'idle-dev'

/**
 * The line's main parts by state, in priority: a run in flight, a workspace
 * never run, a setup blocker, a run that landed in the last ten minutes, and
 * otherwise the idle line for the lens.
 */
export function stateParts(input: StatusInput): { parts: StatusPart[]; state: StatusState } {
  const { snapshot, running, setup, now, live } = input
  const run = snapshot?.latest
  const hasSetup = setup !== undefined && setup !== ''

  if (running !== null || (run !== undefined && !run.finished)) {
    return { parts: runningParts(input), state: 'running' }
  }

  if (snapshot === null || snapshot.agentId === undefined) {
    const fresh = freshParts(snapshot)

    if (fresh.length > 0) {
      return { parts: fresh, state: 'fresh' }
    }

    return hasSetup ? { parts: [{ text: setup, rank: 0 }], state: 'setup' } : { parts: [], state: 'none' }
  }

  if (run === undefined) {
    return { parts: neverRunParts(snapshot, setup, input.trend), state: 'never' }
  }

  if (hasSetup) {
    return { parts: [{ text: scoreText(snapshot.current), rank: 0 }, { text: setup, rank: 0 }], state: 'setup' }
  }

  const landed = live?.landed

  if (run.stopped !== true && landed !== undefined && landed.runId === run.runId && now >= landed.at && now - landed.at <= JUST_FINISHED_MS) {
    return { parts: finishedParts(snapshot, run, landed.at, now), state: 'finished' }
  }

  return input.lens === 'dev' ? { parts: devParts(input, snapshot), state: 'idle-dev' } : { parts: qeParts(input, snapshot), state: 'idle-qe' }
}

/** The whole status line, or undefined to clear it. */
export function composeStatus(input: StatusInput): string | undefined {
  const { snapshot, stale, balance, budget, job, trend, now } = input
  const { parts: main, state } = stateParts(input)
  const hasAgent = snapshot !== null && snapshot.agentId !== undefined
  // Markers ride on an agent's line: outside one, only a job or the setup step shows.
  const markers: StatusPart[] =
    !hasAgent || main.length === 0
      ? []
      : [
          ...(stale !== null && state !== 'idle-dev' ? [{ ...editedPart(stale), rank: EDITED_RANK }] : []),
          ...(isLowCredits(balance, snapshot, trend) ? [{ text: 'low credits', rank: LOW_CREDITS_RANK }] : []),
          ...(budget !== null ? [{ text: budgetText(budget), rank: BUDGET_RANK }] : []),
        ]
  const parts: StatusPart[] = [...(job !== null ? [{ text: jobText(job, now), rank: 1 }] : []), ...main, ...markers]

  return parts.length === 0 ? undefined : fitParts(parts, input.max)
}

