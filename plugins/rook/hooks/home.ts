import type { RookOwner, RookRunView, RookScenarioRow, RookStatus, RookVerdictHistory } from '../types'
import { clip, excerpt } from './format'
import { OWNER_LABEL, ownerOf, trustedRate } from './owner'
import { runStartMs, verdictsBefore } from './changes'
import { compareRunIds } from './workspace'
import type { Io } from './workspace'
import { parseMap, str } from './yaml'

/**
 * The pane's first tab, two ways. A QE asks "can this ship?": blockers,
 * verdicts to check, suite health. A developer asks "did my change break
 * anything?": regressions since the last green run, what the edited files
 * reach, what the change cost. Pure: register.tsx reads the rows, the verdict
 * history, the scenario and feature files, and hands them here.
 */

/** A scenario's newest verdict, with the run it came from. */
export type HomeRow = RookScenarioRow & { runId: string }

/** What a scenario file says that the home tab needs. */
export type HomeScenario = { id: string; featureId?: string; class?: string; excluded?: boolean }

export type HomeFeature = { id: string; name?: string }

export type HomeInput = {
  /** Every scenario's newest verdict. */
  rows: readonly HomeRow[]
  /** The latest run: its clusters carry rook's `fault` once --rca explained them. */
  latest?: RookRunView
  verdicts: readonly RookVerdictHistory[]
  scenarios?: readonly HomeScenario[]
  features?: readonly HomeFeature[]
}

/** One scenario with who acts on it and its recent verdicts. */
export type Owned = {
  id: string
  title: string
  runId: string
  status: RookStatus
  owner: RookOwner
  why: string
  /** Its last MINI_RUNS verdicts, oldest first, this one included. */
  history: RookStatus[]
  isAdversarial: boolean
  row: HomeRow
}

/** How many runs the mini history and the flaky check look back. */
export const MINI_RUNS = 8
/** Verdict flips within MINI_RUNS that make a scenario flaky. */
export const FLAKY_FLIPS = 2

export const STATUS_ICON: Record<RookStatus, string> = { Pass: '✓', Fail: '✗', 'Unable to Verify': '?' }
export const STATUS_COLOR: Record<RookStatus, string> = { Pass: 'green', Fail: 'red', 'Unable to Verify': 'yellow' }

/** rook's own cluster `fault` for a scenario of the latest run, once --rca explained it. */
export function faultOf(latest: RookRunView | undefined, row: HomeRow): string | undefined {
  if (latest === undefined || latest.runId !== row.runId) {
    return undefined
  }

  return latest.clusters.find(cluster => cluster.fault !== undefined && cluster.scenarios.some(s => s.id === row.id))?.fault
}

/** A scenario's verdicts in the newest `n` runs that judged it, oldest first. */
export function recentOf(verdicts: readonly RookVerdictHistory[], id: string, n = MINI_RUNS): RookStatus[] {
  return (verdicts.find(h => h.id === id)?.runs ?? []).slice(-n).map(r => r.status)
}

/** How many times the verdict changed from one run to the next. */
export const flipsOf = (statuses: readonly RookStatus[]): number => statuses.filter((status, at) => at > 0 && status !== statuses[at - 1]).length

export const isFlaky = (statuses: readonly RookStatus[]): boolean => flipsOf(statuses.slice(-MINI_RUNS)) >= FLAKY_FLIPS

/** `✓✗✓?`: one glyph per run, oldest first. */
export const miniHistory = (statuses: readonly RookStatus[]): string => statuses.map(status => STATUS_ICON[status]).join('')

/** Every scenario with its owner (hooks/owner.ts), its history and whether it is adversarial. */
export function ownedOf(input: HomeInput): Owned[] {
  const classes = new Map((input.scenarios ?? []).map(s => [s.id, s.class]))

  return input.rows.map(row => {
    const fault = faultOf(input.latest, row)
    const verdict = ownerOf({ row, before: verdictsBefore(input.verdicts, row.id, row.runId), ...(fault !== undefined && { fault }) })
    const history = recentOf(input.verdicts, row.id)

    return {
      id: row.id,
      title: row.title,
      runId: row.runId,
      status: row.status,
      owner: verdict.owner,
      why: verdict.why,
      history: history.length > 0 ? history : [row.status],
      isAdversarial: classes.get(row.id) === 'adversarial',
      row,
    }
  })
}

/** The agent's features, `<agentDir>/features/F-xxx.yaml`: id and name. */
export async function readFeatures(io: Io, agentDir: string): Promise<HomeFeature[]> {
  const names = (await io.list(`${agentDir}/features`).catch(() => [])).filter(entry => entry.kind === 'file' && entry.name.endsWith('.yaml')).map(entry => entry.name)
  const features: HomeFeature[] = []

  for (const name of names.sort()) {
    const doc = parseMap((await io.read(`${agentDir}/features/${name}`)) ?? '')
    const featureName = str(doc.name) ?? str(doc.title)

    features.push({ id: str(doc.id) ?? str(doc.local_id) ?? name.replace(/\.yaml$/, ''), ...(featureName !== undefined && { name: featureName }) })
  }

  return features
}

/** Features no (included) scenario covers. */
export function coverageOf(features: readonly HomeFeature[], scenarios: readonly HomeScenario[]): { covered: number; total: number; gaps: HomeFeature[] } {
  const cited = new Set(scenarios.filter(s => s.excluded !== true && s.featureId !== undefined).map(s => s.featureId))
  const gaps = features.filter(f => !cited.has(f.id))

  return { covered: features.length - gaps.length, total: features.length, gaps }
}

// ── QE: Release ──────────────────────────────────────────────────────────────

export type Release = {
  /** No blockers, and at least one verdict to stand on. */
  isReady: boolean
  hasVerdicts: boolean
  blockers: Owned[]
  /** passed-but, judge unsure and profile broke: a person should look before trusting them. */
  toCheck: Owned[]
  /** Scenarios that look wrong (never passed, or rook said so). */
  suiteProblems: Owned[]
  flaky: Owned[]
  /** Pass over every scenario with a verdict, 0–1. */
  passRate?: number
  trustedRate?: number
  coverage: { covered: number; total: number; gaps: HomeFeature[] }
}

export function releaseOf(input: HomeInput): Release {
  const owned = ownedOf(input)
  const blockers = owned.filter(o => o.owner === 'agent')
  const passes = owned.filter(o => o.status === 'Pass').length
  const trusted = trustedRate(input.rows)

  return {
    isReady: owned.length > 0 && blockers.length === 0,
    hasVerdicts: owned.length > 0,
    blockers,
    toCheck: owned.filter(o => o.owner === 'passbut' || o.owner === 'judge' || o.owner === 'harness'),
    suiteProblems: owned.filter(o => o.owner === 'scenario'),
    flaky: owned.filter(o => isFlaky(o.history)),
    ...(owned.length > 0 && { passRate: passes / owned.length }),
    ...(trusted !== undefined && { trustedRate: trusted }),
    coverage: coverageOf(input.features ?? [], input.scenarios ?? []),
  }
}

const pct = (rate: number | undefined): string => (rate === undefined ? '–' : `${Math.round(rate * 100)}%`)

/** `pass 67% · trusted pass 33% · coverage 2/3 features · 1 flaky` */
export function releaseLine(release: Release): string {
  return [
    `pass ${pct(release.passRate)}`,
    `trusted pass ${pct(release.trustedRate)}`,
    `coverage ${release.coverage.covered}/${release.coverage.total} features`,
    `${release.flaky.length} flaky`,
  ].join(' · ')
}

/** Where a scenario's evidence lives in one run. */
export const evidencePaths = (agentDir: string, runId: string, id: string): string[] =>
  ['verdict.yaml', 'response.json', 'hooks.json'].map(file => `${agentDir}/runs/${runId}/scenarios/${id}/${file}`)

function criteriaLines(row: RookScenarioRow, indent = '  '): string[] {
  if (row.failing.length === 0) {
    return [`${indent}${clip(row.summary || 'no failing criterion was recorded', 600)}`]
  }

  return row.failing.slice(0, 6).flatMap(c => [
    `${indent}• ${c.id}: ${clip(c.criterion, 400)}`,
    `${indent}  expected: ${clip(c.expected, 600)}`,
    `${indent}  achieved: ${clip(c.achieved, 600)}`,
    ...(c.evidence ? [`${indent}  evidence: ${excerpt(c.evidence, 800).replace(/\n/g, ' ')}`] : []),
  ])
}

/** Draft bug reports for the blockers: grounded in each verdict, nothing invented. */
export function blockersReportPrompt(ask: { agentId: string; agentDir: string; blockers: readonly Owned[] }): string {
  const reports = ask.blockers.map(b =>
    [
      `${b.id}${b.title ? ` — ${b.title}` : ''} (run ${b.runId}${b.isAdversarial ? ', adversarial' : ''}${b.row.compromised ? ', compromised' : ''})`,
      `  recent verdicts, oldest first: ${miniHistory(b.history)}`,
      ...criteriaLines(b.row),
      `  evidence files (read the ones that exist): ${evidencePaths(ask.agentDir, b.runId, b.id).join(', ')}`,
    ].join('\n'),
  )

  return [
    `Draft one bug report per scenario below for agent ${ask.agentId}: ${ask.blockers.length === 1 ? 'a scenario rook judged an agent bug' : `${ask.blockers.length} scenarios rook judged agent bugs`}.`,
    '',
    ...reports.flatMap(r => [r, '']),
    'Each report: a title, steps to reproduce (the scenario and its input), expected, actual, the evidence (quote it), severity, and the scenario id and run id.',
    'Use only what the evidence shows: read the files above, quote them, and do not guess at a cause or invent behaviour the evidence does not record. Where it is silent, say so.',
    'Do not change any code or scenario.',
  ].join('\n')
}

/** What `rook generate` is asked to cover: the features with no scenario. */
export function gapsInstruction(gaps: readonly HomeFeature[]): string {
  const names = gaps.map(f => (f.name ? `${f.id} (${f.name})` : f.id))

  return `Write scenarios for the features that have none yet: ${names.join('; ')}.`
}

// ── dev: My change ───────────────────────────────────────────────────────────

/** Each run of the history with the verdicts it gave, oldest first. */
export function runsOf(verdicts: readonly RookVerdictHistory[]): { runId: string; statuses: Map<string, RookStatus> }[] {
  const byRun = new Map<string, Map<string, RookStatus>>()

  for (const h of verdicts) {
    for (const r of h.runs) {
      byRun.set(r.runId, (byRun.get(r.runId) ?? new Map()).set(h.id, r.status))
    }
  }

  return [...byRun].sort((a, b) => compareRunIds(a[0], b[0])).map(([runId, statuses]) => ({ runId, statuses }))
}

/**
 * The developer's last known-good point: the newest run in which every
 * scenario that ran passed; without one, the newest run before the first
 * regression (a scenario going Pass → Fail).
 */
export function lastGreenOf(verdicts: readonly RookVerdictHistory[]): string | undefined {
  const runs = runsOf(verdicts)
  const green = runs.filter(r => r.statuses.size > 0 && [...r.statuses.values()].every(s => s === 'Pass')).at(-1)

  if (green !== undefined) {
    return green.runId
  }

  const firstRegression = runs.findIndex(r =>
    [...r.statuses].some(([id, status]) => {
      if (status !== 'Fail') {
        return false
      }

      const before = verdictsBefore(verdicts, id, r.runId)

      return before.at(-1) === 'Pass'
    }),
  )

  return firstRegression > 0 ? runs[firstRegression - 1]!.runId : undefined
}

/** Agent bugs that passed before and fail now, judged after the last green run. */
export function regressionsOf(owned: readonly Owned[], verdicts: readonly RookVerdictHistory[], lastGreen: string | undefined): Owned[] {
  return owned.filter(
    o =>
      o.owner === 'agent' &&
      o.status === 'Fail' &&
      verdictsBefore(verdicts, o.id, o.runId).includes('Pass') &&
      (lastGreen === undefined || compareRunIds(o.runId, lastGreen) > 0),
  )
}

/** The cheap line that says what failed: the first failing criterion's `achieved`. */
export const brokeLine = (row: RookScenarioRow): string | undefined => {
  const c = row.failing[0]

  return c === undefined ? undefined : `${c.id}: ${c.achieved || c.criterion}`
}

/** A tracked file edited since the last green run, and the scenarios it reaches. */
export type ChangedFile = {
  path: string
  mtimeMs: number
  scenarios: { id: string; status?: RookStatus; isStale: boolean }[]
  /** Set when no feature cites the file: how the scenarios were picked. */
  reason?: string
}

/** A verdict older than the edit, or a scenario the band says an edit touched, is stale. */
export function isStaleVerdict(runId: string | undefined, mtimeMs: number, staleIds: ReadonlySet<string>, id: string): boolean {
  if (staleIds.has(id)) {
    return true
  }

  const at = runId === undefined ? undefined : runStartMs(runId)

  return runId === undefined || (at !== undefined && at < mtimeMs)
}

export type Metrics = { tokens?: number; turns?: number; latencyMs?: number }

export const metricsOf = (row: RookScenarioRow): Metrics => ({
  ...(row.tokens !== undefined && { tokens: row.tokens.input + row.tokens.output }),
  ...(row.turns !== undefined && { turns: row.turns }),
  ...(row.latencyMs !== undefined && { latencyMs: row.latencyMs }),
})

export type Cost = {
  tokens?: { now: number; before?: number }
  /** Mean per-scenario latency, ms. */
  latencyMs?: { now: number; before?: number }
  /** The scenarios whose tokens, turns or latency grew most, biggest first. */
  grew: { id: string; now: Metrics; before: Metrics; growth: number }[]
}

const sumOf = (values: readonly (number | undefined)[]): number | undefined => {
  const known = values.filter((v): v is number => v !== undefined)

  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0)
}

const meanOf = (values: readonly (number | undefined)[]): number | undefined => {
  const known = values.filter((v): v is number => v !== undefined)

  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0) / known.length
}

/** Tokens and latency of the latest run against the run before it, and the scenarios that grew most. */
export function costOf(now: readonly RookScenarioRow[], before: readonly RookScenarioRow[], top = 3): Cost {
  const tokens = sumOf(now.map(r => metricsOf(r).tokens))
  const tokensBefore = sumOf(before.map(r => metricsOf(r).tokens))
  const latency = meanOf(now.map(r => r.latencyMs))
  const latencyBefore = meanOf(before.map(r => r.latencyMs))
  const was = new Map(before.map(r => [r.id, metricsOf(r)]))
  const grew = now
    .flatMap(r => {
      const m = metricsOf(r)
      const b = was.get(r.id)

      if (b === undefined) {
        return []
      }

      const ratios = (['tokens', 'turns', 'latencyMs'] as const).flatMap(k => {
        const x = m[k]
        const y = b[k]

        return x === undefined || y === undefined ? [] : [(x - y) / Math.max(y, 1)]
      })
      const growth = Math.max(0, ...ratios)

      return growth > 0 ? [{ id: r.id, now: m, before: b, growth }] : []
    })
    .sort((a, b) => b.growth - a.growth || a.id.localeCompare(b.id))
    .slice(0, top)

  return {
    ...(tokens !== undefined && { tokens: { now: tokens, ...(tokensBefore !== undefined && { before: tokensBefore }) } }),
    ...(latency !== undefined && { latencyMs: { now: Math.round(latency), ...(latencyBefore !== undefined && { before: Math.round(latencyBefore) }) } }),
    grew,
  }
}

const signed = (now: number, before: number | undefined): string => {
  if (before === undefined || before === 0) {
    return ''
  }

  const change = Math.round(((now - before) / before) * 100)

  return change === 0 ? ' (same)' : ` (${change > 0 ? '+' : ''}${change}%)`
}

/** `tokens 1,200 (+20%) · latency 140ms (−5%)` */
export function costLine(cost: Cost): string {
  return [
    cost.tokens === undefined ? undefined : `tokens ${cost.tokens.now.toLocaleString('en-US')}${signed(cost.tokens.now, cost.tokens.before)}`,
    cost.latencyMs === undefined ? undefined : `latency ${cost.latencyMs.now}ms per scenario${signed(cost.latencyMs.now, cost.latencyMs.before)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** `SC-004 tokens 58→120 · turns 1→3` */
export function grewLine(g: Cost['grew'][number]): string {
  const parts = (
    [
      ['tokens', '', g.before.tokens, g.now.tokens],
      ['turns', '', g.before.turns, g.now.turns],
      ['latency', 'ms', g.before.latencyMs, g.now.latencyMs],
    ] as const
  ).flatMap(([name, unit, b, n]) => (b === undefined || n === undefined || n <= b ? [] : [`${name} ${b}${unit}→${n}${unit}`]))

  return `${g.id} ${parts.join(' · ')}`
}

/** `SC-003 scenario wrong · SC-007 judge unsure`: verdicts the developer's code did not cause. */
export function notYoursLine(owned: readonly Owned[]): string | undefined {
  const others = owned.filter(o => o.owner === 'scenario' || o.owner === 'harness' || o.owner === 'judge')

  return others.length === 0 ? undefined : others.map(o => `${o.id} ${OWNER_LABEL[o.owner]}`).join(' · ')
}

/** Fix the regressions: each one's evidence, the files changed since the last green run, and the re-test. */
export function fixChangePrompt(ask: {
  agentId: string
  agentDir: string
  lastGreen?: string
  regressions: readonly Owned[]
  changed: readonly { path: string }[]
}): string {
  const ids = ask.regressions.map(r => r.id)

  return [
    `${ask.regressions.length === 1 ? '1 scenario' : `${ask.regressions.length} scenarios`} of agent ${ask.agentId} passed before and fail now${ask.lastGreen ? ` (last green run: ${ask.lastGreen})` : ''}.`,
    '',
    ...ask.regressions.flatMap(r => [
      `${r.id}${r.title ? ` — ${r.title}` : ''} (run ${r.runId}${r.row.compromised ? ', compromised' : ''})`,
      ...criteriaLines(r.row),
      `  verdict: ${evidencePaths(ask.agentDir, r.runId, r.id)[0]}`,
      '',
    ]),
    ...(ask.changed.length > 0
      ? ['Files changed since the last green run (start here):', ...ask.changed.slice(0, 20).map(f => `  - ${f.path}`), '']
      : ['No tracked file changed since the last green run that rook could see.', '']),
    'Find the change that broke each one and fix the agent. If the evidence shows the criterion is wrong rather than the agent, say so instead.',
    `Then re-test with the rook run tool, only=[${ids.map(id => `"${id}"`).join(', ')}].`,
  ].join('\n')
}
