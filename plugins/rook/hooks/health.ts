import type { RookScenarioRow } from '../types'
import { isMap, parseMap, str } from './yaml'
import type { YamlValue } from './yaml'

/**
 * The Health tab's "What nobody looked at", made actionable: every gap the
 * latest run left grouped by why nobody could look, each with the remedy in
 * plain words, a prompt that hands the group to Claude, and a re-test.
 */

/** Why a scenario was not (fully) judged, from the most to the least specific. */
export type GapCause = 'agent_never_ran' | 'tool_calls' | 'not_observable' | 'undecidable' | 'unchecked'

export type GapGroup = {
  cause: GapCause
  /** A few words for the group's heading. */
  title: string
  /** What to do about it, in plain words. */
  remedy: string
  rows: RookScenarioRow[]
}

const ORDER: readonly GapCause[] = ['agent_never_ran', 'tool_calls', 'not_observable', 'undecidable', 'unchecked']

const TITLES: Record<GapCause, string> = {
  agent_never_ran: 'the agent never answered',
  tool_calls: "rook could not see the agent's tool calls",
  not_observable: 'the evidence was not observable',
  undecidable: 'the evidence did not settle it',
  unchecked: 'passed with parts unchecked',
}

const REMEDIES: Record<GapCause, string> = {
  agent_never_ran: "The scenario crashed before the agent answered: open its response.json (and hooks.json) to see why, fix the profile or the agent's start-up, then re-test.",
  tool_calls:
    "Nothing reported the agent's tool calls. Make the profile's collect step (or its execute hook) report them as calls: [{ name, arguments }], then re-test.",
  not_observable: 'The judge could not see what the criteria need. Have the profile capture it (a collect step that reads the resulting state), then re-test.',
  undecidable: "The evidence was there but did not decide the criterion. Capture sharper evidence or make the criterion concrete, without loosening what it checks.",
  unchecked: 'These passed, but rook could not check every part. Make the missing evidence observable so the pass means what it says.',
}

/** rook's words for a tool-call expectation nobody could check (judge.ts, unobservableCriteria). */
const TOOL_CALLS = /tool[- ]calls?|what the agent called|nothing reported the calls|proxy in front of the MCP/i

export function causeOf(row: RookScenarioRow): GapCause {
  if (row.reason === 'agent_never_ran') {
    return 'agent_never_ran'
  }

  if ([...row.gaps, ...row.unchecked].some(note => TOOL_CALLS.test(note))) {
    return 'tool_calls'
  }

  if (row.reason === 'not_observable' || row.reason === 'undecidable') {
    return row.reason
  }

  return row.status === 'Unable to Verify' ? 'not_observable' : 'unchecked'
}

/** The rows grouped by cause, in a fixed order, empty groups left out. */
export function gapGroups(rows: readonly RookScenarioRow[]): GapGroup[] {
  return ORDER.map(cause => ({ cause, title: TITLES[cause], remedy: REMEDIES[cause], rows: rows.filter(row => causeOf(row) === cause) })).filter(
    group => group.rows.length > 0,
  )
}

/** Every note rook left on a row, its gaps and its unchecked hints, without repeats. */
export function notesOf(row: RookScenarioRow): string[] {
  return [...new Set([...row.gaps, ...row.unchecked].map(note => note.trim()).filter(Boolean))]
}

const pathOf = (value: YamlValue | undefined): string | undefined => str(value) ?? (isMap(value) ? str(value.script) : undefined)

/** The scripts a profile's hooks run (`hooks.execute`, `hooks.collect`, …), as paths from the agent's directory. */
export function hookScripts(profileText: string, agentDir: string): string[] {
  let hooks: YamlValue | undefined

  try {
    hooks = parseMap(profileText).hooks
  } catch {
    return []
  }

  if (!isMap(hooks)) {
    return []
  }

  return Object.entries(hooks).flatMap(([phase, value]) => {
    const path = pathOf(value)

    return path === undefined ? [] : [`${phase}: ${path.startsWith('/') ? path : `${agentDir}/${path}`}`]
  })
}

export type UnverifiedAsk = {
  runId: string
  agentId: string
  agentDir: string
  group: GapGroup
  profileId?: string
  profileText?: string
}

/** What "Fix with Claude" hands Claude: the gaps, where the evidence is, and the profile to change. */
export function unverifiedPrompt(ask: UnverifiedAsk): string {
  const { group, agentDir, runId } = ask
  const runDir = `${agentDir}/runs/${runId}`
  const profilePath = ask.profileId === undefined ? undefined : `${agentDir}/profiles/${ask.profileId}.yaml`
  const scripts = ask.profileText === undefined ? [] : hookScripts(ask.profileText, agentDir)
  const ids = group.rows.map(row => row.id)

  return [
    `rook run ${runId} against agent ${ask.agentId}: ${ids.length} scenario${ids.length === 1 ? '' : 's'} where ${group.title}.`,
    `Run directory: ${runDir}`,
    '',
    ...group.rows.flatMap(row => [
      `${row.id}${row.title ? ` — ${row.title}` : ''} (${row.status}${row.reason ? `, ${row.reason}` : ''})`,
      ...notesOf(row).map(note => `  - ${note}`),
      `  verdict: ${runDir}/scenarios/${row.id}/verdict.yaml`,
      `  reply: ${runDir}/scenarios/${row.id}/response.json`,
      `  hooks: ${runDir}/scenarios/${row.id}/hooks.json`,
    ]),
    '',
    profilePath === undefined ? 'No active profile was found.' : `Active profile: ${profilePath}`,
    ...(scripts.length > 0 ? ['Its hook scripts:', ...scripts.map(script => `  ${script}`)] : profilePath === undefined ? [] : ['It runs no hook scripts yet.']),
    '',
    `What to do: ${group.remedy}`,
    group.cause === 'tool_calls' || group.cause === 'not_observable'
      ? "rook reads tool calls from a hook's result: an execute or collect hook that returns { calls: [{ name, arguments }] } (collect for a trace fetched after the turn) lands in hooks.json and the judge sees it."
      : '',
    '',
    'Make the evidence observable; do not weaken, delete or loosen any criterion or scenario to make it pass. ' +
      `When done, re-test with the rook run tool, passing only: ${ids.join(', ')}.`,
  ]
    .filter((line, at, lines) => line !== '' || (lines[at - 1] ?? '') !== '')
    .join('\n')
    .trim()
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The confirm bar's estimate: the latest run's credits per scenario times how many. */
export const estimateOf = (rate: number | undefined, count: number): { credits: number } | Record<string, never> =>
  rate === undefined ? {} : { credits: rate * count }

/** `pending`, or undefined as soon as `signal` aborts: a quiet child must not hold a cancel up. */
export function untilAborted<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (signal === undefined) {
    return pending
  }

  if (signal.aborted) {
    pending.catch(() => undefined)

    return Promise.resolve(undefined)
  }

  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => {
      pending.catch(() => undefined)
      resolve(undefined)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
