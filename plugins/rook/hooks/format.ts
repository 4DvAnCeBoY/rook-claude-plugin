import type { RookCluster, RookCurrent, RookRunning, RookRunView, RookScenarioRow, RookSnapshot, RookStale } from '../types'
import { changesIn, countsOf } from './workspace'
import type { RunSummary } from './workspace'

/**
 * Every string the mod shows or hands to the model, kept pure so the tests
 * can hold them exactly. The vocabulary is rook's own: Pass, Fail, Unable to
 * Verify, and "what nobody looked at" for verification gaps.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Like clip, but keeps line breaks: diffs and multi-line evidence stay readable. */
export const excerpt = (text: string, max: number): string => {
  const kept = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  return kept.length <= max ? kept : `${kept.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

const indent = (text: string, by: string) => text.split('\n').join(`\n${by}`)

/** `12.5 credits`; from a thousand up, whole and grouped: `9,959,944 credits`. */
export const credits = (value: number | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  const shown = Math.abs(value) >= 1000 ? String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(Number(value.toFixed(2)))

  return `${shown} credits`
}

/** `4m12s`, `33.1s`, `850ms`. */
export function duration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }

  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }

  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)

  return minutes < 60 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** rook's `unverifiable_reason` codes in words. */
const REASONS: Record<string, string> = {
  agent_never_ran: 'the agent never ran',
  not_observable: 'rook could not observe it',
  undecidable: 'the judge could not decide',
}

export const reasonText = (reason: string | undefined): string | undefined => (reason === undefined ? undefined : (REASONS[reason] ?? reason.replace(/_/g, ' ')))

/** Rows that passed but carry gaps, plus every Unable to Verify. */
export const unlooked = (run: RookRunView): RookScenarioRow[] =>
  run.rows.filter(row => row.status === 'Unable to Verify' || row.gaps.length > 0)

/** What nobody looked at in one row, in words: rook's own gap notes first, then the reason. */
export function gapText(row: RookScenarioRow, max: number): string {
  const said = row.gaps.length > 0 ? row.gaps.join('; ') : row.unchecked.join('; ')

  return clip([said, said === '' ? reasonText(row.reason) : undefined].filter(Boolean).join(' ') || 'gap', max)
}

/** The status line's text; Claude Code shows it after the plugin's name. */
/**
 * One piece of the status line. `rank` 0 is never dropped; a higher rank is
 * shortened to `short`, then dropped, before a lower one when the line is too long.
 * `glue` joins it to the piece before (` · ` unless set).
 */
export type StatusPart = { text: string; rank: number; short?: string; glue?: string }

/** Joins parts as the status line shows them. */
export const joinParts = (parts: readonly StatusPart[]): string =>
  parts.map((part, i) => (i === 0 ? part.text : `${part.glue ?? ' · '}${part.text}`)).join('')

/**
 * The score's own parts: progress while a run is in flight (with `eta` after
 * the lane), otherwise every scenario's latest verdict with the `trend` beside it.
 */
export function statusParts(snapshot: RookSnapshot | null, isRunning: boolean, extra: { eta?: string; trend?: string } = {}): StatusPart[] {
  const run = snapshot?.latest

  if (run === undefined || snapshot === null) {
    return isRunning ? [{ text: '▸ starting', rank: 0 }] : []
  }

  if (!run.finished) {
    const lane = run.lanes[0]
    const doing = lane ? `${lane.id} ${lane.phase}` : isReporting(run) ? REPORTING : undefined

    return [
      { text: `▸ ${run.done}/${run.planned}`, rank: 0 },
      ...(doing === undefined ? [] : [{ text: doing, rank: 5 }]),
      ...(extra.eta === undefined ? [] : [{ text: extra.eta, rank: 4 }]),
      { text: `✓${run.counts.pass} ✗${run.counts.fail} ?${run.counts.unverifiable}`, rank: 0 },
    ]
  }

  const { pass, fail, unverifiable } = countsOf(snapshot.current)
  const gaps = unlooked(run).length
  const { fixed, regressed } = changesIn(snapshot.current, run.runId)
  const moved = [fixed.length > 0 ? `↑${fixed.length} fixed` : '', regressed.length > 0 ? `↓${regressed.length} regressed` : ''].filter(Boolean).join(' ')

  return [
    { text: `✓${pass} ✗${fail} ?${unverifiable}`, rank: 0 },
    ...(extra.trend === undefined ? [] : [{ text: extra.trend, rank: 8, glue: ' ' }]),
    ...(gaps > 0 ? [{ text: plural(gaps, 'gap'), rank: 9 }] : []),
    ...(moved ? [{ text: moved, rank: 6 }] : []),
  ]
}

export function statusLine(snapshot: RookSnapshot | null, isRunning: boolean): string | undefined {
  const parts = statusParts(snapshot, isRunning)

  return parts.length === 0 ? undefined : joinParts(parts)
}

/** Every scenario judged, report.yaml not written yet: rook is summarising the run. */
export const isReporting = (run: RookRunView): boolean => !run.finished && run.planned > 0 && run.done >= run.planned && run.lanes.length === 0

export const REPORTING = 'writing the report'

/** The turn's spinner while Claude waits on a rook run: where it is, at any terminal width. */
export function spinnerText(run: RookRunView | undefined, running: RookRunning, now: number): string {
  const elapsed = duration(Math.max(0, now - running.startedAt))

  if (run === undefined || run.finished) {
    return `rook: starting ${running.label} · ${elapsed}`
  }

  const lane = run.lanes[0]
  const more = run.lanes.length > 1 ? ` +${run.lanes.length - 1}` : ''
  const doing = lane ? ` · ${lane.id} ${lane.phase}${more}` : isReporting(run) ? ` · ${REPORTING}` : ''

  return `rook ${run.done}/${run.planned}${doing} · ${elapsed}${run.counts.fail > 0 ? ` · ${run.counts.fail} failing` : ''}`
}

export const progressBar = (done: number, planned: number, width: number): string => {
  const cells = Math.max(4, width)
  const filled = planned <= 0 ? 0 : Math.min(cells, Math.round((done / planned) * cells))

  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`
}

/** `pass rate 50% · 12.5 credits · 1m04s`; `run` names the figure when a total is quoted beside it. */
export function metricsLine(run: RookRunView, isTotalQuoted = false): string {
  const cost = credits(run.credits)

  return [
    run.passRate === undefined ? undefined : `pass rate ${Math.round(run.passRate * 100)}%`,
    cost !== undefined && isTotalQuoted ? `run ${cost}` : cost,
    run.durationMs === undefined ? undefined : duration(run.durationMs),
  ]
    .filter(Boolean)
    .join(' · ')
}

/** One failing scenario as the model needs it to fix the agent. */
export function failureNote(row: RookScenarioRow, verdictPath: string): string {
  const head = `${row.id}${row.title ? ` — ${row.title}` : ''}${row.compromised ? ' [COMPROMISED]' : ''}`
  const criteria = row.failing.slice(0, 6).map(c =>
    [
      `  • ${c.id}: ${clip(c.criterion, 400)}`,
      `    expected: ${clip(c.expected, 600)}`,
      `    achieved: ${clip(c.achieved, 600)}`,
      ...(c.evidence ? [`    evidence: ${indent(excerpt(c.evidence, 800), '      ')}`] : []),
    ].join('\n'),
  )

  return [head, ...(criteria.length > 0 ? criteria : [`  ${clip(row.summary, 600)}`]), `  verdict: ${verdictPath}`].join('\n')
}

/** Whose fault rook says a cluster is, as an instruction. */
const FAULT: Record<string, string> = {
  agent: 'fix the agent',
  scenario: 'rook thinks the SCENARIO is wrong, not the agent: say so rather than bending the agent to it',
  harness: 'rook thinks the HARNESS is at fault (profile, hooks, environment): fix that, not the agent',
  unclear: 'rook could not tell whose fault it is: check the evidence before changing the agent',
}

/** Clusters as Claude should work them: compromised first, then failures, then what could not be verified. */
const KIND_ORDER = ['compromised', 'failed', 'unverifiable']

export const orderedClusters = (run: RookRunView): RookCluster[] =>
  [...run.clusters].sort((a, b) => (KIND_ORDER.indexOf(a.kind) + 4) % 4 - (KIND_ORDER.indexOf(b.kind) + 4) % 4)

/** Was the cluster explained by --rca (rather than "not explained — out of credits")? */
export const isExplained = (cluster: RookCluster): boolean => cluster.remedy !== undefined

export function clusterNote(cluster: RookCluster, rows: ReadonlyMap<string, RookScenarioRow>, runDir: string): string {
  const head = `${cluster.id} [${cluster.kind}] ${cluster.why} — ${plural(cluster.scenarios.length, 'scenario')}`
  const rca = [
    ...(cluster.cause ? [`  cause: ${indent(excerpt(cluster.cause, 1500), '    ')}`] : []),
    ...(cluster.fault ? [`  fault: ${cluster.fault}${cluster.confidence ? ` · ${cluster.confidence} confidence` : ''} — ${FAULT[cluster.fault] ?? FAULT.unclear}`] : []),
    ...(cluster.where.length > 0 ? [`  where: ${cluster.where.slice(0, 8).join(', ')}`] : []),
    ...(cluster.remedy ? [`  remedy (rook's proposed change; check it against the code before applying):\n    ${indent(excerpt(cluster.remedy, 4000), '    ')}`] : []),
  ]
  const scenarios = cluster.scenarios.slice(0, 6).map(s => {
    const row = rows.get(s.id)

    return row !== undefined && row.status === 'Fail'
      ? indent(failureNote(row, `${runDir}/scenarios/${s.id}/verdict.yaml`), '  ')
      : `  ${s.id}${s.title ? ` — ${s.title}` : ''}${row && row.status !== 'Fail' ? ` (${row.status}: ${gapText(row, 200)})` : ''}`
  })
  const more = cluster.scenarios.length > 6 ? [`  …and ${cluster.scenarios.length - 6} more in this cluster`] : []

  return [head, ...rca, ...scenarios, ...more].join('\n')
}

function gapLines(run: RookRunView): string[] {
  return unlooked(run)
    .slice(0, 8)
    .map(row => `  ? ${row.id}${row.reason ? ` (${reasonText(row.reason)})` : ''}: ${gapText(row, 300)}`)
}

function tailOf(run: RookRunView): string[] {
  return [
    ...(run.narrative ? ['', `rook's read: ${clip(run.narrative, 900)}`] : []),
    ...(run.next.length > 0 ? ['', 'rook suggests next:', ...run.next.slice(0, 5).map(step => `  · ${clip(step, 300)}`)] : []),
  ]
}

export function failureContext(run: RookRunView, agentDir: string, agentId: string, isTotalQuoted = false): string {
  const runDir = `${agentDir}/runs/${run.runId}`
  const rows = new Map(run.rows.map(row => [row.id, row]))
  const clusters = orderedClusters(run).filter(cluster => cluster.kind !== 'unverifiable')
  const clustered = new Set(clusters.flatMap(cluster => cluster.scenarios.map(s => s.id)))
  const loose = run.rows.filter(row => row.status === 'Fail' && !clustered.has(row.id))
  const notes = loose.slice(0, 10).map(row => failureNote(row, `${runDir}/scenarios/${row.id}/verdict.yaml`))
  const more = loose.length > 10 ? [`…and ${loose.length - 10} more failing scenarios in ${runDir}/scenarios/`] : []
  const gaps = gapLines(run)
  const explained = clusters.some(isExplained)
  const unexplained = clusters.length > 0 && !explained

  return [
    `rook run ${run.runId}${run.name ? ` (${run.name})` : ''} against agent ${agentId} finished: ` +
      `${run.counts.pass} Pass, ${run.counts.fail} Fail, ${run.counts.unverifiable} Unable to Verify.` +
      `${metricsLine(run, isTotalQuoted) ? ` ${metricsLine(run, isTotalQuoted)}.` : ''}`,
    ...(run.headline ? [`Headline: ${clip(run.headline, 300)}`] : []),
    ...(clusters.length > 0
      ? [
          '',
          `Failures grouped by root shape (${plural(clusters.length, 'cluster')}; one fix often clears a whole cluster):`,
          ...clusters.slice(0, 8).map(cluster => clusterNote(cluster, rows, runDir)),
          ...(clusters.length > 8 ? [`…and ${clusters.length - 8} more clusters in ${runDir}/report.yaml`] : []),
        ]
      : []),
    ...(notes.length > 0 ? ['', 'Failing scenarios (criterion, expected vs achieved, quoted evidence):', ...notes, ...more] : []),
    ...(gaps.length > 0 ? ['', 'Not verified — Unable to Verify is not Fail; these are what nobody looked at:', ...gaps] : []),
    ...tailOf(run),
    '',
    'Fix the agent where the evidence shows its behaviour is wrong. If a criterion itself looks wrong, say so rather than bending the agent to it. ' +
      'Re-test with the rook run tool, passing only the scenario ids you touched.' +
      (unexplained
        ? ' To have rook explain the clusters (cause, whose fault, a proposed diff), call the rook report tool with rca: true: ' +
          'it reads this run again without calling the agent, free if this agent version was explained already, otherwise it costs credits.'
        : ''),
  ].join('\n')
}

export function runSummary(run: RookRunView, agentDir: string, agentId: string, totalCredits?: number): string {
  if (run.counts.fail > 0) {
    return failureContext(run, agentDir, agentId, totalCredits !== undefined) + spentLine(totalCredits)
  }

  const gaps = gapLines(run)
  const rows = new Map(run.rows.map(row => [row.id, row]))
  const runDir = `${agentDir}/runs/${run.runId}`
  const clusters = orderedClusters(run)

  return [
    `rook run ${run.runId} against agent ${agentId}: ${run.counts.pass} Pass, 0 Fail, ${run.counts.unverifiable} Unable to Verify` +
      ` (${run.done}/${run.planned} judged).${metricsLine(run, totalCredits !== undefined) ? ` ${metricsLine(run, totalCredits !== undefined)}.` : ''}`,
    ...(run.headline ? [`Headline: ${clip(run.headline, 300)}`] : []),
    ...(gaps.length > 0 ? ['Nothing failed. Unable to Verify is not Pass either; here is what nobody looked at:', ...gaps] : []),
    ...(clusters.length > 0 ? ['', ...clusters.slice(0, 6).map(cluster => clusterNote(cluster, rows, runDir))] : []),
    ...tailOf(run),
    ...(totalCredits === undefined ? [] : [spentLine(totalCredits).trim()]),
    `Evidence: ${runDir}/`,
  ].join('\n')
}

/** What the whole command cost: the run plus rook's report and anything else it charged. */
const spentLine = (total: number | undefined): string =>
  total === undefined ? '' : `\nSpent in total: ${credits(total)} (the run plus rook's report).`

/** The band's scenarios the person left ticked (all, until they untick some). */
export const tickedOf = (stale: RookStale, unticked: readonly string[] = []): RookStale['scenarios'] =>
  stale.scenarios.filter(s => !unticked.includes(s.id))

/** One scenario's estimated re-test cost, from the band's estimate for all of them. */
export const perScenario = (stale: RookStale): number | undefined =>
  stale.estimate === undefined || stale.scenarios.length === 0 ? undefined : stale.estimate / stale.scenarios.length

/** The band's line: what changed, what it reaches and why, what re-testing the ticked scenarios costs. */
export function staleLine(stale: RookStale, unticked: readonly string[] = []): string {
  const [first, ...rest] = stale.files
  const files = `${first ?? ''}${rest.length > 0 ? ` (+${rest.length})` : ''}`
  const reach =
    stale.reason ?? (stale.isWholeAgent ? `all ${plural(stale.scenarios.length, 'scenario')} may be affected` : `${plural(stale.scenarios.length, 'scenario')} touch it`)
  const ticked = tickedOf(stale, unticked).length
  const picked = ticked === stale.scenarios.length ? '' : ` · ${ticked} of ${stale.scenarios.length} ticked`
  const each = perScenario(stale)
  const cost = each === undefined ? '' : ` · ~${credits(each * ticked)}`

  return `Agent changed since last run: ${files} · ${reach}${picked}${cost}`
}

/** What Re-test asks Claude: only the ticked scenarios, and how they were chosen. */
export function retestPrompt(stale: RookStale, unticked: readonly string[] = []): string {
  const ids = stale.scenarios.map(s => s.id)
  const ticked = tickedOf(stale, unticked)
  const isEverything = ids.length === 0 || (stale.isWholeAgent && ticked.length === ids.length)
  const scope = isEverything ? 'every scenario' : `scenarios ${ticked.map(s => s.id).join(', ')}`
  const each = perScenario(stale)
  const cost = each === undefined ? '' : ` That is about ${credits(each * (isEverything ? ids.length : ticked.length))} at the last run's rate.`
  const narrow =
    isEverything && stale.isWholeAgent && ids.length > 1
      ? ` No feature cites the changed file, so every scenario may be affected${stale.reason === undefined ? '' : ` (${stale.reason})`}; if you can tell from the change which scenarios it reaches, run only those.`
      : ''
  const chosen =
    !isEverything && stale.reason !== undefined
      ? ` No feature cites the changed file, so these were chosen as ${stale.reason}: ${ticked.map(s => `${s.id}${s.why === undefined ? '' : ` (${s.why})`}`).join(', ')}. If the change plainly reaches other scenarios, say which.`
      : ''
  const left = ticked.length < ids.length ? ` The person left out ${ids.filter(id => unticked.includes(id)).join(', ')}; do not run those.` : ''

  return (
    `The agent under test changed (${stale.files.join(', ')}). Use the rook run tool to re-test ${scope}` +
    `${isEverything ? '' : ' (pass them as `only`)'}, then fix anything that fails, quoting rook's evidence.${cost}${narrow}${chosen}${left}`
  )
}

/** Credits per executed scenario in a finished run, for estimates. */
export const creditsPerScenario = (run: RookRunView | undefined): number | undefined =>
  run?.finished && run.credits !== undefined && run.done > 0 ? run.credits / run.done : undefined

/**
 * `rook scenarios list --json`, with each scenario's latest verdict: what
 * Claude needs to choose `only` without guessing ids.
 */
export function scenariosText(doc: unknown, current: readonly RookCurrent[]): string {
  type Scenario = {
    scenario_id?: string
    title?: string
    feature_id?: string
    class?: string
    category?: string
    excluded?: boolean
    unrunnable?: unknown
  }
  const list = doc as { agent_id?: string; profile_id?: string; total?: number; runnable?: number; scenarios?: Scenario[] }
  const scenarios = Array.isArray(list?.scenarios) ? list.scenarios : []
  const verdicts = new Map(current.map(row => [row.id, row]))

  if (scenarios.length === 0) {
    return 'rook: this agent has no scenarios yet. Use the rook generate tool to write some.'
  }

  return [
    `rook scenarios for agent ${list.agent_id ?? '?'} (profile ${list.profile_id ?? '?'}): ${list.runnable ?? '?'} runnable of ${list.total ?? scenarios.length}`,
    ...scenarios.map(s => {
      const verdict = s.scenario_id === undefined ? undefined : verdicts.get(s.scenario_id)
      const unrunnable = s.unrunnable === null || s.unrunnable === undefined ? undefined : clip(typeof s.unrunnable === 'string' ? s.unrunnable : JSON.stringify(s.unrunnable), 120)

      return [
        `  ${s.scenario_id ?? '?'}`,
        [s.feature_id, s.class, s.category].filter(Boolean).join('/'),
        clip(s.title ?? '', 100),
        verdict ? `last: ${verdict.status} (${verdict.runId})` : 'never run',
        s.excluded ? 'EXCLUDED' : undefined,
        unrunnable ? `cannot run: ${unrunnable}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    }),
  ].join('\n')
}

type ChangeSet = { added?: unknown[]; changed?: unknown[]; removed?: unknown[] }

const changes = (label: string, set: ChangeSet | undefined): string | undefined => {
  const parts = (['added', 'changed', 'removed'] as const).flatMap(kind => {
    const n = Array.isArray(set?.[kind]) ? set![kind]!.length : 0

    return n > 0 ? [`${n} ${kind}`] : []
  })

  return parts.length === 0 ? undefined : `${label} ${parts.join(', ')}`
}

/**
 * `rook status --json` as a few lines. Each agent's `features`, `scenarios`
 * and `profiles` are what changed locally against upstream; `tree` is
 * `unsynced`, `clean`, `ahead`, `diverged`, `behind` or `unknown` (offline,
 * not clean); `runs` summarises the upstream run history.
 */
export function statusText(doc: unknown): string {
  type Agent = {
    local_id?: string
    name?: string
    tree?: string
    local_version_number?: number
    features?: ChangeSet
    scenarios?: ChangeSet
    profiles?: ChangeSet
    unfinished_runs?: number
    owed_runs?: number
  }
  type Last = { local_run_id?: string; name?: string; status?: string; passed?: number; failed?: number; unverifiable?: number; credits_charged?: number }
  const status = doc as { project_id?: string; offline?: boolean; agents?: Agent[]; runs?: { total?: number; running?: number; last?: Last } }
  const agents = Array.isArray(status?.agents) ? status.agents : []

  if (agents.length === 0) {
    return 'rook: no agents in this project yet — run `rook explore .`'
  }

  const last = status.runs?.last

  return [
    `rook project ${status.project_id ?? '?'}${status.offline ? ' (offline: sync state unknown)' : ''}`,
    ...agents.map(agent =>
      [
        `  ${agent.local_id ?? agent.name ?? '?'}`,
        agent.local_version_number === undefined ? undefined : `v${agent.local_version_number}`,
        `tree ${agent.tree ?? 'unknown'}`,
        changes('features', agent.features),
        changes('scenarios', agent.scenarios),
        changes('profiles', agent.profiles),
        agent.unfinished_runs ? `${agent.unfinished_runs} unfinished runs` : undefined,
        agent.owed_runs ? `${agent.owed_runs} runs owed upstream` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    ...(status.runs?.total === undefined ? [] : [`  runs: ${status.runs.total}${status.runs.running ? ` (${status.runs.running} running)` : ''}`]),
    ...(last === undefined
      ? []
      : [
          `  last: ${last.local_run_id ?? '?'}${last.name ? ` "${last.name}"` : ''} ${last.status ?? ''} — ` +
            `${last.passed ?? 0} Pass · ${last.failed ?? 0} Fail · ${last.unverifiable ?? 0} Unable to Verify` +
            `${last.credits_charged === undefined ? '' : ` · ${credits(last.credits_charged)}`}`,
        ]),
  ].join('\n')
}

/**
 * What an older rook prints for `generate --json`: prose, not a document.
 * `7 scenario(s) written, 0 already current, 2 the plan left alone, 553.12 credits`, then summary lines.
 */
function generateProse(stdout: string): string | undefined {
  const said = /(\d+) scenario\(s\) written(?:, (\d+) already current)?(?:, (\d+) the plan left alone)?(?:, (\d+(?:\.\d+)?) credits)?/.exec(stdout)

  if (said === null) {
    return undefined
  }

  const [line, written, current, declined, spent] = said
  const count = Number(written)
  const rest = stdout
    .split('\n')
    .map(text => text.trim())
    .filter(text => text !== '' && text !== line.trim() && !/^(on disk only|next:)/.test(text))

  return [
    `rook generate: ${plural(count, 'scenario file')} written` +
      `${Number(current ?? 0) > 0 ? `, ${plural(Number(current), 'feature')} already covered` : ''}` +
      `${Number(declined ?? 0) > 0 ? `, ${plural(Number(declined), 'feature')} the plan left alone` : ''}` +
      `${spent === undefined ? '' : ` · ${credits(Number(spent))}`}.`,
    ...rest.slice(0, 6).map(text => `  ${clip(text, 300)}`),
    ...(count > 0 ? ['Run the new scenarios with the rook run tool; the rook scenarios tool lists their ids.'] : []),
  ].join('\n')
}

/** `rook generate --json` in a few lines: what was written, what was left, and why. */
export function generateText(doc: unknown, stdout = ''): string {
  type Declined = { feature_id?: string; local_id?: string; reason?: string; why?: string }
  const result = doc as { written?: string[]; skipped?: string[]; declined?: Declined[]; gaps?: string[]; credits?: number; summaries?: string[] } | undefined

  if (!Array.isArray(result?.written)) {
    const prose = generateProse(stdout)

    if (prose !== undefined) {
      return prose
    }
  }

  const written = Array.isArray(result?.written) ? result.written : []
  const skipped = Array.isArray(result?.skipped) ? result.skipped : []
  const declined = Array.isArray(result?.declined) ? result.declined : []
  const gaps = Array.isArray(result?.gaps) ? result.gaps : []
  const summaries = Array.isArray(result?.summaries) ? result.summaries : []

  return [
    `rook generate: ${plural(written.length, 'scenario file')} written${skipped.length > 0 ? `, ${plural(skipped.length, 'feature')} already covered` : ''}` +
      `${result?.credits === undefined ? '' : ` · ${credits(result.credits)}`}.`,
    ...written.slice(0, 40).map(path => `  + ${path}`),
    ...(written.length > 40 ? [`  …and ${written.length - 40} more`] : []),
    ...summaries.slice(0, 6).map(line => `  ${clip(line, 300)}`),
    ...(declined.length > 0
      ? ['Features the planner decided need nothing:', ...declined.slice(0, 10).map(d => `  - ${d.feature_id ?? d.local_id ?? '?'}: ${clip(d.reason ?? d.why ?? '', 200)}`)]
      : []),
    ...(gaps.length > 0 ? ['Gaps the writers named (what these scenarios cannot cover):', ...gaps.slice(0, 10).map(gap => `  ? ${clip(gap, 240)}`)] : []),
    ...(written.length > 0 ? ['Run the new scenarios with the rook run tool; the rook scenarios tool lists their ids.'] : []),
  ].join('\n')
}

// ── setup: project, explore, profile ─────────────────────────────────────────

/** `rook profile add` needs the agent's connection details, which only the person has, and it can prompt: theirs to run. */
export const PROFILE_ADD_HINT =
  'A profile tells rook how to reach the agent, and only the person has those details: ask them to type ' +
  "`! rook profile add <name> --from connection.md` (a file with a curl, a spec or notes) or `! rook profile add <name> --command '<how the agent starts>'`. " +
  'rook writes the script, calls the agent once and keeps the profile if it answered.'

/** `rook project --json` (`{ projects: [{ project_id, name, active }] }`), or the plain listing an older rook prints. */
export function projectsText(doc: unknown, stdout: string): string {
  type Row = { project_id?: string; name?: string; active?: boolean }
  const listed = (doc as { projects?: Row[]; partial?: string | null } | undefined)?.projects
  const rows: Row[] = Array.isArray(listed)
    ? listed
    : stdout
        .split('\n')
        .map(line => /^([* ]) ([0-9A-Z]{26}) {2}(.+)$/.exec(line))
        .filter(match => match !== null)
        .map(match => ({ project_id: match[2], name: match[3]!.trim(), active: match[1] === '*' }))
  const partial = (doc as { partial?: string | null } | undefined)?.partial

  if (rows.length === 0) {
    return 'rook: no rook projects in this organisation yet. Create one with the rook project tool (action create, a name), or /rook project create <name>.'
  }

  const active = rows.find(row => row.active)

  return [
    `rook projects (${rows.length}${partial ? ', list incomplete' : ''})${active ? ` · active: ${active.name ?? active.project_id}` : ' · none selected'}`,
    ...rows.slice(0, 60).map(row => `${row.active ? '*' : ' '} ${row.project_id ?? '?'}  ${clip(row.name ?? '', 80)}`),
    ...(rows.length > 60 ? [`  …and ${rows.length - 60} more`] : []),
    ...(active ? [] : ['Select one with the rook project tool (action use, its id), or /rook project use <id>. explore and generate need one.']),
  ].join('\n')
}

/**
 * What `rook explore` found. Which agents exist, and how many features each
 * has, comes from the disk rook just wrote (`found`): its prose differs by
 * version (a table on newer builds, a line per agent on older ones). The prose
 * still gives the tally, where it wrote, and per-agent notes when it has them.
 */
export function exploreText(stdout: string, found?: readonly { id: string; features: number }[]): string {
  const lines = stdout.split('\n').map(line => line.trimEnd())
  const header = lines.findIndex(line => /^\s*AGENT\s+FEATURES\s+FINDINGS/.test(line))
  const notes = new Map<string, string>()

  // the table a newer rook prints: AGENT  FEATURES  FINDINGS  WORST  NOTE
  for (let at = header < 0 ? lines.length : header + 1; at < lines.length; at += 1) {
    const line = lines[at]!.trim()

    if (line === '') {
      break
    }

    if (/^─/.test(line)) {
      continue
    }

    const [agent = '?', features = '—', findings = '—', worst = '—', note] = line.split(/\s{2,}/)
    notes.set(agent, `${features} features · ${findings} findings${worst !== '—' ? ` (worst ${worst})` : ''}${note ? ` · ${note}` : ''}`)
  }

  // the line an older rook prints per agent it skipped: `<id>: unchanged, not re-analysed`
  for (const line of lines) {
    const skipped = /^\s*([A-Za-z0-9][\w.-]*): (unchanged, not re-analysed)\s*$/.exec(line)

    if (skipped && !notes.has(skipped[1]!)) {
      notes.set(skipped[1]!, skipped[2]!)
    }
  }

  const agents = found !== undefined
    ? found.map(agent => `  ${agent.id} — ${notes.get(agent.id) ?? `${plural(agent.features, 'feature')}`}`)
    : [...notes.entries()].map(([id, note]) => `  ${id} — ${note}`)
  const said = (pattern: RegExp) => lines.map(line => line.trim()).find(line => pattern.test(line))
  const tally = said(/^\d+ analysed, \d+ unchanged|^nothing changed —/)
  const written = said(/^written: /)
  const active = said(/^active agent: |agents registered — none selected/)

  if (agents.length === 0) {
    return [
      `rook explore found no agent in this repository${tally ? ` (${tally})` : ''}.`,
      "rook recognises an agent by its model calls. If the agent here receives its model from elsewhere, or lives in an unusual place, " +
        "re-run the rook explore tool with an instruction naming the file and entry point (e.g. 'the support agent in src/agent.ts, entry point handle'). It spends credits again.",
    ].join('\n')
  }

  return [
    `rook explore: ${plural(agents.length, 'agent')}${tally ? ` — ${tally}` : ''}`,
    ...agents,
    ...[written, active].filter((line): line is string => line !== undefined).map(line => `  ${line}`),
    'Next: write scenarios with the rook generate tool. Before a run the agent needs a profile. ' + PROFILE_ADD_HINT,
  ].join('\n')
}

/** `rook profile`: a plain listing (`* id  phases  name  unverified  needs VAR`), handed on as rook printed it. */
export function profilesText(stdout: string): string {
  const listing = stdout.replace(/\n{2,}/g, '\n').trimEnd()

  if (listing.trim() === '' || /none — rook profile add/.test(listing)) {
    return `rook: the active agent has no profiles yet. ${PROFILE_ADD_HINT}`
  }

  return [
    "rook profiles of the active agent (* is active; an unverified one cannot run until it passes a profile test; 'needs' names variables not set here):",
    excerpt(listing, 4000),
  ].join('\n')
}

/**
 * `rook profile test`: one call to the agent. rook says what came back in
 * prose (its `--json` prints no document): the verdict line and the reply on
 * stdout, what went wrong on stderr.
 */
export function profileTestText(profile: string | undefined, exitCode: number, stdout: string, stderr: string): string {
  const name = profile ?? 'the active profile'

  if (exitCode === 0) {
    const kept = stdout
      .split('\n')
      .filter(line => !/^\s*(next:|rook sync|rook run)\s/.test(line))
      .join('\n')

    return `rook profile test (${name}) — the agent answered:\n${excerpt(kept, 2500)}`
  }

  // ROOK_* variables are rook's to supply (ROOK_STATE_DIR, ROOK_SCENARIO_ID…): missing, it is rook's gap, not the person's.
  const rookOwned = /\bROOK_[A-Z_]+\b(?=[^\n]*\b(required|missing|not set|undefined)\b)/.exec(stderr)
  const said = stderr
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '' && line.trim() !== 'running…')
    .slice(-10)

  return [
    `rook profile test (${name}) failed${exitCode === 130 ? ' (interrupted)' : ''}:`,
    ...(said.length > 0 ? said.map(line => `  ${clip(line, 300)}`) : [`  rook exited ${exitCode}`]),
    ...(rookOwned
      ? [
          `${rookOwned[0]} is a variable rook hands the profile's scripts itself during a run, not one to set: \`rook profile test\` does not pass it, ` +
            'so a profile whose scripts keep state between steps cannot be checked this way. Check it with a one-scenario run instead ' +
            '(the rook run tool with only one scenario id and test: true). Do not set it with rook env set or edit the script.',
        ]
      : ['A missing variable: ask the person to run `! rook env set NAME <value>`. A script that is wrong: `! rook profile fix <id>` repairs it (spends credits).']),
  ].join('\n')
}

/** The agent's runs on disk, newest first: what Claude needs to name an older run for report, explain or rca. */
export function runsText(agentId: string, runs: readonly RunSummary[], total: number): string {
  if (runs.length === 0) {
    return `rook: agent ${agentId} has no runs yet.`
  }

  return [
    `rook runs of agent ${agentId} (${runs.length === total ? total : `newest ${runs.length} of ${total}`}), newest first:`,
    ...runs.map(run =>
      [
        `  ${run.runId}`,
        run.name ? `"${clip(run.name, 60)}"` : undefined,
        `${run.planned} planned`,
        run.finished && run.counts ? `${run.counts.pass} Pass · ${run.counts.fail} Fail · ${run.counts.unverifiable} Unable to Verify` : 'unfinished',
        credits(run.credits),
        run.isTest ? 'test (local only)' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    ),
    'Read one with the rook report tool and its run_id; rca: true explains it without calling the agent again.',
  ].join('\n')
}

// ── depth: rca on a finished run, agents, curation, the balance ─────────────

/** The line above a report that `rook report --rca` just explained. */
export function rcaLine(runId: string, outcome: { credits?: number; isReused: boolean }): string {
  return outcome.isReused
    ? `rook: run ${runId} was already explained at this agent version; nothing re-derived, no credits spent.`
    : `rook explained run ${runId}${outcome.credits === undefined ? '' : ` for ${credits(outcome.credits)}`} (the agent was not called again).`
}

/** The project's agents for the model, the active one marked. */
export function agentsText(agents: readonly { id: string; name: string; isActive: boolean }[]): string {
  if (agents.length === 0) {
    return 'rook: no agents in this project yet. Find them with the rook explore tool (rook explore .).'
  }

  return [
    `rook agents in this project (${agents.length}):`,
    ...agents.map(agent => `  ${agent.isActive ? '*' : ' '} ${agent.id}${agent.name !== agent.id ? `  ${agent.name}` : ''}${agent.isActive ? '  (active)' : ''}`),
    ...(agents.length > 1 ? ['Switch with the rook agent tool and `use`: runs, scenarios and reports follow the active agent.'] : []),
  ].join('\n')
}

/** `rook scenarios exclude|include --json`: `{ ok, verb, changed, unknown }`. */
export function curateText(doc: unknown): string {
  const result = doc as { verb?: string; changed?: unknown; unknown?: unknown } | undefined
  const verb = result?.verb === 'include' ? 'included' : 'excluded'
  const changed = Array.isArray(result?.changed) ? result.changed.map(String) : []
  const unknown = Array.isArray(result?.unknown) ? result.unknown.map(String) : []

  return [
    changed.length > 0 ? `rook: ${verb} ${changed.join(', ')}.` : `rook: nothing changed — already ${verb}.`,
    ...(unknown.length > 0 ? [`No such scenario here: ${unknown.join(', ')}.`] : []),
    ...(changed.length > 0 && verb === 'excluded' ? ['Excluded scenarios stay on disk and leave runs until included again.'] : []),
  ].join('\n')
}

/** `120.5 credits left`, or nothing when the balance is unknown. */
export const balanceText = (balance: number | null | undefined): string | undefined =>
  balance === null || balance === undefined ? undefined : `${credits(balance)} left`

/** A warning when the balance will not cover re-testing `count` scenarios at `rate` credits each. */
export function balanceWarning(balance: number | null | undefined, rate: number | undefined, count: number): string | undefined {
  if (balance === null || balance === undefined || rate === undefined || count <= 0 || balance >= rate * count) {
    return undefined
  }

  return (
    `Credit balance: ${credits(balance)}, less than the ~${credits(rate * count)} re-testing ${plural(count, 'scenario')} would take at this run's rate. ` +
    'Tell the person before starting another run.'
  )
}
