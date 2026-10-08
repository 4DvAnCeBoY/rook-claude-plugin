import type { RookJob, RookJobLane } from '../types'
import { clip } from './format'
import { diskFacts } from './readiness'
import { agentIdsOf, projectDirName, ROOT, SCENARIO_ID } from './workspace'
import type { Io } from './workspace'
import { parseMap, str } from './yaml'

/**
 * Progress for `rook generate` and `rook explore`, which run for minutes.
 *
 * Two sources, both pure here:
 *  - rook's streamed lines. Without `--verbose`, generate prints its plan
 *    (`plan: 7 scenario(s) across 3 feature(s)`, then `  F-001  4  happy_path 2,
 *    negative 2` per feature) and explore one line per agent (`<id>: 4
 *    features`, `<id>: unchanged, not re-analysed`). With `--verbose` (stderr)
 *    every subagent's start and end: `  · write_scenarios F-001 happy_path`,
 *    `  · write_scenarios done — …`. Both are parsed.
 *  - the disk: scenario files (generate) and feature files (explore) that
 *    appear or are rewritten while the job runs.
 */

/** The phases a lane moves through. */
export const PHASE = {
  planned: 'planned',
  planning: 'planning',
  writing: 'writing',
  checking: 'checking',
  scanning: 'finding agents',
  describing: 'describing',
  extracting: 'extracting features',
  done: 'done',
  unchanged: 'unchanged',
  failed: 'failed',
} as const

const FINISHED: ReadonlySet<string> = new Set([PHASE.done, PHASE.unchanged, PHASE.failed])

export const isLaneDone = (lane: RookJobLane): boolean => FINISHED.has(lane.phase)

/** Splits streamed chunks into whole lines; `flush` hands back the unterminated rest. */
export function lineSplitter(onLine: (line: string) => void): { push: (text: string) => void; flush: () => void } {
  let rest = ''

  return {
    push: text => {
      rest += text
      const lines = rest.split(/\r?\n/)
      rest = lines.pop() ?? ''
      for (const line of lines) {
        onLine(line)
      }
    },
    flush: () => {
      if (rest !== '') {
        const line = rest
        rest = ''
        onLine(line)
      }
    },
  }
}

export function newJob(kind: RookJob['kind'], label: string, startedAt: number, source: NonNullable<RookJob['source']>): RookJob {
  return { kind, label, startedAt, lanes: [], source }
}

function withLane(job: RookJob, id: string, change: Partial<RookJobLane>, now: number): RookJob {
  const at = job.lanes.findIndex(lane => lane.id === id)

  if (at < 0) {
    return { ...job, lanes: [...job.lanes, { id, label: '', phase: PHASE.planned, since: now, ...change }] }
  }

  const was = job.lanes[at]!
  const lane = { ...was, ...change, since: change.phase !== undefined && change.phase !== was.phase ? now : was.since }

  return { ...job, lanes: job.lanes.map((other, i) => (i === at ? lane : other)) }
}

/** A line that is part of the final `--json` document, not something rook said. */
const isJsonLine = (line: string): boolean => /^\s*[{}[\]"]/.test(line)

const ID = '[A-Za-z0-9][\\w.-]*'
const WRITERS = /^\s*· (write_scenarios|write_attacks) (F-\d+)\b\s*(.*)$/
const SUBAGENT_START = new RegExp(`^\\s*· (plan_scenarios|check_scenarios|find_agents|describe_agent|extract_features) (.*)$`)
const SUBAGENT_END = /^\s*· (\w+) (done|failed)\b(?: — (.*))?$/
const PLAN_TOTAL = /^plan: (\d+) scenario\(s\) across (\d+) feature\(s\)/
const PLAN_ENTRY = /^\s+(F-\d+)\s{2,}(\d+)\s{2,}(.+?)\s*$/
const PLAN_NONE = /^\s+(F-\d+)\s{2,}none\b/
const AGENT_FEATURES = new RegExp(`^(${ID}): (\\d+) features\\s*$`)
const AGENT_UNCHANGED = new RegExp(`^(${ID}): unchanged, not re-analysed\\s*$`)
const AGENT_REANALYSE = new RegExp(`^(${ID}): re-analysing`)

/** The lane a verbose start line names, and its phase. */
function startedLane(kind: RookJob['kind'], role: string, label: string): { id: string; phase: string; label: string } {
  switch (role) {
    case 'plan_scenarios':
      return { id: 'plan', phase: PHASE.planning, label }
    case 'check_scenarios':
      return { id: 'check', phase: PHASE.checking, label }
    case 'find_agents':
      return { id: 'scan', phase: PHASE.scanning, label: kind === 'explore' ? 'the repository' : label }
    case 'describe_agent':
      return { id: label.split(/\s+/)[0] || role, phase: PHASE.describing, label: '' }
    default:
      return { id: label.split(/\s+/)[0] || role, phase: PHASE.extracting, label: '' }
  }
}

/** Which lane a verbose role's end closes: the oldest still open in that role's phase. */
function endedLane(job: RookJob, role: string): RookJobLane | undefined {
  const phase =
    role === 'write_scenarios' || role === 'write_attacks'
      ? PHASE.writing
      : role === 'plan_scenarios'
        ? PHASE.planning
        : role === 'check_scenarios'
          ? PHASE.checking
          : role === 'find_agents'
            ? PHASE.scanning
            : role === 'describe_agent'
              ? PHASE.describing
              : role === 'extract_features'
                ? PHASE.extracting
                : undefined

  return phase === undefined ? undefined : job.lanes.filter(lane => lane.phase === phase).sort((a, b) => a.since - b.since)[0]
}

/** One line rook printed, folded into the job. */
export function jobFromLine(job: RookJob, raw: string, now: number): RookJob {
  const line = raw.replace(/\s+$/, '')

  if (line.trim() === '' || isJsonLine(line)) {
    return job
  }

  const said = { ...job, last: clip(line, 160) }
  let found: RegExpExecArray | null

  if ((found = PLAN_TOTAL.exec(line))) {
    return { ...said, planned: Number(found[1]), done: said.done ?? 0 }
  }

  if ((found = PLAN_NONE.exec(line))) {
    return said
  }

  if ((found = PLAN_ENTRY.exec(line))) {
    return withLane(said, found[1]!, { planned: Number(found[2]), label: clip(found[3]!, 60) }, now)
  }

  if ((found = WRITERS.exec(line))) {
    const id = found[2]!
    const lane = said.lanes.find(l => l.id === id)

    return withLane(said, id, { phase: PHASE.writing, ...(lane?.label ? {} : { label: found[3]!.trim() }) }, now)
  }

  if ((found = SUBAGENT_END.exec(line))) {
    const lane = endedLane(said, found[1]!)
    const isWriter = found[1] === 'write_scenarios' || found[1] === 'write_attacks'

    // A feature's writers are one per category: the lane stays `writing` until the disk says it is full.
    return lane === undefined || (isWriter && found[2] === 'done')
      ? said
      : withLane(said, lane.id, { phase: found[2] === 'done' ? PHASE.done : PHASE.failed }, now)
  }

  if ((found = SUBAGENT_START.exec(line))) {
    const lane = startedLane(job.kind, found[1]!, found[2]!.trim())

    return withLane(said, lane.id, { phase: lane.phase, ...(lane.label ? { label: lane.label } : {}) }, now)
  }

  if (job.kind === 'explore') {
    if ((found = AGENT_FEATURES.exec(line))) {
      return withLane(said, found[1]!, { phase: PHASE.done, label: `${found[2]} features` }, now)
    }

    if ((found = AGENT_UNCHANGED.exec(line))) {
      return withLane(said, found[1]!, { phase: PHASE.unchanged, label: 'not re-analysed' }, now)
    }

    if ((found = AGENT_REANALYSE.exec(line))) {
      return withLane(said, found[1]!, { phase: PHASE.describing }, now)
    }
  }

  return said
}

/** A file under the watched directory: its key (`SC-004`, `agent/F-001`), when it last changed, and whose it is. */
export type DiskEntry = { key: string; mtimeMs: number; owner?: string }

/** What the disk says the job has done so far: files new since it started, or rewritten by it. */
export function jobFromDisk(job: RookJob, before: ReadonlySet<string>, entries: readonly DiskEntry[], now: number): RookJob {
  const touched = entries.filter(entry => !before.has(entry.key) || entry.mtimeMs >= job.startedAt)
  const byOwner = new Map<string, number>()

  for (const entry of touched) {
    if (entry.owner !== undefined) {
      byOwner.set(entry.owner, (byOwner.get(entry.owner) ?? 0) + 1)
    }
  }

  let next: RookJob = { ...job, done: touched.length }

  for (const [owner, count] of byOwner) {
    const lane = next.lanes.find(l => l.id === owner)

    if (job.kind === 'generate') {
      const isFull = lane?.planned !== undefined && count >= lane.planned
      const phase = isFull ? PHASE.done : lane !== undefined && isLaneDone(lane) ? lane.phase : PHASE.writing

      next = withLane(next, owner, { done: count, phase }, now)
    } else {
      // Explore writes an agent's features one file at a time: extracting until rook says how many.
      next = withLane(next, owner, { done: count, ...(lane === undefined || !isLaneDone(lane) ? { phase: PHASE.extracting, label: `${count} features so far` } : {}) }, now)
    }
  }

  return next
}

/** `45s`, `2m10s`: whole seconds, for lines that redraw every second. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
}

/** The lanes worth drawing: those in flight first (oldest first), then the finished, newest first. */
export function shownLanes(job: RookJob, max = 8): { lanes: RookJobLane[]; hidden: number } {
  const open = job.lanes.filter(lane => !isLaneDone(lane)).sort((a, b) => a.since - b.since)
  const closed = job.lanes.filter(isLaneDone).sort((a, b) => b.since - a.since)
  const all = [...open, ...closed]

  return { lanes: all.slice(0, max), hidden: Math.max(0, all.length - max) }
}

/** `3/7` when the job knows both, `3 written` when only the count. */
export function countText(job: RookJob): string | undefined {
  const noun = job.kind === 'generate' ? 'scenarios' : 'feature files'

  if (job.planned !== undefined && job.planned > 0) {
    return `${job.done ?? 0}/${job.planned}`
  }

  return job.done !== undefined && job.done > 0 ? `${job.done} ${noun}` : undefined
}

/** The spinner while Claude waits on a generate or explore: `rook generate · F-003 writing · 3/7 · 2m10s`. */
export function jobSpinnerText(job: RookJob, now: number): string {
  const { lanes } = shownLanes(job, job.lanes.length)
  const lane = lanes.find(l => !isLaneDone(l))
  const more = lanes.filter(l => !isLaneDone(l)).length - 1
  const doing = lane === undefined ? undefined : `${lane.id} ${lane.phase}${more > 0 ? ` +${more}` : ''}`
  const count = countText(job)

  return [`rook ${job.kind}`, doing, count, elapsed(now - job.startedAt)].filter(Boolean).join(' · ')
}

const yamlEntries = async (io: Io, dir: string) => (await io.list(dir).catch(() => [])).filter(entry => entry.kind === 'file' && entry.name.endsWith('.yaml'))

/**
 * The agent's scenario files, each with the feature it tests. Only files the
 * job touched are opened, once each: `owners` remembers what was read.
 */
export async function scenarioEntries(io: Io, agentDir: string, before: ReadonlySet<string>, startedAt: number, owners: Map<string, string | undefined>): Promise<DiskEntry[]> {
  const entries: DiskEntry[] = []

  for (const file of await yamlEntries(io, `${agentDir}/scenarios`)) {
    const key = file.name.replace(/\.yaml$/, '')

    if (!SCENARIO_ID.test(key)) {
      continue
    }

    const mtimeMs = file.mtimeMs ?? 0

    if (before.has(key) && mtimeMs < startedAt) {
      entries.push({ key, mtimeMs })
      continue
    }

    if (!owners.has(key)) {
      owners.set(key, str(parseMap((await io.read(`${agentDir}/scenarios/${file.name}`)) ?? '').feature_id))
    }

    const owner = owners.get(key)
    entries.push({ key, mtimeMs, ...(owner !== undefined && { owner }) })
  }

  return entries
}

/** The agent's scenario ids on disk now, without opening a file: what a generate starts from. */
export async function scenarioKeys(io: Io, agentDir: string): Promise<string[]> {
  return (await yamlEntries(io, `${agentDir}/scenarios`)).map(file => file.name.replace(/\.yaml$/, '')).filter(key => SCENARIO_ID.test(key))
}

/** Every agent's feature files in the selected project, keyed `agent/F-001`. */
export async function featureEntries(io: Io): Promise<DiskEntry[]> {
  const facts = await diskFacts(io)
  const projects = (await io.list(`${ROOT}/projects`).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name)
  const project = projectDirName(projects, facts.projectId)

  if (project === undefined) {
    return []
  }

  const projectDir = `${ROOT}/projects/${project}`
  const entries: DiskEntry[] = []

  for (const agent of await agentIdsOf(io, projectDir)) {
    for (const file of await yamlEntries(io, `${projectDir}/agents/${agent}/features`)) {
      entries.push({ key: `${agent}/${file.name.replace(/\.yaml$/, '')}`, mtimeMs: file.mtimeMs ?? 0, owner: agent })
    }
  }

  return entries
}
