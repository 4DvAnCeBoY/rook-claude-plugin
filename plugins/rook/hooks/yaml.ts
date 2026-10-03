/**
 * A reader for the YAML subset rook writes: block maps and lists, plain and
 * quoted scalars, folded (`>`, `>-`) and literal (`|`, `|-`) blocks, and the
 * empty or one-line flow collections (`[]`, `{}`, `[a, b]`).
 *
 * A hooks module cannot import a package, and rook's files are written by one
 * serialiser with one style, so a subset is enough. Anything it does not
 * understand reads as a string rather than throwing: a panel that shows a raw
 * value beats one that shows nothing.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

type Line = { indent: number; text: string }

const isBlank = (text: string) => text.trim() === '' || text.trimStart().startsWith('#')

function toLines(source: string): Line[] {
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(text => text.trim() !== '---' && text.trim() !== '...')
    .map(text => ({ indent: text.length - text.trimStart().length, text: text.trimEnd() }))
}

/** `key: rest` where the key is plain or quoted; undefined when the line is not one. */
function splitKey(body: string): { key: string; rest: string } | undefined {
  const quoted = /^(['"])(.*?)\1:(?:\s+(.*))?$/.exec(body)

  if (quoted) {
    return { key: quoted[2] ?? '', rest: quoted[3] ?? '' }
  }

  const plain = /^([^\s'"#\-[{][^:#]*?|-[^\s][^:#]*?):(?:\s+(.*))?$/.exec(body)

  return plain ? { key: (plain[1] ?? '').trim(), rest: plain[2] ?? '' } : undefined
}

/** A quoted scalar read up to its own closing quote, so a comment after it cannot move the end. */
function quoted(body: string): string {
  const quote = body[0]
  let out = ''

  for (let at = 1; at < body.length; at += 1) {
    const c = body[at]!

    if (quote === "'" && c === "'") {
      if (body[at + 1] === "'") {
        out += "'"
        at += 1
        continue
      }

      return out
    }

    if (quote === '"' && c === '\\') {
      const next = body[at + 1] ?? ''
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      at += 1
      continue
    }

    if (quote === '"' && c === '"') {
      return out
    }

    out += c
  }

  return out
}

/** `a, "b, c", 'd'` → its items, commas inside quotes kept. */
function flowItems(body: string): string[] {
  const items: string[] = []
  let current = ''
  let quote = ''

  for (const c of body) {
    if (quote === '' && (c === '"' || c === "'")) {
      quote = c
    } else if (c === quote) {
      quote = ''
    }

    if (c === ',' && quote === '') {
      items.push(current)
      current = ''
    } else {
      current += c
    }
  }

  return current.trim() === '' && items.length === 0 ? [] : [...items, current]
}

export function scalar(raw: string): YamlValue {
  const trimmed = raw.trim()

  if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
    return quoted(trimmed)
  }

  const text = trimmed.replace(/\s+#.*$/, '').trim()

  if (text === '' || text === '~' || text === 'null') {
    return null
  }

  if (text === 'true' || text === 'false') {
    return text === 'true'
  }

  if (text === '[]') {
    return []
  }

  if (text === '{}') {
    return {}
  }

  if (text.startsWith('[') && text.endsWith(']')) {
    return flowItems(text.slice(1, -1)).map(part => scalar(part))
  }

  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(text)) {
    return Number(text)
  }

  return text
}

class Reader {
  private at = 0
  private readonly lines: Line[]

  constructor(lines: Line[]) {
    this.lines = lines
  }

  private skip(): void {
    while (this.at < this.lines.length && isBlank(this.lines[this.at]!.text)) {
      this.at += 1
    }
  }

  private peek(): Line | undefined {
    this.skip()

    return this.lines[this.at]
  }

  /** The body of a `>`/`|` block: every following line indented past `parent`. */
  private block(parent: number, style: string): string {
    const taken: string[] = []
    let floor = -1

    while (this.at < this.lines.length) {
      const line = this.lines[this.at]!

      if (line.text.trim() !== '' && line.indent <= parent) {
        break
      }

      if (line.text.trim() !== '' && floor < 0) {
        floor = line.indent
      }

      taken.push(line.text.trim() === '' ? '' : line.text.slice(Math.max(floor, 0)))
      this.at += 1
    }

    while (taken.length > 0 && taken[taken.length - 1] === '') {
      taken.pop()
    }

    if (style.startsWith('|')) {
      return taken.join('\n')
    }

    return taken.reduce((all, part) => (all === '' ? part : part === '' ? `${all}\n` : all.endsWith('\n') ? all + part : `${all} ${part}`), '')
  }

  /** A plain scalar that wraps onto following, deeper lines. */
  private continued(first: string, parent: number): YamlValue {
    const parts = [first]

    while (this.at < this.lines.length) {
      const line = this.lines[this.at]!

      if (line.text.trim() === '' || line.indent <= parent) {
        break
      }

      parts.push(line.text.trim())
      this.at += 1
    }

    return parts.length === 1 ? scalar(first) : parts.join(' ')
  }

  /** The value after `key:` at indent `indent`, whose rest of line is `rest`. */
  private valueAfter(rest: string, indent: number): YamlValue {
    if (/^[>|][-+]?\s*$/.test(rest.trim())) {
      return this.block(indent, rest.trim())
    }

    if (rest.trim() !== '' && !rest.trim().startsWith('#')) {
      return this.continued(rest, indent)
    }

    const next = this.peek()

    if (next === undefined) {
      return null
    }

    if (next.indent > indent) {
      return this.node(next.indent)
    }

    if (next.indent === indent && next.text.trimStart().startsWith('- ')) {
      return this.list(indent)
    }

    return null
  }

  node(indent: number): YamlValue {
    const first = this.peek()

    if (first === undefined) {
      return null
    }

    const body = first.text.trimStart()

    if (body === '-' || body.startsWith('- ')) {
      return this.list(indent)
    }

    if (splitKey(body)) {
      return this.map(indent)
    }

    this.at += 1

    return this.continued(body, indent - 1)
  }

  private list(indent: number): YamlValue[] {
    const items: YamlValue[] = []

    for (let line = this.peek(); line && line.indent === indent; line = this.peek()) {
      const body = line.text.trimStart()

      if (!(body === '-' || body.startsWith('- '))) {
        break
      }

      const rest = body.slice(1).trimStart()
      const inner = indent + (body.length - rest.length)

      if (rest === '') {
        this.at += 1
        const next = this.peek()
        items.push(next && next.indent > indent ? this.node(next.indent) : null)
        continue
      }

      if (splitKey(rest) && !/^['"]/.test(rest)) {
        // `- key: value` opens a map whose keys sit where `key` does.
        this.lines[this.at] = { indent: inner, text: `${' '.repeat(inner)}${rest}` }
        items.push(this.map(inner))
        continue
      }

      this.at += 1
      items.push(/^[>|][-+]?$/.test(rest) ? this.block(indent, rest) : this.continued(rest, indent))
    }

    return items
  }

  private map(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {}

    for (let line = this.peek(); line && line.indent === indent; line = this.peek()) {
      const pair = splitKey(line.text.trimStart())

      if (!pair) {
        break
      }

      this.at += 1
      out[pair.key] = this.valueAfter(pair.rest, indent)
    }

    return out
  }
}

/** Parses a YAML document of the subset above; an empty one is `null`. */
export function parseYaml(source: string): YamlValue {
  const reader = new Reader(toLines(source))

  return reader.node(0)
}

export type YamlMap = { [key: string]: YamlValue }

export const isMap = (value: YamlValue | undefined): value is YamlMap =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The map a document parses to, or an empty one for anything else. */
export const parseMap = (source: string): YamlMap => {
  try {
    const value = parseYaml(source)

    return isMap(value) ? value : {}
  } catch {
    return {}
  }
}

export const str = (value: YamlValue | undefined): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

export const num = (value: YamlValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const list = (value: YamlValue | undefined): YamlValue[] => (Array.isArray(value) ? value : [])

export const strings = (value: YamlValue | undefined): string[] =>
  list(value).flatMap(item => (typeof item === 'string' ? [item] : []))
