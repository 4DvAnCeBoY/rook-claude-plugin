/**
 * Driving the rook CLI through its published headless contract: one JSON
 * document on stdout, prose on stderr, exit 0 for a finished command (a run
 * with failed scenarios included), 1 for anything else.
 */

export type RunRequest = {
  only?: string[]
  class?: 'functional' | 'non-functional' | 'adversarial'
  category?: string
  name?: string
  test?: boolean
  rca?: boolean
}

const CLASSES = ['functional', 'non-functional', 'adversarial'] as const
const SCENARIO = /^SC-\d{1,6}$/
const WORD = /^[a-z0-9][a-z0-9_-]{0,63}$/i

/**
 * The run flags the mod passes, checked one by one. Nothing a caller gives
 * reaches argv unchecked: a value is a scenario id, a known class, a plain
 * word, or a name without control characters, and nothing begins with `-`.
 */
export function runArgs(request: RunRequest): { argv: string[] } | { error: string } {
  const argv = ['run', '--yes', '--json']

  if (request.only !== undefined) {
    if (!Array.isArray(request.only) || request.only.length === 0 || request.only.length > 200) {
      return { error: '`only` must list between 1 and 200 scenario ids' }
    }

    const bad = request.only.filter(id => typeof id !== 'string' || !SCENARIO.test(id))

    if (bad.length > 0) {
      return { error: `not scenario ids (SC-001 form): ${bad.slice(0, 5).join(', ')}` }
    }

    argv.push('--only', [...new Set(request.only)].join(','))
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

  if (request.name !== undefined) {
    const name = typeof request.name === 'string' ? request.name.trim() : ''

    if (name === '' || name.length > 120 || name.startsWith('-') || /[\u0000-\u001f\u007f]/.test(name)) {
      return { error: 'name must be 1-120 printable characters and not start with -' }
    }

    argv.push('--name', name)
  }

  if (request.test === true) {
    argv.push('--test')
  }

  if (request.rca === true) {
    argv.push('--rca')
  }

  return { argv }
}

/** `/rook run --only SC-001,SC-002 --class adversarial --test` → a request. */
export function parseRunFlags(text: string): RunRequest | { error: string } {
  const words = text.trim() === '' ? [] : text.trim().split(/\s+/)
  const request: RunRequest = {}

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!
    const [flag, inline] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    const value = () => inline ?? words[++i]

    switch (flag) {
      case '--only':
        request.only = (value() ?? '').split(',').filter(Boolean)
        break
      case '--class':
        request.class = value() as RunRequest['class']
        break
      case '--category':
        request.category = value()
        break
      case '--name':
        request.name = value()
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

        return { error: `unknown run option: ${word}. Use --only SC-001,SC-002 · --class · --category · --name · --test · --rca` }
    }
  }

  return request
}

export const CLI_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' }

export type CliResult = { exitCode: number; doc: unknown; stderr: string }

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
