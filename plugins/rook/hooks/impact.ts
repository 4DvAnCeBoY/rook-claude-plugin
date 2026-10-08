import { isMap, list, parseMap, str, strings } from './yaml'
import type { YamlValue } from './yaml'
import type { Io } from './workspace'
import { SCENARIO_ID } from './workspace'

/**
 * Which scenarios a file edit touches.
 *
 * agent.yaml's `source.tracks` lists the files and folders the agent is made
 * of (a folder covers files added under it later). Each feature lists the
 * `sources` it was derived from, and each scenario names its `feature_id`.
 * So: tracked file → features citing it → their scenarios. A tracked file no
 * feature cites (a shared helper, a config) is narrowed by `reach` below
 * (imports one level, then the names it defines) and reported as the whole
 * agent only when nothing narrows it.
 */

export type AgentIndex = {
  tracks: string[]
  /** feature id → the sources it cites */
  features: Map<string, string[]>
  scenarios: {
    id: string
    title: string
    featureId?: string
    /** Its prose (goal, criteria, setup, why, tags), for matching the names a file defines. */
    text?: string
    /** The tools it expects called or not called (`calls[].tool`, `exercises.tools`). */
    tools?: string[]
  }[]
  /** feature id → its prose (story, behaviour, rules), for matching names. */
  featureText?: Map<string, string>
  /** feature id → the tools and functions it lists under `calls`. */
  featureTools?: Map<string, string[]>
}

const yamlFiles = async (io: Io, dir: string) =>
  (await io.list(dir).catch(() => [])).filter(entry => entry.kind === 'file' && entry.name.endsWith('.yaml')).map(entry => entry.name)

export async function indexAgent(io: Io, agentDir: string): Promise<AgentIndex> {
  const agent = parseMap((await io.read(`${agentDir}/agent.yaml`)) ?? '')
  const source = isMap(agent.source) ? agent.source : {}
  const features = new Map<string, string[]>()
  const featureText = new Map<string, string>()
  const featureTools = new Map<string, string[]>()

  for (const name of await yamlFiles(io, `${agentDir}/features`)) {
    const feature = parseMap((await io.read(`${agentDir}/features/${name}`)) ?? '')
    const id = str(feature.id) ?? str(feature.local_id) ?? name.replace(/\.yaml$/, '')
    features.set(id, strings(feature.sources))
    featureText.set(id, proseOf(feature))
    featureTools.set(id, strings(feature.calls).filter(call => NAME.test(call)))
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
    const exercises = isMap(scenario.exercises) ? scenario.exercises : {}
    const tools = [
      ...list(scenario.calls).flatMap(call => {
        const tool = isMap(call) ? str(call.tool) : undefined

        return tool === undefined ? [] : [tool]
      }),
      ...strings(exercises.tools),
    ].filter(tool => NAME.test(tool))

    scenarios.push({
      id,
      title: str(scenario.title) ?? '',
      ...(featureId !== undefined && { featureId }),
      text: proseOf(scenario),
      tools: [...new Set(tools)],
    })
  }

  scenarios.sort((a, b) => a.id.localeCompare(b.id))

  return { tracks: strings(source.tracks).map(normalise), features, scenarios, featureText, featureTools }
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

// ── narrowing: what an edit reaches when no feature cites the file ──────────

/** A tool or function name, as a scenario's `calls` lists it and a file defines it. */
const NAME = /^[A-Za-z_$][\w$.-]{1,63}$/

/** Keys whose values are ids, hashes or enums rather than prose that names things. */
const NOT_PROSE = new Set([
  'id',
  'local_id',
  'feature_id',
  'feature_revision_id',
  'sources',
  'origin',
  'class',
  'category',
  'check',
  'confidence',
  'input_kind',
  'output_kind',
  'source_plugins',
  'pattern_id',
])

/** Every string a parsed document holds outside the id-like keys, as one text. */
function proseOf(doc: YamlValue): string {
  const out: string[] = []
  const walk = (value: YamlValue, key?: string): void => {
    if (key !== undefined && NOT_PROSE.has(key)) {
      return
    }

    if (typeof value === 'string') {
      out.push(value)
    } else if (Array.isArray(value)) {
      value.forEach(item => walk(item))
    } else if (isMap(value)) {
      Object.entries(value).forEach(([k, v]) => walk(v, k))
    }
  }

  walk(doc)

  return out.join('\n')
}

/** Looks like code rather than a word: `get_policy`, `executeTurn`. */
const isCodeish = (name: string): boolean => name.length >= 4 && (/[A-Za-z0-9]_[A-Za-z0-9]/.test(name) || /[a-z][A-Z]/.test(name))

/**
 * The names a source file defines or speaks of: what it exports (functions,
 * classes, consts; `def` and `class` at the top level of a Python file) and
 * its identifier-like string literals (tool names such as `'transfer'`).
 */
export function namesIn(source: string): string[] {
  const names: string[] = []
  const add = (name: string | undefined) => {
    if (name !== undefined && NAME.test(name) && !names.includes(name)) {
      names.push(name)
    }
  }

  for (const m of source.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    add(m[1])
  }

  for (const m of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? '').split(',')) {
      part
        .trim()
        .split(/\s+as\s+/)
        .forEach(name => add(name.trim()))
    }
  }

  for (const m of source.matchAll(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
    add(m[1])
  }

  for (const m of source.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) {
    add(m[1])
  }

  for (const m of source.matchAll(/(['"`])([A-Za-z_][\w-]{2,63})\1/g)) {
    add(m[2])
  }

  return names
}

/**
 * The module specifiers a file imports: ES `import … from` / `export … from`,
 * `import()`, `require()`, and Python's `from x import` / `import x` (as `py:x`).
 */
export function importsIn(source: string): string[] {
  const out = new Set<string>()
  const add = (spec: string | undefined) => spec !== undefined && out.add(spec)

  for (const m of source.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) add(m[1])
  for (const m of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) add(m[1])
  for (const m of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1])
  for (const m of source.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\b/gm)) add(`py:${m[1]}`)
  for (const m of source.matchAll(/^\s*import\s+([\w.]+)\s*$/gm)) add(`py:${m[1]}`)

  return [...out]
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const stripExt = (path: string) => path.replace(/\.(m?[jt]sx?|c[jt]s|py)$/, '')

/** `a/b/../c` → `a/c`; undefined when it climbs above the root. */
function collapse(path: string): string | undefined {
  const out: string[] = []

  for (const part of path.split('/')) {
    if (part === '..') {
      if (out.length === 0) {
        return undefined
      }

      out.pop()
    } else if (part !== '' && part !== '.') {
      out.push(part)
    }
  }

  return out.join('/')
}

/** Whether `spec`, imported by the file `from`, names the file `target` (both relative to the workspace). */
export function importsFile(from: string, spec: string, target: string): boolean {
  const want = stripExt(target)
  const candidates: string[] = []

  if (spec.startsWith('py:')) {
    const dotted = spec.slice(3)
    const dots = /^\.*/.exec(dotted)?.[0].length ?? 0
    const rest = dotted.slice(dots).split('.').filter(Boolean).join('/')

    if (dots === 0) {
      candidates.push(rest, `${dirOf(from)}/${rest}`)
    } else {
      candidates.push([dirOf(from), ...Array.from({ length: dots - 1 }, () => '..'), rest].join('/'))
    }
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    candidates.push(`${dirOf(from)}/${spec}`)
  } else {
    return false // a package, not a file of this repository
  }

  return candidates.some(raw => {
    const path = collapse(raw)

    return path !== undefined && path !== '' && (stripExt(path) === want || `${path}/index` === want || `${path}/__init__` === want)
  })
}

/**
 * The path a feature source names: `src/a.ts:12`, `src/a.ts#L3` and
 * `src/a.ts: invoke('transfer')` → `src/a.ts`; prose is not a path.
 */
const pathOfSource = (source: string): string | undefined => {
  const head = source.trim().split(/:\s|\s/)[0] ?? ''
  const path = normalise(head.replace(/(#L\d+(-L?\d+)?|:\d+(-\d+)?)$/, ''))

  return /^[\w.@-][\w./@-]*\.\w+$/.test(path) && path.includes('/') ? path : undefined
}

/** One scenario an edit may reach, and why. */
export type Reached = { id: string; title: string; why: string }

/** What one edited file reaches. */
export type Reach = {
  file: string
  scenarios: Reached[]
  /** Nothing narrowed it (or everything matched): every scenario may be affected. */
  isWholeAgent: boolean
  /** How the set was chosen, in the band's words; absent when features cite the file. */
  reason?: string
}

const listed = (names: readonly string[], max = 3) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`)

const scenariosWord = (n: number) => `${n} scenario${n === 1 ? '' : 's'}`

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * `name` named in `text` as a whole word. A plain word (`transfer`) counts
 * only where it is written as code, `` `transfer` `` or `transfer(`, so prose
 * ("transfer USD 200") does not match.
 */
function mentions(text: string, name: string, isPlain: boolean): boolean {
  const n = escape(name)

  return isPlain ? new RegExp(`\`${n}\`|(^|[^\\w$])${n}\\(`).test(text) : new RegExp(`(^|[^\\w$])${n}($|[^\\w$])`).test(text)
}

/**
 * Which scenarios an edit to the tracked file `rel` reaches.
 *
 *  1. Features that cite the file: their scenarios, as `impactOf`.
 *  2. Otherwise narrowed: features citing a file that imports it (one level),
 *     and scenarios whose expected tool calls or prose, or their feature's,
 *     name what the file defines (exports, tool names in string literals).
 *  3. Nothing narrowed it: the whole agent, labelled why.
 *
 * `read` answers a workspace-relative path's text, undefined when absent.
 */
export async function reach(index: AgentIndex, rel: string, read: (path: string) => Promise<string | undefined>): Promise<Reach | undefined> {
  if (!isTracked(index, rel)) {
    return undefined
  }

  const scenariosOf = (featureIds: ReadonlySet<string>) => index.scenarios.filter(s => s.featureId !== undefined && featureIds.has(s.featureId))
  const citing = new Set([...index.features.entries()].filter(([, sources]) => sources.some(source => cites(source, rel))).map(([id]) => id))

  if (citing.size > 0) {
    return { file: rel, isWholeAgent: false, scenarios: scenariosOf(citing).map(s => ({ id: s.id, title: s.title, why: `${s.featureId} cites it` })) }
  }

  const whys = new Map<string, string[]>()
  const note = (id: string, why: string) => whys.set(id, [...(whys.get(id) ?? []), why])

  // One level of imports: a file some feature cites that imports this one.
  const cited = new Map<string, Set<string>>()

  for (const [featureId, sources] of index.features) {
    for (const path of sources.map(pathOfSource)) {
      if (path !== undefined && path !== rel) {
        cited.set(path, (cited.get(path) ?? new Set()).add(featureId))
      }
    }
  }

  const importers: string[] = []

  for (const [path, featureIds] of cited) {
    const text = await read(path)

    if (text !== undefined && importsIn(text).some(spec => importsFile(path, spec, rel))) {
      importers.push(path)

      for (const s of scenariosOf(featureIds)) {
        note(s.id, `${s.featureId} cites ${path}, which imports it`)
      }
    }
  }

  // Names: what the file defines, against what the scenarios and features name.
  const source = await read(rel)
  const known = new Set([...index.scenarios.flatMap(s => s.tools ?? []), ...[...(index.featureTools?.values() ?? [])].flat()])
  const names = source === undefined ? [] : namesIn(source).filter(name => known.has(name) || isCodeish(name))
  const matched: string[] = []

  for (const s of index.scenarios) {
    const featureText = s.featureId === undefined ? '' : (index.featureText?.get(s.featureId) ?? '')
    const featureTools = s.featureId === undefined ? [] : (index.featureTools?.get(s.featureId) ?? [])
    const tools: string[] = []
    const named: string[] = []

    for (const name of names) {
      const isPlain = !isCodeish(name)

      if ((s.tools ?? []).includes(name) || featureTools.includes(name)) {
        tools.push(name)
      } else if (mentions(s.text ?? s.title, name, isPlain) || mentions(featureText, name, isPlain)) {
        named.push(name)
      } else {
        continue
      }

      if (!matched.includes(name)) {
        matched.push(name)
      }
    }

    if (tools.length > 0) {
      note(s.id, `calls ${listed(tools)}`)
    }

    if (named.length > 0) {
      note(s.id, `names ${listed(named)}`)
    }
  }

  const all = index.scenarios.length
  const picked = index.scenarios.filter(s => whys.has(s.id)).map(s => ({ id: s.id, title: s.title, why: whys.get(s.id)!.join('; ') }))

  if (picked.length === 0) {
    const reason =
      source === undefined
        ? `no feature cites it: all ${scenariosWord(all)} may be affected`
        : `shared code, no scenario names what it defines: all ${scenariosWord(all)} may be affected`

    return { file: rel, isWholeAgent: true, reason, scenarios: index.scenarios.map(s => ({ id: s.id, title: s.title, why: 'whole agent' })) }
  }

  const isByTool = matched.some(name => known.has(name))
  const how = [
    ...(matched.length > 0 ? [`by ${isByTool ? 'tool names' : 'names'} ${listed(matched)}`] : []),
    ...(importers.length > 0 ? [`through ${listed(importers, 2)}, which import${importers.length === 1 ? 's' : ''} it`] : []),
  ].join(' and ')

  if (picked.length === all && all > 1) {
    return { file: rel, isWholeAgent: true, reason: `shared code: all ${scenariosWord(all)} matched ${how}`, scenarios: picked }
  }

  return { file: rel, isWholeAgent: false, reason: `shared code: matched ${scenariosWord(picked.length)} ${how}`, scenarios: picked }
}

/** Several edited files' reach as one: the union, or the whole agent when any file reaches it all. */
export function mergeReach(index: AgentIndex, reaches: readonly Reach[]): { files: string[]; scenarios: Reached[]; isWholeAgent: boolean; reason?: string } {
  const files = reaches.map(r => r.file)
  const whys = new Map<string, string[]>()

  for (const r of reaches) {
    for (const s of r.scenarios) {
      whys.set(s.id, [...(whys.get(s.id) ?? []), reaches.length > 1 ? `${r.file}: ${s.why}` : s.why])
    }
  }

  const isWholeAgent = reaches.some(r => r.isWholeAgent)
  const pool = isWholeAgent ? index.scenarios : index.scenarios.filter(s => whys.has(s.id))
  const scenarios = pool.map(s => ({ id: s.id, title: s.title, why: (whys.get(s.id) ?? ['whole agent']).join('; ') }))
  const labelled = reaches.filter(r => r.reason !== undefined)
  const whole = reaches.find(r => r.isWholeAgent)
  const reason =
    labelled.length === 0
      ? undefined
      : reaches.length === 1
        ? labelled[0]!.reason
        : whole !== undefined
          ? `${whole.file}: ${whole.reason}`
          : labelled.map(r => `${r.file}: ${r.reason}`).join('; ')

  return { files, scenarios, isWholeAgent, ...(reason !== undefined && { reason }) }
}
