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
