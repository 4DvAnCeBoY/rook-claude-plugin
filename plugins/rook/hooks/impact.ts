import { isMap, parseMap, str, strings } from './yaml'
import type { Io } from './workspace'
import { SCENARIO_ID } from './workspace'

/**
 * Which scenarios a file edit touches.
 *
 * agent.yaml's `source.tracks` lists the files and folders the agent is made
 * of (a folder covers files added under it later). Each feature lists the
 * `sources` it was derived from, and each scenario names its `feature_id`.
 * So: tracked file → features citing it → their scenarios. A tracked file no
 * feature cites (a shared helper, a config) may affect any scenario, and is
 * reported as the whole agent rather than guessed at.
 */

export type AgentIndex = {
  tracks: string[]
  /** feature id → the sources it cites */
  features: Map<string, string[]>
  scenarios: { id: string; title: string; featureId?: string }[]
}

const yamlFiles = async (io: Io, dir: string) =>
  (await io.list(dir).catch(() => [])).filter(entry => entry.kind === 'file' && entry.name.endsWith('.yaml')).map(entry => entry.name)

export async function indexAgent(io: Io, agentDir: string): Promise<AgentIndex> {
  const agent = parseMap((await io.read(`${agentDir}/agent.yaml`)) ?? '')
  const source = isMap(agent.source) ? agent.source : {}
  const features = new Map<string, string[]>()

  for (const name of await yamlFiles(io, `${agentDir}/features`)) {
    const feature = parseMap((await io.read(`${agentDir}/features/${name}`)) ?? '')
    features.set(str(feature.id) ?? name.replace(/\.yaml$/, ''), strings(feature.sources))
  }

  const scenarios: AgentIndex['scenarios'] = []

  for (const name of await yamlFiles(io, `${agentDir}/scenarios`)) {
    const id = name.replace(/\.yaml$/, '')

    if (!SCENARIO_ID.test(id)) {
      continue
    }

    const scenario = parseMap((await io.read(`${agentDir}/scenarios/${name}`)) ?? '')

    if (scenario.excluded === true) {
      continue
    }

    const featureId = str(scenario.feature_id)
    scenarios.push({ id, title: str(scenario.title) ?? '', ...(featureId !== undefined && { featureId }) })
  }

  scenarios.sort((a, b) => a.id.localeCompare(b.id))

  return { tracks: strings(source.tracks).map(normalise), features, scenarios }
}

/** `./a//b/` → `a/b`, backslashes as slashes. */
export const normalise = (path: string): string =>
  path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/$/, '')

/** The path relative to `cwd`, or undefined when it lies outside it. */
export function relativeTo(cwd: string, path: string): string | undefined {
  const root = normalise(cwd)
  const file = normalise(path)

  if (!file.startsWith('/') && !/^[A-Za-z]:\//.test(file)) {
    return file.split('/').includes('..') ? undefined : file
  }

  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : undefined
}

export const isTracked = (index: AgentIndex, rel: string): boolean =>
  index.tracks.some(track => rel === track || rel.startsWith(`${track}/`))

/** A feature source cites the file when it names it as a path (`src/a.ts`, `src/a.ts:12`, `src/a.ts#L3`). */
const cites = (source: string, rel: string): boolean => {
  const at = source.indexOf(rel)

  if (at < 0) {
    return false
  }

  const before = at === 0 ? '' : source[at - 1]!
  const after = source[at + rel.length] ?? ''

  return !/[\w./-]/.test(before) && !/[\w-]/.test(after) && !(after === '.' && /[\w]/.test(source[at + rel.length + 1] ?? ''))
}

export type Impact = { scenarios: { id: string; title: string }[]; isWholeAgent: boolean }

export function impactOf(index: AgentIndex, rels: readonly string[]): Impact | undefined {
  const tracked = rels.filter(rel => isTracked(index, rel))

  if (tracked.length === 0) {
    return undefined
  }

  const citing = new Set<string>()
  let isWholeAgent = false

  for (const rel of tracked) {
    const features = [...index.features.entries()].filter(([, sources]) => sources.some(source => cites(source, rel)))

    if (features.length === 0) {
      isWholeAgent = true
    }

    for (const [id] of features) {
      citing.add(id)
    }
  }

  const pick = isWholeAgent ? index.scenarios : index.scenarios.filter(s => s.featureId !== undefined && citing.has(s.featureId))

  return { scenarios: pick.map(({ id, title }) => ({ id, title })), isWholeAgent }
}
