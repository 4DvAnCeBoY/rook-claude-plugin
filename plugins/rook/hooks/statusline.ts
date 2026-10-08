import type { RookBudget, RookJob, RookRunning, RookRunView, RookSnapshot, RookStale } from '../types'
import { creditsPerScenario, duration, joinParts, statusParts, elapsed } from './format'
import type { StatusPart } from './format'
import type { Io } from './workspace'
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
}

/** The whole status line, or undefined to clear it. */
export function composeStatus(input: StatusInput): string | undefined {
  const { snapshot, running, stale, balance, budget, job, trend, setup, now } = input
  const run = snapshot?.latest
  const eta = run === undefined ? undefined : etaMs(run, running, now, trend)
  const score = statusParts(snapshot, running !== null, {
    ...(eta !== undefined && { eta: etaText(eta) }),
    ...(trendText(trend) !== undefined && { trend: trendText(trend)! }),
  })
  // Markers ride on a score: outside a workspace, only a job or the setup step shows.
  const markers: StatusPart[] =
    score.length === 0
      ? []
      : [
          ...(stale !== null ? [editedPart(stale)] : []),
          ...(isLowCredits(balance, snapshot, trend) ? [{ text: 'low credits', rank: 3 }] : []),
          ...(budget !== null ? [{ text: budgetText(budget), rank: 7 }] : []),
        ]
  const parts: StatusPart[] = [
    ...(job !== null ? [{ text: jobText(job, now), rank: 1 }] : []),
    ...score,
    ...markers,
    ...(setup !== undefined && setup !== '' ? [{ text: setup, rank: 0 }] : []),
  ]

  return parts.length === 0 ? undefined : fitParts(parts, input.max)
}
