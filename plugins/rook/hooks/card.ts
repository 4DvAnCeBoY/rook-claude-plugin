import type { RookRunView } from '../types'
import { clip, credits, duration, isExplained, orderedClusters } from './format'
import { RUN_ID } from './workspace'

/**
 * The transcript verdict card: pure helpers. The card is presentation only;
 * the model reads the tool's result text as it was, untouched.
 */

/** The tools whose result rows draw as a card: the run, and a report of one run. */
export const CARD_TOOL = /^mcp__rook__(run|report)$/

/** The run tool's own row, which shows progress while it runs. */
export const CARD_RUN_TOOL = /^mcp__rook__run$/

/**
 * The text a tool row's `output` carries: the hook's own `result` string,
 * or the MCP content blocks it was mapped to.
 */
export function outputText(output: unknown): string | undefined {
  if (typeof output === 'string') {
    return output
  }

  if (Array.isArray(output)) {
    const texts = output.map(block => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))

    return texts.join('') || undefined
  }

  if (typeof output === 'object' && output !== null) {
    const record = output as { result?: unknown; content?: unknown; text?: unknown }

    return outputText(record.result ?? record.content ?? record.text)
  }

  return undefined
}

/** The run id a result names in its first line (`rook run <id> …`), when it is one. */
export function runIdOf(output: unknown): string | undefined {
  const id = outputText(output)?.match(/^rook run (\S+)/)?.[1]

  return id !== undefined && RUN_ID.test(id) ? id : undefined
}

/** One line under the counts: a cluster or a failed scenario. */
export type CardItem = { id: string; title: string; isCluster: boolean }

export type CardFacts = {
  runId: string
  name?: string
  pass: number
  fail: number
  unverifiable: number
  judged: string
  /** `pass rate 67% · 12.5 credits · 1m04s`, the parts rook gave. */
  metrics: string
  items: CardItem[]
  /** Clusters and failures beyond the ones shown. */
  more: number
  hasFailures: boolean
}

/** What the card draws for a finished run: counts, metrics, up to `max` clusters or failures. */
export function cardFacts(run: RookRunView, max = 3): CardFacts {
  const clusters = orderedClusters(run).filter(cluster => cluster.kind !== 'unverifiable' || isExplained(cluster))
  const clustered = new Set(clusters.flatMap(cluster => cluster.scenarios.map(s => s.id)))
  const loose = run.rows.filter(row => row.status === 'Fail' && !clustered.has(row.id))
  const all: CardItem[] = [
    ...clusters.map(cluster => ({ id: cluster.id, title: clip(cluster.why || cluster.scenarios.map(s => s.id).join(', '), 90), isCluster: true })),
    ...loose.map(row => ({ id: row.id, title: clip(row.title, 90), isCluster: false })),
  ]
  const metrics = [
    run.passRate === undefined ? undefined : `pass rate ${Math.round(run.passRate * 100)}%`,
    credits(run.credits),
    run.durationMs === undefined ? undefined : duration(run.durationMs),
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    runId: run.runId,
    ...(run.name !== undefined && run.name !== '' && { name: run.name }),
    pass: run.counts.pass,
    fail: run.counts.fail,
    unverifiable: run.counts.unverifiable,
    judged: `${run.done}/${run.planned} judged`,
    metrics,
    items: all.slice(0, max),
    more: Math.max(0, all.length - max),
    hasFailures: run.counts.fail > 0,
  }
}

export type CardProgress = { done: number; planned: number; failing: number; lanes: string[]; more: number }

/** A run in flight as the run tool's row shows it: judged so far and the lanes still going. */
export function cardProgress(run: RookRunView, max = 3): CardProgress {
  return {
    done: run.done,
    planned: run.planned,
    failing: run.counts.fail,
    lanes: run.lanes.slice(0, max).map(lane => `${lane.id} ${lane.phase}`),
    more: Math.max(0, run.lanes.length - max),
  }
}
