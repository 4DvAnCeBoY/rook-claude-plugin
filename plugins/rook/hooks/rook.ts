import { RUN_ID } from './workspace'

/**
 * Driving the rook CLI through its published headless contract: one JSON
 * document on stdout, prose on stderr, exit 0 for a finished command (a run
 * with failed scenarios included), 1 for anything else.
 */

export type RunRequest = {
  only?: string[]
  class?: 'functional' | 'non-functional' | 'adversarial'
  category?: string
  tags?: string[]
  profile?: string
  name?: string
  concurrency?: number
  /** A finished run whose work a new run carries forward. */
  resume?: string
  /** Continue this run in place; needs `phases`. */
  continueRun?: string
  phases?: string[]
  test?: boolean
  rca?: boolean
  /** Free text for rook's run planner, passed after `--`. */
  instruction?: string
}

export type GenerateRequest = {
  total?: number
  classes?: string[]
  categories?: string[]
  force?: boolean
  instruction?: string
}

/**
 * How rook's own tool calls (its explorer, judge, planner reading code or
 * running commands) are approved in a headless command: `--yes` approves every
 * one for that command; `--allow` rules approve only those, and rook declines
 * the rest.
 */
export type Approval = { allowRules: readonly string[] }

const CLASSES = ['functional', 'non-functional', 'adversarial'] as const
const PHASE_NAMES = ['prepare', 'open', 'execute', 'close', 'collect', 'judge'] as const
const SCENARIO = /^SC-\d{3,6}$/
const WORD = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const PROFILE = /^[\w.-]{1,64}$/
const CONTROL = /[\u0000-\u001f\u007f]/

const printable = (text: string, max: number) => text !== '' && text.length <= max && !text.startsWith('-') && !CONTROL.test(text)

/** `allowRules` as typed in settings: rules separated by `;` or new lines. */
export function allowRulesOf(text: string): string[] {
  return text
    .split(/[;\n]/)
    .map(rule => rule.trim())
    .filter(rule => rule !== '' && printable(rule, 200))
}

function approvalArgs(approval: Approval): string[] {
  return approval.allowRules.length === 0 ? ['--yes'] : approval.allowRules.flatMap(rule => ['--allow', rule])
}

function words(label: string, values: unknown, check: RegExp, max: number): string[] | { error: string } {
  if (!Array.isArray(values) || values.length === 0 || values.length > max) {
    return { error: `\`${label}\` must list between 1 and ${max} values` }
  }

  const bad = values.filter(value => typeof value !== 'string' || !check.test(value))

  return bad.length > 0 ? { error: `not valid ${label}: ${bad.slice(0, 5).map(String).join(', ')}` } : [...new Set(values as string[])]
}

function instructionArgs(instruction: unknown): string[] | { error: string } {
  if (instruction === undefined) {
    return []
  }

  const text = typeof instruction === 'string' ? instruction.replace(/\s+/g, ' ').trim() : ''

  return text === '' || text.length > 2000 || CONTROL.test(text) ? { error: 'instruction must be 1-2000 printable characters' } : ['--', text]
}

/**
 * The run flags the mod passes, checked one by one. Nothing a caller gives
 * reaches argv unchecked: a value is a scenario id, a known class or phase, a
 * plain word, a run id, a bounded number, or text without control characters
 * that does not begin with `-`; the instruction goes after `--`.
 */
export function runArgs(request: RunRequest, approval: Approval = { allowRules: [] }): { argv: string[] } | { error: string } {
  const argv = ['run', ...approvalArgs(approval), '--json']

  if (request.only !== undefined) {
    const ids = words('only', request.only, SCENARIO, 200)

    if ('error' in ids) {
      return { error: ids.error.replace('not valid only', 'not scenario ids (SC-001 form)') }
    }

    argv.push('--only', ids.join(','))
  }

  if (request.class !== undefined) {
    if (!CLASSES.includes(request.class)) {
      return { error: `class must be one of ${CLASSES.join(', ')}` }
    }

    argv.push('--class', request.class)
  }

  if (request.category !== undefined) {
    if (typeof request.category !== 'string' || !WORD.test(request.category)) {
      return { error: 'category must be one word: letters, digits, - or _' }
    }

    argv.push('--category', request.category)
  }

  if (request.tags !== undefined) {
    const tags = words('tags', request.tags, WORD, 20)

    if ('error' in tags) {
      return tags
    }

    argv.push('--tag', tags.join(','))
  }

  if (request.profile !== undefined) {
    if (typeof request.profile !== 'string' || !PROFILE.test(request.profile) || request.profile.startsWith('-')) {
      return { error: 'profile must be a profile id: letters, digits, ., - or _' }
    }

    argv.push('--profile', request.profile)
  }

  if (request.name !== undefined) {
    const name = typeof request.name === 'string' ? request.name.trim() : ''

    if (!printable(name, 120)) {
      return { error: 'name must be 1-120 printable characters and not start with -' }
    }

    argv.push('--name', name)
  }

  if (request.concurrency !== undefined) {
    if (!Number.isInteger(request.concurrency) || request.concurrency < 1 || request.concurrency > 8) {
      return { error: 'concurrency must be a whole number from 1 to 8' }
    }

    argv.push('--concurrency', String(request.concurrency))
  }

  if (request.resume !== undefined && request.continueRun !== undefined) {
    return { error: 'resume starts a new run and continueRun continues one in place: pass one of them' }
  }

  if (request.resume !== undefined) {
    if (typeof request.resume !== 'string' || !RUN_ID.test(request.resume)) {
      return { error: 'resume must be a run id (2026-09-28T15-54-56Z form)' }
    }

    argv.push('--resume', request.resume)
  }

  if (request.continueRun !== undefined) {
    if (typeof request.continueRun !== 'string' || !RUN_ID.test(request.continueRun)) {
      return { error: 'continueRun must be a run id (2026-09-28T15-54-56Z form)' }
    }

    if (request.phases === undefined) {
      return { error: 'continueRun needs phases: which phases to run against it, e.g. ["collect", "judge"]' }
    }

    argv.push('--run', request.continueRun)
  }

  if (request.phases !== undefined) {
    const phases = words('phases', request.phases, new RegExp(`^(${PHASE_NAMES.join('|')})$`), PHASE_NAMES.length)

    if ('error' in phases) {
      return { error: `${phases.error} (phases are ${PHASE_NAMES.join(', ')})` }
    }

    argv.push('--phases', phases.join(','))
  }

  if (request.test === true) {
    argv.push('--test')
  }

  if (request.rca === true) {
    argv.push('--rca')
  }

  const tail = instructionArgs(request.instruction)

  return 'error' in tail ? tail : { argv: [...argv, ...tail] }
}

/** `rook generate`: write scenarios for the active agent. */
export function generateArgs(request: GenerateRequest, approval: Approval = { allowRules: [] }): { argv: string[] } | { error: string } {
  const argv = ['generate', ...approvalArgs(approval), '--json']

  if (request.total !== undefined) {
    if (!Number.isInteger(request.total) || request.total < 1 || request.total > 500) {
      return { error: 'total must be a whole number from 1 to 500' }
    }

    argv.push('--total', String(request.total))
  }

  if (request.classes !== undefined) {
    const classes = words('classes', request.classes, /^(functional|non[-_]functional|adversarial)$/, 3)

    if ('error' in classes) {
      return classes
    }

    argv.push('--class', classes.join(','))
  }

  if (request.categories !== undefined) {
    const categories = words('categories', request.categories, WORD, 20)

    if ('error' in categories) {
      return categories
    }

    argv.push('--category', categories.join(','))
  }

  if (request.force === true) {
    argv.push('--force')
  }

  const tail = instructionArgs(request.instruction)

  return 'error' in tail ? tail : { argv: [...argv, ...tail] }
}

const RUN_OPTIONS = 'Use --only SC-001,SC-002 · --class · --category · --tag · --profile · --name · --concurrency · --resume · --test · --rca · -- <instruction>'

/** `/rook run --only SC-001,SC-002 --class adversarial --test -- focus on refunds` → a request. */
export function parseRunFlags(text: string): RunRequest | { error: string } {
  const dashes = text.search(/(^|\s)--(\s|$)/)
  const head = dashes < 0 ? text : text.slice(0, dashes)
  const instruction = dashes < 0 ? '' : text.slice(dashes).replace(/^\s*--/, '').trim()
  const words = head.trim() === '' ? [] : head.trim().split(/\s+/)
  const request: RunRequest = instruction === '' ? {} : { instruction }

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    const [flag, inline] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    const value = () => inline ?? words[++i]
    const list = () => (value() ?? '').split(',').filter(Boolean)

    switch (flag) {
      case '--only':
        request.only = list()
        break
      case '--class':
        request.class = value() as RunRequest['class']
        break
      case '--category':
        request.category = value()
        break
      case '--tag':
        request.tags = list()
        break
      case '--profile':
        request.profile = value()
        break
      case '--name':
        request.name = value()
        break
      case '--concurrency':
        request.concurrency = Number(value())
        break
      case '--resume':
        request.resume = value()
        break
      case '--run':
        request.continueRun = value()
        break
      case '--phases':
        request.phases = list()
        break
      case '--test':
        request.test = true
        break
      case '--rca':
        request.rca = true
        break
      default:
        if (SCENARIO.test(word)) {
          request.only = [...(request.only ?? []), word]
          break
        }

        return { error: `unknown run option: ${word}. ${RUN_OPTIONS}` }
    }
  }

  return request
}

/** `/rook generate --total 20 --class adversarial -- the new returns flow` → a request. */
export function parseGenerateFlags(text: string): GenerateRequest | { error: string } {
  const dashes = text.search(/(^|\s)--(\s|$)/)
  const head = dashes < 0 ? text : text.slice(0, dashes)
  const instruction = dashes < 0 ? '' : text.slice(dashes).replace(/^\s*--/, '').trim()
  const words = head.trim() === '' ? [] : head.trim().split(/\s+/)
  const request: GenerateRequest = instruction === '' ? {} : { instruction }

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    const [flag, inline] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    const value = () => inline ?? words[++i] ?? ''

    switch (flag) {
      case '--total':
        request.total = Number(value())
        break
      case '--class':
        request.classes = value().split(',').filter(Boolean)
        break
      case '--category':
        request.categories = value().split(',').filter(Boolean)
        break
      case '--force':
        request.force = true
        break
      default:
        return { error: `unknown generate option: ${word}. Use --total · --class · --category · --force · -- <what to cover>` }
    }
  }

  return request
}

export const CLI_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' }

/** `stdout` is kept for the few commands that answer in prose (`rook agent`, `rook report --rca`). */
export type CliResult = { exitCode: number; doc: unknown; stderr: string; stdout?: string }

/** The one JSON document a `--json` command prints, or undefined when it printed prose. */
export function jsonOf(stdout: string): unknown {
  const text = stdout.trim()

  if (text === '') {
    return undefined
  }

  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')

    if (start < 0 || end <= start) {
      return undefined
    }

    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

/** What went wrong, in rook's words: `error`, `reason`, then stderr's last line. */
export function failureOf(result: CliResult): string | undefined {
  const doc = result.doc as { ok?: boolean; error?: string; reason?: string; remedy?: string; discarded?: string } | undefined

  if (doc?.discarded) {
    return `the run was ${doc.discarded}${doc.reason ? `: ${doc.reason}` : ''} — nothing ran`
  }

  if (result.exitCode === 0 && doc?.ok !== false) {
    return undefined
  }

  const said = doc?.error ?? doc?.reason
  const last = result.stderr.trim().split('\n').filter(Boolean).pop()

  return `${said ?? last ?? `rook exited ${result.exitCode}`}${doc?.remedy ? ` (remedy: ${doc.remedy})` : ''}`
}

// ── setup from inside Claude Code: project, explore, profile ────────────────

/** rook project ids are ULIDs: 26 characters of Crockford base32. */
const PROJECT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

export type ProjectRequest = { action?: 'list' | 'use' | 'create'; id?: string; name?: string }

/**
 * `rook project` lists (there is no `list` subcommand), `use <id>` selects,
 * `create <name>` creates and selects. Only the listing takes `--json`, and a
 * rook from before it did refuses the flag, so the caller falls back to the
 * plain listing.
 */
export function projectArgs(request: ProjectRequest): { argv: string[] } | { error: string } {
  switch (request.action ?? 'list') {
    case 'list':
      return { argv: ['project', '--json'] }
    case 'use': {
      // Upper-cased: rook compares ids exactly, and a ULID is upper case.
      const id = typeof request.id === 'string' ? request.id.trim().toUpperCase() : ''

      return PROJECT_ID.test(id) ? { argv: ['project', 'use', id] } : { error: 'id must be a rook project id (26 characters, 01M0SG9C0FKZHP1B6JWJ05B9DD form)' }
    }
    case 'create': {
      const name = typeof request.name === 'string' ? request.name.replace(/\s+/g, ' ').trim() : ''

      return printable(name, 120) ? { argv: ['project', 'create', name] } : { error: 'name must be 1-120 printable characters and not start with -' }
    }
    default:
      return { error: 'action must be list, use or create' }
  }
}

export type ExploreRequest = { force?: boolean; instruction?: string }

/** `rook explore .`: find the agents in this repository and write their features. */
export function exploreArgs(request: ExploreRequest, approval: Approval = { allowRules: [] }): { argv: string[] } | { error: string } {
  const argv = ['explore', '.', ...approvalArgs(approval), '--json', ...(request.force === true ? ['--force'] : [])]
  const tail = instructionArgs(request.instruction)

  return 'error' in tail ? tail : { argv: [...argv, ...tail] }
}

export type ProfileRequest = { action?: 'list' | 'test' | 'use'; profile?: string; goal?: string }

/**
 * `rook profile` lists the active agent's profiles, `profile use <id>` makes
 * one active, `profile test [id]` calls the agent once through it. `profile
 * add` is not here: it needs connection details only the person has.
 */
export function profileArgs(request: ProfileRequest, approval: Approval = { allowRules: [] }): { argv: string[] } | { error: string } {
  const { profile } = request

  if (profile !== undefined && (typeof profile !== 'string' || !PROFILE.test(profile) || profile.startsWith('-'))) {
    return { error: 'profile must be a profile id: letters, digits, ., - or _' }
  }

  switch (request.action ?? 'test') {
    case 'list':
      return { argv: ['profile'] }
    case 'use':
      return profile === undefined ? { error: 'use needs the id of the profile to make active' } : { argv: ['profile', 'use', profile] }
    case 'test': {
      const argv = ['profile', 'test', ...(profile === undefined ? [] : [profile]), ...approvalArgs(approval), '--json']

      if (request.goal === undefined) {
        return { argv }
      }

      const goal = typeof request.goal === 'string' ? request.goal.replace(/\s+/g, ' ').trim() : ''

      return printable(goal, 500) ? { argv: [...argv, '--goal', goal] } : { error: 'goal must be 1-500 printable characters and not start with -' }
    }
    default:
      return { error: 'action must be list, test or use' }
  }
}

/** `/rook explore --force -- the billing agent` → a request. */
export function parseExploreFlags(text: string): ExploreRequest | { error: string } {
  const dashes = text.search(/(^|\s)--(\s|$)/)
  const head = dashes < 0 ? text : text.slice(0, dashes)
  const instruction = dashes < 0 ? '' : text.slice(dashes).replace(/^\s*--/, '').trim()
  const words = head.trim() === '' ? [] : head.trim().split(/\s+/)
  const request: ExploreRequest = instruction === '' ? {} : { instruction }

  for (const word of words) {
    if (word !== '--force') {
      return { error: `unknown explore option: ${word}. Use --force · -- <what to look for>` }
    }

    request.force = true
  }

  return request
}

// ── depth: rca on a finished run, agents, curation, the balance ─────────────

/**
 * `rook report <run> --rca`: explain a finished run's clusters (cause, whose
 * fault, a proposed diff) from its evidence, without calling the agent again.
 * The run id is always named, so a run that starts meanwhile is not the one explained.
 */
export function reportRcaArgs(runId: unknown, approval: Approval = { allowRules: [] }): { argv: string[] } | { error: string } {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
    return { error: 'run must be a run id (2026-09-28T15-54-56Z form)' }
  }

  return { argv: ['report', runId, '--rca', ...approvalArgs(approval), '--json'] }
}

/**
 * What `rook report --rca` printed. Under --rca it answers in prose, not a
 * document: the rendered report, then `<n> credits`. A run already explained
 * at the agent's current version is re-rendered for nothing.
 */
export function rcaOutcome(stdout: string): { credits?: number; isReused: boolean } {
  const isReused = /already explained at this version/.test(stdout)
  const said = [...stdout.matchAll(/^\s*(\d+(?:\.\d+)?) credits\s*$/gm)].pop()?.[1]

  return { isReused, ...(said !== undefined && !isReused && { credits: Number(said) }) }
}

/** An agent's local id: its directory name under the project. */
export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function agentUseArgs(id: unknown): { argv: string[] } | { error: string } {
  return typeof id === 'string' && AGENT_ID.test(id) ? { argv: ['agent', 'use', id] } : { error: 'agent must be an agent id: letters, digits, ., - or _' }
}

/** `rook agent` prints `* <id>  <name>` per agent, the active one starred; it has no --json. */
export function parseAgentList(stdout: string): { id: string; name: string; isActive: boolean }[] {
  return stdout.split('\n').flatMap(line => {
    const found = /^([* ]) (\S+)(?:\s{2,}(.*))?$/.exec(line.trimEnd())

    return found && AGENT_ID.test(found[2]!) ? [{ id: found[2]!, name: (found[3] ?? '').trim() || found[2]!, isActive: found[1] === '*' }] : []
  })
}

/**
 * `rook scenarios exclude|include <ids> --json`. `delete` is not offered: it
 * removes the files for good, so it stays a command the person types in a terminal.
 */
export function curateArgs(verb: unknown, ids: unknown): { argv: string[] } | { error: string } {
  if (verb === 'delete') {
    return {
      error:
        'delete removes scenario files permanently and is not offered here; exclude keeps them out of runs. ' +
        'To delete, the person runs `rook scenarios delete <ids>` in a terminal.',
    }
  }

  if (verb !== 'exclude' && verb !== 'include') {
    return { error: 'action must be exclude or include' }
  }

  const checked = words('ids', ids, SCENARIO, 200)

  return 'error' in checked ? { error: checked.error.replace('not valid ids', 'not scenario ids (SC-001 form)') } : { argv: ['scenarios', verb, ...checked, '--json'] }
}

/** `rook plan --json` → the credit balance; undefined when rook could not fetch it (its `credits: null`). */
export function balanceOf(doc: unknown): number | undefined {
  const value = (doc as { credits?: unknown } | undefined)?.credits

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
