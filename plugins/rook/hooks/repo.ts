import type { RookLens, RookReadiness, RookRepoFound } from '../types'
import { CONNECTION_FILES, profileAddCommand } from './setup'
import type { Io } from './workspace'

/**
 * A repository with no rook setup, read cheaply: what it holds that rook can
 * start from (agent code, a requirements doc, a connection doc, CI), and the
 * guided start built from that and the setup checklist. Nothing here takes `$`.
 *
 * The scan lists the top level, `src/` (and the other usual code folders) two
 * levels down, `docs/` and `.github/workflows/`; it reads only small code
 * files, a bounded number of them, and never the skipped folders.
 */

/** Never listed: dependencies, build output, virtual environments, VCS. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', '.next', '.testmuai', 'coverage', 'target'])

/** Top-level folders agent code usually lives in, walked two levels down. */
export const CODE_DIRS = ['src', 'app', 'agent', 'agents', 'lib'] as const

/** Entries looked at in all, listing included. */
export const MAX_ENTRIES = 300
/** Code files read at most. */
export const MAX_READS = 40
/** A file larger than this is not read. */
export const MAX_BYTES = 64_000
/** Agent files reported at most. */
const MAX_AGENTS = 5

type Entry = { name: string; kind: string; size?: number }

/** Agent SDKs, most specific first: LangGraph before LangChain, the Claude Agent SDK before the Anthropic SDK. */
export const SDKS: readonly { label: string; code: RegExp; dep: RegExp }[] = [
  { label: 'OpenAI Agents SDK', code: /@openai\/agents|\bopenai[-_]agents\b|\bfrom\s+agents\s+import\b/, dep: /@openai\/agents|\bopenai[-_]agents\b/ },
  { label: 'LangGraph', code: /\blanggraph\b/, dep: /\blanggraph\b/ },
  { label: 'LangChain', code: /\blangchain\b|@langchain\//, dep: /\blangchain\b|@langchain\// },
  { label: 'CrewAI', code: /\bcrewai\b/, dep: /\bcrewai\b/ },
  { label: 'AutoGen', code: /\bautogen(?:_agentchat|_core|_ext)?\b|@autogen/, dep: /\bautogen|\bpyautogen\b/ },
  { label: 'Claude Agent SDK', code: /\bclaude_agent_sdk\b|@anthropic-ai\/claude-agent-sdk/, dep: /\bclaude[-_]agent[-_]sdk\b/ },
  { label: 'Anthropic SDK', code: /@anthropic-ai\/sdk|\bimport\s+anthropic\b|\bfrom\s+anthropic\b/, dep: /@anthropic-ai\/sdk|(?:^|["'\s])anthropic(?:["'\s=<>~!\[;]|$)/m },
  { label: 'Mastra', code: /@mastra\//, dep: /@mastra\// },
  { label: 'LlamaIndex', code: /\bllama_index\b|\bllamaindex\b/, dep: /\bllama[-_]index\b|\bllamaindex\b/ },
]

const CODE_FILE = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/
const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile'] as const
const REQUIREMENTS_FILE = /^(prd|requirements)[\w.-]*\.md$/i
const CONNECTION_NAMES = new Set(CONNECTION_FILES.filter(name => name !== 'README.md').map(name => name.toLowerCase()))

/** The SDKs a file's text names, most specific first; LangChain is dropped beside LangGraph, the Anthropic SDK beside the Claude Agent SDK. */
export function sdksIn(text: string, kind: 'code' | 'dep' = 'code'): string[] {
  const found = SDKS.filter(sdk => sdk[kind].test(text)).map(sdk => sdk.label)

  return found.filter(
    label => !(label === 'LangChain' && found.includes('LangGraph')) && !(label === 'Anthropic SDK' && found.includes('Claude Agent SDK')),
  )
}

/** What changes when the repository's top level does: the cache key for a scan. */
export const listingKey = (entries: readonly { name: string; kind: string }[]): string =>
  entries
    .map(entry => `${entry.kind === 'dir' ? 'd' : 'f'}:${entry.name}`)
    .sort()
    .join('|')

const join = (dir: string, name: string): string => (dir === '.' || dir === '' ? name : `${dir}/${name}`)
const isSmall = (entry: Entry): boolean => entry.size === undefined || entry.size <= MAX_BYTES
const headings = (text: string): number => text.split('\n').filter(line => /^#{1,6}\s+\S/.test(line)).length

/**
 * One pass over the repository. `root` is the top level's listing when the
 * caller already has it (it keys the cache on it); listed here otherwise.
 */
export async function scanRepo(io: Io, root?: readonly Entry[]): Promise<RookRepoFound[]> {
  const top = [...(root ?? (await io.list('.').catch(() => [])))] as Entry[]
  let seen = top.length
  const code: { path: string; entry: Entry }[] = []
  const requirements: string[] = []
  const connection: string[] = []
  const ci: string[] = []
  const take = (entries: readonly Entry[]): Entry[] => {
    const room = Math.max(0, MAX_ENTRIES - seen)
    seen += Math.min(room, entries.length)

    return entries.slice(0, room)
  }

  for (const entry of top.slice(0, MAX_ENTRIES)) {
    if (entry.kind !== 'dir') {
      if (CODE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) code.push({ path: entry.name, entry })
      if (REQUIREMENTS_FILE.test(entry.name)) requirements.push(entry.name)
      if (CONNECTION_NAMES.has(entry.name.toLowerCase())) connection.push(entry.name)
    }
  }

  const dirNames = new Set(top.filter(entry => entry.kind === 'dir' && !SKIP_DIRS.has(entry.name)).map(entry => entry.name))

  // Code folders two levels down.
  for (const dir of CODE_DIRS.filter(name => dirNames.has(name))) {
    const level: { path: string; depth: number }[] = [{ path: dir, depth: 1 }]

    while (level.length > 0 && seen < MAX_ENTRIES) {
      const { path, depth } = level.shift()!

      for (const entry of take((await io.list(path).catch(() => [])) as Entry[])) {
        const child = join(path, entry.name)

        if (entry.kind === 'dir') {
          if (depth < 2 && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) level.push({ path: child, depth: depth + 1 })
        } else if (CODE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          code.push({ path: child, entry })
        }
      }
    }
  }

  if (dirNames.has('docs')) {
    for (const entry of take((await io.list('docs').catch(() => [])) as Entry[])) {
      if (entry.kind !== 'dir' && /prd/i.test(entry.name)) requirements.push(`docs/${entry.name}`)
    }
  }

  if (dirNames.has('.github') || top.some(entry => entry.name === '.github')) {
    for (const entry of take((await io.list('.github/workflows').catch(() => [])) as Entry[])) {
      if (entry.kind !== 'dir' && /\.ya?ml$/.test(entry.name)) ci.push(`.github/workflows/${entry.name}`)
    }
  }

  const found: RookRepoFound[] = []

  // Agent code: small code files, a bounded number of them, the shallowest first.
  let reads = 0

  for (const { path, entry } of code.sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    if (reads >= MAX_READS || found.length >= MAX_AGENTS) break
    if (!isSmall(entry)) continue

    reads += 1
    const text = await io.read(path).catch(() => undefined)

    if (text === undefined || text.length > MAX_BYTES) continue

    const sdks = sdksIn(text)

    if (sdks.length > 0) {
      found.push({ path, kind: 'agent', what: `an agent: ${sdks.slice(0, 2).join(', ')}` })
    }
  }

  // No code file named one: a dependency manifest that does still says where to look.
  if (found.length === 0) {
    for (const name of MANIFESTS.filter(name => top.some(entry => entry.name === name && entry.kind !== 'dir' && isSmall(entry)))) {
      const text = await io.read(name).catch(() => undefined)
      const sdks = text === undefined || text.length > MAX_BYTES ? [] : sdksIn(text, 'dep')

      if (sdks.length > 0) {
        found.push({ path: name, kind: 'agent', what: `depends on ${sdks.slice(0, 2).join(', ')}` })
      }
    }
  }

  for (const path of requirements) {
    const text = path.endsWith('.md') ? await io.read(path).catch(() => undefined) : undefined
    const count = text === undefined ? 0 : headings(text)

    found.push({ path, kind: 'requirements', what: count > 0 ? `requirements: ${count} heading${count === 1 ? '' : 's'}` : 'requirements' })
  }

  for (const path of connection) {
    found.push({ path, kind: 'connection', what: /^openapi/i.test(path) ? "the agent's API spec" : 'how to reach the agent' })
  }

  for (const path of ci) {
    const text = await io.read(path).catch(() => undefined)

    found.push({ path, kind: 'ci', what: text !== undefined && /\brook\b/.test(text) ? 'CI workflow (runs rook)' : 'CI workflow' })
  }

  return found
}

// ── the guided start ─────────────────────────────────────────────────────────

/** What a step's button does; register.tsx maps each to the setup tool, command or prompt that does it. */
export type StartActionKind =
  | 'recheck'
  | 'create-project'
  | 'pick-project'
  | 'pick-agent'
  | 'explore'
  | 'generate'
  | 'connection'
  | 'add-profile'
  | 'use-profile'
  | 'fill-env'
  | 'test-profile'
  | 'first-run'

export type StartAction = {
  kind: StartActionKind
  label: string
  /** Spends credits: it waits behind the confirm bar. */
  spends?: true
  /** What the action needs: a project name, an instruction, a profile id, a command to put in the prompt. */
  arg?: string
}

export type StartStep = {
  id: string
  label: string
  ok: boolean
  /** The exact line to type, when there is one. */
  command?: string
  action?: StartAction
  /** A second way, drawn beside the first. */
  other?: StartAction
}

export type StartFacts = {
  readiness: RookReadiness | undefined
  found: readonly RookRepoFound[]
  lens: RookLens
  /** The name a new project gets: this folder's. */
  folder: string
  /** With an agent: the profiles on disk and the active one as the Setup tab reads them. */
  profiles?: readonly { id: string; isActive: boolean; isVerified: boolean; unset: readonly string[] }[]
  connectionFile?: string
  /** With an agent: runs on disk and scenarios it has. */
  runCount?: number
  scenarios?: number
}

/** The command a readiness hint names: its first `quoted` part. */
const commandOf = (hint: string | undefined): string | undefined => (hint === undefined ? undefined : /`([^`]+)`/.exec(hint)?.[1])

export const envSetLine = (names: readonly string[]): string => `! rook env set '{${names.map(name => `"${name}":"…"`).join(',')}}'`

/** What explore is told about where the agent lives, from the scan. */
export function exploreInstruction(found: readonly RookRepoFound[]): string | undefined {
  const agents = found.filter(item => item.kind === 'agent')

  return agents.length === 0 ? undefined : `The agent is in ${agents.map(item => `${item.path} (${item.what.replace(/^an agent: |^depends on /, '')})`).join(', ')}.`
}

/** What generate is asked to cover: the requirements doc for a QE, the agent's tools and code for a developer. */
export function generatePlan(lens: RookLens, found: readonly RookRepoFound[]): { label: string; instruction: string } {
  const doc = found.find(item => item.kind === 'requirements')
  const code = found.filter(item => item.kind === 'agent').map(item => item.path)

  if (lens === 'qe' && doc !== undefined) {
    return {
      label: `Generate scenarios from ${doc.path}`,
      instruction: `Cover the requirements in ${doc.path}: each requirement as functional scenarios, and the adversarial cases they imply.`,
    }
  }

  return {
    label: "Generate scenarios from the agent's tools",
    instruction: `Cover the agent's tools and code paths${code.length > 0 ? ` (${code.join(', ')})` : ''}: each tool's normal use, its failure modes, and misuse.`,
  }
}

/**
 * Every step from nothing to the first run, the first one not done being the
 * next. The checklist's six, then, once there is an agent with an active
 * profile: its variables set, the profile tested (one call, no scenarios),
 * and the first run.
 */
export function startSteps(facts: StartFacts): StartStep[] {
  const { readiness, found, lens, folder } = facts
  const steps: StartStep[] = []

  for (const step of readiness?.steps ?? []) {
    const base = { id: step.id, label: step.label, ok: step.ok }

    if (step.ok) {
      steps.push(base)
      continue
    }

    const command = commandOf(step.hint)

    switch (step.id) {
      case 'installed':
      case 'signed_in':
        steps.push({ ...base, ...(command !== undefined && { command: command.startsWith('!') ? command : `! ${command}` }), action: { kind: 'recheck', label: 'Check again' } })
        break
      case 'project': {
        const name = folder.trim() === '' ? 'my agent' : folder.trim().slice(0, 120)

        steps.push(
          step.label.startsWith('no project')
            ? {
                ...base,
                command: `/rook project create ${name}`,
                action: { kind: 'create-project', label: `Create project “${name}”`, arg: name },
                other: { kind: 'pick-project', label: 'Pick one of mine' },
              }
            : { ...base, command: '/rook project', action: { kind: 'pick-project', label: 'Pick another project' } },
        )
        break
      }
      case 'agent':
        steps.push(
          step.label.startsWith('no active agent')
            ? { ...base, ...(command !== undefined && { command }), action: { kind: 'pick-agent', label: 'Pick the agent' } }
            : {
                ...base,
                command: '/rook explore',
                action: { kind: 'explore', label: 'Explore the agent', spends: true, ...(exploreInstruction(found) !== undefined && { arg: exploreInstruction(found) }) },
              },
        )
        break
      case 'scenarios': {
        const plan = generatePlan(lens, found)

        steps.push({ ...base, command: `/rook generate -- ${plan.instruction}`, action: { kind: 'generate', label: plan.label, spends: true, arg: plan.instruction } })
        break
      }
      case 'profile': {
        const first = facts.profiles?.[0]
        const file = facts.connectionFile ?? found.find(item => item.kind === 'connection')?.path

        if (first !== undefined) {
          steps.push({ ...base, command: `/rook profile use ${first.id}`, action: { kind: 'use-profile', label: `Use ${first.id}`, arg: first.id } })
        } else if (file !== undefined) {
          const line = profileAddCommand(file)

          steps.push({ ...base, command: line, action: { kind: 'add-profile', label: 'Put it in the prompt', arg: line } })
        } else {
          steps.push({ ...base, command: profileAddCommand(undefined), action: { kind: 'connection', label: 'Write connection.md with Claude' } })
        }
        break
      }
      default:
        steps.push({ ...base, ...(command !== undefined && { command }) })
    }
  }

  const active = facts.profiles?.find(profile => profile.isActive)

  if (facts.runCount !== undefined && active !== undefined) {
    if (active.unset.length > 0) {
      const line = envSetLine(active.unset)

      steps.push({ id: 'env', label: `${active.unset.join(', ')} unset for ${active.id}`, ok: false, command: line, action: { kind: 'fill-env', label: 'Put it in the prompt', arg: line } })
    }

    steps.push(
      active.isVerified
        ? { id: 'verify', label: `${active.id} answered`, ok: true }
        : {
            id: 'verify',
            label: `${active.id} not tested yet`,
            ok: false,
            command: `/rook profile test ${active.id}`,
            action: { kind: 'test-profile', label: `Test ${active.id}: one call`, spends: true, arg: active.id },
          },
    )
  }

  if (facts.runCount !== undefined) {
    const count = facts.scenarios ?? 0

    steps.push(
      facts.runCount > 0
        ? { id: 'run', label: `${facts.runCount} run${facts.runCount === 1 ? '' : 's'}`, ok: true }
        : {
            id: 'run',
            label: 'no runs yet',
            ok: false,
            command: '/rook run',
            action: { kind: 'first-run', label: count > 0 ? `First run: ${count} scenario${count === 1 ? '' : 's'}` : 'First run', spends: true },
          },
    )
  }

  return steps
}

export const nextStep = (steps: readonly StartStep[]): StartStep | undefined => steps.find(step => !step.ok)

/** The prompts the guided start hands Claude, for steps only Claude (or the person) can do. */
export const START_PROMPTS = {
  'pick-project':
    'List my rook projects with the rook project tool and help me pick the one this repository should record to; select it with action use. Create a new one only if I ask.',
  'pick-agent': "List this rook project's agents with the rook agent tool and make the one built in this repository the active one.",
  connection:
    'Write connection.md in the repository root so rook can reach the agent in this repository: how it is started or called (a curl against its endpoint, ' +
    'or the command that starts it), the request and response shape, and the names of any environment variables it needs (never their values). ' +
    'Then tell me to type `! rook profile add http --from connection.md`.',
} as const
