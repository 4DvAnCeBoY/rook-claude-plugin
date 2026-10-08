import type { PluginState } from 'claude-code'

import type { RookCurrent, RookOwner, RookRunning, RookRunView, RookScenarioRow, RookSnapshot, RookStale, RookStatus, RookVerdictHistory } from '../types'
import { runStartMs, verdictsBefore } from './changes'
import { elapsed, isReporting, REPORTING } from './format'
import { OWNER_LABEL, ownerOf } from './owner'
import { changesIn } from './workspace'

/**
 * A run while it is in flight and just after it lands: who started it, the
 * order its verdicts arrived in, when it landed, and the new failures of a run
 * started elsewhere. Pure: register.tsx folds each poll in with `nextLive` and
 * keeps the result in `$.state` (`live`).
 */

export type LiveFailure = { id: string; title: string; status: RookStatus }

/** `$.state` rook.live, as declared in types/index.d.ts (the contract must be self-contained, so it is defined there). */
export type LiveState = NonNullable<PluginState['rook']['live']>

/** How long after `running` clears a landing is still taken as this session's run. */
export const OWN_GRACE_MS = 10_000

/** How long a landed run reads as "just finished" in the status line. */
export const JUST_FINISHED_MS = 10 * 60_000

/** How many just-judged rows the pane lists. */
export const JUDGED_SHOWN = 6

export type LiveInput = {
  agentId?: string
  latest?: RookRunView
  current: readonly RookCurrent[]
  running: RookRunning | null
  /** False on the session's first poll: what is on disk then is not news. */
  isPrimed: boolean
  now: number
}

const byIdDesc = (a: string, b: string) => b.localeCompare(a)

/** The live state after one poll. Returns `prev` itself when nothing changed. */
export function nextLive(prev: LiveState | null, input: LiveInput): LiveState {
  const { latest, running, isPrimed, now } = input
  let s: LiveState = prev ?? { own: [] }

  if (s.agentId !== input.agentId) {
    s = { own: [], ...(input.agentId !== undefined && { agentId: input.agentId }) }

    if (latest?.finished) {
      s.known = latest.runId
    }
  } else {
    s = { ...s }
  }

  // Whose run lands next: this session's while it runs one, and briefly after.
  if (running !== null) {
    s.isOwnActive = true
    delete s.ownGrace
  } else if (s.isOwnActive) {
    delete s.isOwnActive
    s.ownGrace = now + OWN_GRACE_MS
  }

  if (latest === undefined) {
    return same(prev, s)
  }

  if (!latest.finished) {
    if (running !== null && !s.own.includes(latest.runId)) {
      s.own = [...s.own, latest.runId].slice(-20)
    }

    const ids = latest.rows.map(row => row.id)

    if (s.judged?.runId !== latest.runId) {
      s.judged = { runId: latest.runId, ids: [...ids].sort(byIdDesc) }
    } else {
      const fresh = ids.filter(id => !s.judged!.ids.includes(id)).sort(byIdDesc)

      if (fresh.length > 0) {
        s.judged = { runId: latest.runId, ids: [...fresh, ...s.judged.ids] }
      }
    }

    return same(prev, s)
  }

  if (!isPrimed || latest.stopped === true) {
    s.known = latest.runId

    return same(prev, s)
  }

  if (latest.runId !== s.known) {
    const isOwn = s.own.includes(latest.runId) || running !== null || s.isOwnActive === true || (s.ownGrace !== undefined && now <= s.ownGrace)

    s.known = latest.runId
    s.landed = { runId: latest.runId, at: now, isOwn }

    if (isOwn) {
      delete s.ownGrace
    } else {
      const rows = newFailures(input.current, latest)

      if (rows.length > 0) {
        s.newFail = { runId: latest.runId, rows }
      }
    }
  }

  return same(prev, s)
}

const same = (prev: LiveState | null, next: LiveState): LiveState => (prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)

/** Scenarios of `run` that passed in their previous verdict and do not now. */
export function newFailures(current: readonly RookCurrent[], run: RookRunView): LiveFailure[] {
  return changesIn(current, run.runId).regressed.map(row => ({ id: row.id, title: row.title, status: row.status }))
}

/** True while the run in flight is this session's, as far as `live` knows. */
export const isOwnRun = (live: LiveState | null, runId: string): boolean => live?.own.includes(runId) === true

// ── stale verdicts ──────────────────────────────────────────────────────────

/** The scenario's verdict predates an edit to a source it reaches (the re-test band's set). */
export function isStale(stale: RookStale | null, id: string): boolean {
  return stale !== null && (stale.isWholeAgent || stale.scenarios.some(s => s.id === id))
}

/** A verdict from `runId` is stale when the run started before the edit. */
export function isStaleIn(stale: RookStale | null, id: string, runId: string): boolean {
  const started = runStartMs(runId)

  return isStale(stale, id) && (started === undefined || started < stale!.since)
}

// ── the run in flight ───────────────────────────────────────────────────────

/** Who started a run, in a word: the status line's and the pane's `[source]`. */
export function sourceText(running: RookRunning | null, isOwn: boolean): string {
  // The person's own run needs no label; Claude's and another terminal's or CI's do.
  if (running === null) {
    return isOwn ? '' : 'elsewhere'
  }

  return running.source === 'tool' ? 'Claude' : ''
}

/** When the run started, ms since epoch: this session's own start, else its id or created time. */
export function runStartedAt(run: RookRunView | undefined, running: RookRunning | null): number | undefined {
  if (running !== null) {
    return running.startedAt
  }

  if (run === undefined) {
    return undefined
  }

  const created = run.created === undefined ? Number.NaN : Date.parse(run.created)

  return Number.isFinite(created) ? created : runStartMs(run.runId)
}

/** What the run is doing now: its first lane, or writing the report. */
export function doingText(run: RookRunView, now: number): string | undefined {
  const lane = run.lanes[0]

  if (lane === undefined) {
    return isReporting(run) ? REPORTING : undefined
  }

  return `${lane.id} ${lane.phase}${lane.since > 0 ? ` ${elapsed(Math.max(0, now - lane.since))}` : ''}`
}

/** `ETA <1m`, `ETA ~4m`, `ETA ~1h20m`. */
export function etaShort(ms: number): string {
  if (ms < 60_000) {
    return 'ETA <1m'
  }

  const minutes = Math.round(ms / 60_000)

  return minutes < 60 ? `ETA ~${minutes}m` : `ETA ~${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** The pane's first live line: `◐ 3/12 · 1m04s · ETA ~4m · 2 failing`, `◐ elsewhere 3/12 …` for a run from another terminal or CI. */
export function liveHeadline(opts: { run?: RookRunView; running: RookRunning | null; isOwn: boolean; now: number; eta?: number }): string {
  const { run, running, now } = opts
  const source = sourceText(running, opts.isOwn)
  const started = runStartedAt(run, running)
  const took = started === undefined || now < started ? undefined : elapsed(now - started)

  if (run === undefined || run.finished) {
    return [['◐', source, 'starting', running === null ? '' : running.label].filter(Boolean).join(' '), took].filter(Boolean).join(' · ')
  }

  return [
    ['◐', source, `${run.done}/${run.planned}`].filter(Boolean).join(' '),
    took,
    opts.eta === undefined ? undefined : etaShort(opts.eta),
    run.counts.fail > 0 ? `${run.counts.fail} failing` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** One row of the just-judged list. */
export type JudgedRow = { id: string; title: string; status: RookStatus; owner?: RookOwner; ownerLabel?: string; isStale: boolean }

export const STATUS_ICON: Record<RookStatus, string> = { Pass: '✓', Fail: '✗', 'Unable to Verify': '?' }

/** The run's newest verdicts, newest first: in the order they arrived when known, else by id. */
export function justJudged(opts: {
  run: RookRunView
  live: LiveState | null
  verdicts: readonly RookVerdictHistory[]
  stale: RookStale | null
  limit?: number
}): JudgedRow[] {
  const { run, live, verdicts, stale } = opts
  const rows = new Map(run.rows.map(row => [row.id, row]))
  const known = live?.judged?.runId === run.runId ? live.judged.ids.filter(id => rows.has(id)) : []
  const rest = [...rows.keys()].filter(id => !known.includes(id)).sort(byIdDesc)

  return [...rest, ...known].slice(0, opts.limit ?? JUDGED_SHOWN).map(id => judgedRow(rows.get(id)!, run.runId, verdicts, stale))
}

function judgedRow(row: RookScenarioRow, runId: string, verdicts: readonly RookVerdictHistory[], stale: RookStale | null): JudgedRow {
  const owner = row.status === 'Pass' ? undefined : ownerOf({ row, before: verdictsBefore(verdicts, row.id, runId) }).owner

  return {
    id: row.id,
    title: row.title || row.summary,
    status: row.status,
    ...(owner !== undefined && { owner, ownerLabel: OWNER_LABEL[owner] }),
    isStale: isStaleIn(stale, row.id, runId),
  }
}

/** The band above the prompt while a run is in flight: `◐ rook · 3/12 · SC-004 judging · 2 failing`. */
export function runBandText(run: RookRunView | undefined, running: RookRunning | null, now: number): string {
  if (run === undefined || run.finished) {
    return `◐ rook · starting${running === null ? '' : ` ${running.label}`}`
  }

  const doing = doingText(run, now)

  return ['◐ rook', `${run.done}/${run.planned}`, doing, run.counts.fail > 0 ? `${run.counts.fail} failing` : undefined].filter(Boolean).join(' · ')
}

/** The band for a run started elsewhere that broke what passed: `✗ rook · run … from elsewhere · new failure: SC-004 …`. */
export function newFailText(newFail: NonNullable<LiveState['newFail']>): string {
  const [first, ...more] = newFail.rows
  const what = first === undefined ? '' : `${first.id}${first.title ? ` ${first.title}` : ''}${more.length > 0 ? ` +${more.length}` : ''}`

  return `✗ rook · run ${newFail.runId} from elsewhere · new failure${newFail.rows.length === 1 ? '' : 's'}: ${what}`
}

/** A run or a job is in flight: the pane header says `● live`. */
export function isInFlight(snapshot: RookSnapshot | null, running: RookRunning | null, hasJob: boolean): boolean {
  return running !== null || hasJob || (snapshot?.latest !== undefined && !snapshot.latest.finished)
}

/** The pane header's freshness: `● live`, or `updated 12s ago` from the snapshot's time. */
export function freshnessText(isLive: boolean, checkedAt: number | undefined, now: number): string | undefined {
  if (isLive) {
    return '● live'
  }

  if (checkedAt === undefined || checkedAt <= 0) {
    return undefined
  }

  // Minutes, not seconds: the pane redraws on a change, and once a minute for this line (register.tsx poll).
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60_000)

  return minutes < 1 ? 'updated <1m ago' : minutes < 60 ? `updated ${minutes}m ago` : `updated ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m ago`
}
