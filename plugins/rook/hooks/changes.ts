import type { RookStatus, RookVerdictHistory } from '../types'

/**
 * What changed in the agent's tracked sources since a scenario last passed:
 * the line that links a regression to the edit behind it. Pure: the
 * modification times come from the poll's source stamps (hooks/sources.ts).
 */

/** When a run started, ms since epoch, from its id (`2026-09-28T15-41-26Z`, `-2` for a second in the same second). */
export function runStartMs(runId: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(runId)
  const ms = m === null ? NaN : Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`)

  return Number.isNaN(ms) ? undefined : ms
}

/** The newest run in which the scenario passed, from its verdict history. */
export function lastPassRun(history: readonly RookVerdictHistory[], id: string): string | undefined {
  return history.find(h => h.id === id)?.runs.filter(r => r.status === 'Pass').at(-1)?.runId
}

/** The scenario's verdicts before `runId`, oldest first: what owner rules call `before`. */
export function verdictsBefore(history: readonly RookVerdictHistory[], id: string, runId: string): RookStatus[] {
  const runs = history.find(h => h.id === id)?.runs ?? []
  const at = runs.findIndex(r => r.runId === runId)

  return (at < 0 ? runs : runs.slice(0, at)).map(r => r.status)
}

/**
 * The newest run in which every scenario it judged passed and that judged as
 * many scenarios as the widest run in the window: a `--only SC-001` pass is
 * not a green run for the whole agent. The baseline the status line and the
 * My change view both measure from.
 */
export function lastFullGreenRun(history: readonly RookVerdictHistory[]): string | undefined {
  const byRun = new Map<string, RookStatus[]>()

  for (const h of history) {
    for (const r of h.runs) {
      byRun.set(r.runId, [...(byRun.get(r.runId) ?? []), r.status])
    }
  }

  const widest = Math.max(0, ...[...byRun.values()].map(s => s.length))

  return [...byRun]
    .filter(([, statuses]) => statuses.length === widest && statuses.every(s => s === 'Pass'))
    .map(([runId]) => runId)
    .sort((a, b) => (runStartMs(a) ?? 0) - (runStartMs(b) ?? 0) || a.localeCompare(b))
    .at(-1)
}

/** Tracked files modified after `sinceMs`, newest first. */
export function changedSince(stamps: ReadonlyMap<string, number> | undefined, sinceMs: number | undefined): { path: string; mtimeMs: number }[] {
  if (stamps === undefined || sinceMs === undefined) {
    return []
  }

  return [...stamps]
    .filter(([, mtime]) => mtime > sinceMs)
    .sort((a, b) => b[1] - a[1])
    .map(([path, mtimeMs]) => ({ path, mtimeMs }))
}
