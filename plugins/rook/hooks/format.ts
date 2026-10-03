import type { RookRunView, RookScenarioRow, RookSnapshot, RookStale } from '../types'

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

export const credits = (value: number | undefined): string | undefined =>
  value === undefined ? undefined : `${Number(value.toFixed(2))} credits`

/** Rows that passed but carry gaps, plus every Unable to Verify. */
export const unlooked = (run: RookRunView): RookScenarioRow[] =>
  run.rows.filter(row => row.status === 'Unable to Verify' || row.gaps.length > 0)

export function statusLine(snapshot: RookSnapshot | null, isRunning: boolean): string | undefined {
  const run = snapshot?.latest

  if (run === undefined) {
    return isRunning ? 'rook ▸ starting' : undefined
  }

  const { pass, fail, unverifiable } = run.counts
  const score = `✓${pass} ✗${fail} ?${unverifiable}`

  if (!run.finished) {
    return `rook ▸ ${run.done}/${run.planned} · ${score}`
  }

  const previous = snapshot?.previous
  const delta = previous === undefined ? 0 : pass - previous.passed
  const trend = previous === undefined || delta === 0 ? '' : ` · ${delta > 0 ? '↑' : '↓'}${Math.abs(delta)} vs last`
  const gaps = unlooked(run).length

  return `rook ${score}${gaps > 0 ? ` · ${plural(gaps, 'gap')}` : ''}${trend}`
}

export const progressBar = (done: number, planned: number, width: number): string => {
  const cells = Math.max(4, width)
  const filled = planned <= 0 ? 0 : Math.min(cells, Math.round((done / planned) * cells))

  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`
}

/** One failing scenario as the model needs it to fix the agent. */
export function failureNote(row: RookScenarioRow, verdictPath: string): string {
  const head = `${row.id}${row.title ? ` — ${row.title}` : ''}${row.compromised ? ' [COMPROMISED]' : ''}`
  const criteria = row.failing.slice(0, 6).map(c =>
    [
      `  • ${c.id}: ${clip(c.criterion, 240)}`,
      `    expected: ${clip(c.expected, 240)}`,
      `    achieved: ${clip(c.achieved, 240)}`,
      ...(c.evidence ? [`    evidence: ${clip(c.evidence, 240)}`] : []),
    ].join('\n'),
  )

  return [head, ...(criteria.length > 0 ? criteria : [`  ${clip(row.summary, 400)}`]), `  verdict: ${verdictPath}`].join('\n')
}

export function failureContext(run: RookRunView, agentDir: string, agentId: string): string {
  const failed = run.rows.filter(row => row.status === 'Fail')
  const runDir = `${agentDir}/runs/${run.runId}`
  const notes = failed.slice(0, 10).map(row => failureNote(row, `${runDir}/scenarios/${row.id}/verdict.yaml`))
  const more = failed.length > 10 ? [`…and ${failed.length - 10} more failing scenarios in ${runDir}/scenarios/`] : []
  const gaps = unlooked(run)
    .slice(0, 8)
    .map(row => `  ? ${row.id}: ${row.reason ?? 'gap'}${row.gaps.length > 0 ? ` — ${clip(row.gaps.join('; '), 200)}` : ''}`)

  return [
    `rook run ${run.runId}${run.name ? ` (${run.name})` : ''} against agent ${agentId} finished: ` +
      `${run.counts.pass} Pass, ${run.counts.fail} Fail, ${run.counts.unverifiable} Unable to Verify.`,
    ...(run.headline ? [`Headline: ${clip(run.headline, 300)}`] : []),
    '',
    'Failing scenarios (criterion, expected vs achieved, quoted evidence):',
    ...notes,
    ...more,
    ...(gaps.length > 0
      ? ['', 'Not verified — Unable to Verify is not Fail; these are what nobody looked at:', ...gaps]
      : []),
    '',
    'Fix the agent where the evidence shows its behaviour is wrong. If a criterion itself looks wrong, say so rather than bending the agent to it. Re-test with the rook run tool, passing only the scenario ids you touched.',
  ].join('\n')
}

export function runSummary(run: RookRunView, agentDir: string, agentId: string, totalCredits?: number): string {
  if (run.counts.fail > 0) {
    return failureContext(run, agentDir, agentId) + (totalCredits === undefined ? '' : `\nSpent: ${credits(totalCredits)}.`)
  }

  const gaps = unlooked(run)

  return [
    `rook run ${run.runId} against agent ${agentId}: ${run.counts.pass} Pass, 0 Fail, ${run.counts.unverifiable} Unable to Verify` +
      ` (${run.done}/${run.planned} judged).`,
    ...(run.headline ? [`Headline: ${clip(run.headline, 300)}`] : []),
    ...(gaps.length > 0
      ? [
          'Pass, and here is what nobody looked at:',
          ...gaps.slice(0, 8).map(row => `  ? ${row.id}: ${row.reason ?? 'gap'}${row.gaps.length ? ` — ${clip(row.gaps.join('; '), 200)}` : ''}`),
        ]
      : []),
    ...(totalCredits === undefined ? [] : [`Spent: ${credits(totalCredits)}.`]),
    `Evidence: ${agentDir}/runs/${run.runId}/`,
  ].join('\n')
}

export function staleLine(stale: RookStale): string {
  const [first, ...rest] = stale.files
  const files = `${first ?? ''}${rest.length > 0 ? ` (+${rest.length})` : ''}`
  const reach = stale.isWholeAgent ? `all ${plural(stale.scenarios.length, 'scenario')} may be affected` : `${plural(stale.scenarios.length, 'scenario')} touch it`

  return `Agent changed since last run: ${files} · ${reach}`
}

export function retestPrompt(stale: RookStale): string {
  const ids = stale.scenarios.map(s => s.id)
  const scope = stale.isWholeAgent || ids.length === 0 ? 'every scenario' : `scenarios ${ids.join(', ')}`

  return (
    `The agent under test changed (${stale.files.join(', ')}). Use the rook run tool to re-test ${scope}` +
    `${stale.isWholeAgent || ids.length === 0 ? '' : ' (pass them as `only`)'}, then fix anything that fails, quoting rook's evidence.`
  )
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
