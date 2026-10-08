import type { RookRunSummary, RookScenarioRow, RookStatus, RookVerdictHistory } from '../types'
import { historyRuns, VERDICT_RUNS } from './evidence'
import { isFlaky, trustedRate } from './owner'
import { readRun, RUN_ID, SCENARIO_ID } from './workspace'
import type { Io, RowCache } from './workspace'
import { isMap, num, parseMap } from './yaml'

/**
 * The Trends tab's pure half: each scenario across recent runs (flaky,
 * regressed, never passed, fixed) and each run's pass rate and tokens.
 * Reads files through an `Io` only; never the engine.
 */

/** How many finished runs the pass-rate and token lines cover. */
export const TREND_RUNS = 8

/** What a scenario's recent verdicts say about it; undefined when nothing stands out. */
export type ScenarioTrend = 'flaky' | 'regressed' | 'never passed' | 'fixed'

/** A heat-grid cell: Pass, Fail, Unable to Verify, or not in that run. */
export type HeatCell = 'P' | 'F' | 'U' | ''

export type HeatRow = { id: string; cells: HeatCell[]; trend?: ScenarioTrend }

/** The heat grid: columns are run ids oldest first, rows scenarios by id. Plain data: a `Client`'s props. */
export type HeatGrid = { runIds: string[]; rows: HeatRow[] }

const CELL: Record<RookStatus, HeatCell> = { Pass: 'P', Fail: 'F', 'Unable to Verify': 'U' }

export const CELL_STATUS: Record<Exclude<HeatCell, ''>, RookStatus> = { P: 'Pass', F: 'Fail', U: 'Unable to Verify' }

export const CELL_GLYPH: Record<HeatCell, string> = { P: '✓', F: '✗', U: '?', '': ' ' }

export const CELL_COLOR: Record<HeatCell, string | undefined> = { P: 'green', F: 'red', U: 'yellow', '': undefined }

export const TREND_COLOR: Record<ScenarioTrend, string> = { flaky: 'yellow', regressed: 'red', 'never passed': 'red', fixed: 'green' }

/**
 * A scenario's verdicts, oldest first, read as one word. Unable to Verify says
 * nothing about the agent, so flips, regressions and fixes count over Pass and
 * Fail only. Flaky wins over the rest: a flip-flopping scenario's latest
 * change is not news.
 *
 *  - flaky: Pass and Fail swap places twice or more in the last 8
 *  - regressed: the latest Fail came straight after a Pass
 *  - fixed: the latest Pass came straight after a Fail
 *  - never passed: not one Pass in the window
 */
export function trendOf(statuses: readonly RookStatus[]): ScenarioTrend | undefined {
  const recent = statuses.slice(-VERDICT_RUNS)
  const decided = recent.filter(s => s !== 'Unable to Verify')
  if (isFlaky(recent)) {
    return 'flaky'
  }

  const last = decided.at(-1)
  const before = decided.at(-2)

  if (last === 'Fail' && before === 'Pass') {
    return 'regressed'
  }

  if (last === 'Pass' && before === 'Fail') {
    return 'fixed'
  }

  if (recent.length > 0 && !recent.includes('Pass')) {
    return 'never passed'
  }

  return undefined
}

/** The verdict history as a grid: one column per run the history covers, a blank cell where a scenario was not in that run. */
export function heatGrid(history: readonly RookVerdictHistory[]): HeatGrid {
  const runIds = historyRuns(history)

  return {
    runIds,
    rows: history.map(h => {
      const byRun = new Map(h.runs.map(r => [r.runId, r.status]))
      const trend = trendOf(h.runs.map(r => r.status))

      return {
        id: h.id,
        cells: runIds.map(runId => {
          const status = byRun.get(runId)

          return status === undefined ? '' : CELL[status]
        }),
        ...(trend !== undefined && { trend }),
      }
    }),
  }
}

/** One cell as the line under the grid reads it: `SC-004 · run <id> · Fail`. */
export function cellLine(grid: HeatGrid, row: number, column: number): string | undefined {
  const r = grid.rows[row]
  const runId = grid.runIds[column]
  const cell = r?.cells[column]

  if (r === undefined || runId === undefined || cell === undefined) {
    return undefined
  }

  return `${r.id} · run ${runId} · ${cell === '' ? 'not in this run' : CELL_STATUS[cell]}`
}

/** How many scenarios each trend names, for the line over the grid. */
export function trendCounts(grid: HeatGrid): Record<ScenarioTrend, number> {
  const counts: Record<ScenarioTrend, number> = { flaky: 0, regressed: 0, 'never passed': 0, fixed: 0 }

  for (const row of grid.rows) {
    if (row.trend !== undefined) {
      counts[row.trend] += 1
    }
  }

  return counts
}

/** One finished run's line in the trends: its pass rate, trusted pass rate and tokens. */
export type TrendRun = { runId: string; passRate?: number; trusted?: number; tokens?: number }

/** Tokens a run spent: report.yaml `metrics.tokens_in` + `tokens_out`, else the verdicts' usage summed. */
export function runTokens(reportText: string | undefined, rows: readonly RookScenarioRow[]): number | undefined {
  const metrics = reportText === undefined ? undefined : parseMap(reportText).metrics
  const tokensIn = isMap(metrics) ? num(metrics.tokens_in) : undefined
  const tokensOut = isMap(metrics) ? num(metrics.tokens_out) : undefined

  if (tokensIn !== undefined || tokensOut !== undefined) {
    return (tokensIn ?? 0) + (tokensOut ?? 0)
  }

  const used = rows.filter(row => row.tokens !== undefined)

  return used.length === 0 ? undefined : used.reduce((sum, row) => sum + row.tokens!.input + row.tokens!.output, 0)
}

/**
 * The newest `TREND_RUNS` finished runs, oldest first, each with its pass
 * rate, trusted pass rate and tokens. A finished run never changes, so each
 * is read once into `cache` (keyed by agent directory and run id).
 */
export async function trendRuns(io: Io, agentDir: string, history: readonly RookRunSummary[], rows: RowCache, cache: Map<string, TrendRun>): Promise<TrendRun[]> {
  const out: TrendRun[] = []

  for (const summary of history.slice(0, TREND_RUNS)) {
    const key = `${agentDir}#${summary.runId}`
    let trend = cache.get(key)

    if (trend === undefined) {
      const run = await readRun(io, agentDir, summary.runId, rows).catch(() => undefined)
      const reportText = await io.read(`${agentDir}/runs/${summary.runId}/report.yaml`).catch(() => undefined)
      const trusted = run === undefined ? undefined : trustedRate(run.rows)
      const tokens = runTokens(reportText, run?.rows ?? [])

      trend = {
        runId: summary.runId,
        ...(summary.passRate !== undefined && { passRate: summary.passRate }),
        ...(trusted !== undefined && { trusted }),
        ...(tokens !== undefined && { tokens }),
      }
      cache.set(key, trend)
    }

    out.push(trend)
  }

  return out.reverse()
}

const BARS = '▁▂▃▄▅▆▇█'

/** Values 0–1 as one bar each; `·` where a run has none. */
export function sparkline(values: readonly (number | undefined)[]): string {
  return values.map(v => (v === undefined ? '·' : BARS[Math.min(BARS.length - 1, Math.max(0, Math.round(v * (BARS.length - 1))))])).join('')
}

/** Values of any size as bars scaled to the largest. */
export function scaledSparkline(values: readonly (number | undefined)[]): string {
  const max = Math.max(0, ...values.filter((v): v is number => v !== undefined))

  return sparkline(values.map(v => (v === undefined ? undefined : max === 0 ? 0 : v / max)))
}

/** `1.2k`, `340`, `2.1M`. */
export function tokenCount(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(Math.round(n))
}

/**
 * "latest run is up 12% on the 7 before it": the newest run's tokens against
 * the mean of up to 7 before it. Undefined without the newest or any before.
 */
export function tokenDelta(runs: readonly TrendRun[]): string | undefined {
  const latest = runs.at(-1)?.tokens
  const before = runs
    .slice(0, -1)
    .slice(-7)
    .flatMap(r => (r.tokens === undefined ? [] : [r.tokens]))

  if (latest === undefined || before.length === 0) {
    return undefined
  }

  const mean = before.reduce((a, b) => a + b, 0) / before.length
  const word = before.length === 1 ? 'the run before it' : `the ${before.length} before it`

  if (mean === 0) {
    return latest === 0 ? `latest run is level with ${word}` : undefined
  }

  const change = Math.round(((latest - mean) / mean) * 100)

  return change === 0 ? `latest run is level with ${word}` : `latest run is ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% on ${word}`
}

/** Scenarios that went Pass → not Pass (regressed) and not Pass → Pass (fixed) between two runs' rows. */
export function versusPrevious(
  previous: readonly { id: string; status: RookStatus }[],
  current: readonly { id: string; status: RookStatus }[],
): { regressed: string[]; fixed: string[] } {
  const before = new Map(previous.map(row => [row.id, row.status]))
  const regressed: string[] = []
  const fixed: string[] = []

  for (const row of [...current].sort((a, b) => a.id.localeCompare(b.id))) {
    const was = before.get(row.id)

    if (was === 'Pass' && row.status !== 'Pass') {
      regressed.push(row.id)
    } else if (was !== undefined && was !== 'Pass' && row.status === 'Pass') {
      fixed.push(row.id)
    }
  }

  return { regressed, fixed }
}

/** The finished run listed just before `runId` (history is newest first). */
export const previousRunId = (history: readonly RookRunSummary[] | null, runId: string): string | undefined => {
  const at = history?.findIndex(run => run.runId === runId) ?? -1

  return at < 0 ? undefined : history?.[at + 1]?.runId
}

/** The pane's tab for a digit hotkey a `Client` handed back. */
export const TAB_KEYS: Record<string, 'health' | 'runs' | 'scenarios' | 'setup' | 'trends'> = { '1': 'health', '2': 'runs', '3': 'scenarios', '4': 'setup', '5': 'trends' }

/** What the heat grid posts: a cell picked, or a key it does not use. Anything else is ignored. */
export type HeatMessage = { type: 'pick'; runId: string; id: string } | { type: 'key'; key: string }

/** `ui.message` data is input from code: check its shape before acting on it. */
export function heatMessageOf(data: unknown): HeatMessage | undefined {
  if (typeof data !== 'object' || data === null) {
    return undefined
  }

  const d = data as Record<string, unknown>

  if (d.type === 'pick' && typeof d.runId === 'string' && RUN_ID.test(d.runId) && typeof d.id === 'string' && SCENARIO_ID.test(d.id)) {
    return { type: 'pick', runId: d.runId, id: d.id }
  }

  if (d.type === 'key' && typeof d.key === 'string' && d.key.length === 1) {
    return { type: 'key', key: d.key }
  }

  return undefined
}
