import { isMap, list, parseMap, str } from './yaml'
import type { YamlValue } from './yaml'

/**
 * Does the active profile point at production?
 *
 * rook invokes the agent under test the way a user would, and its writes are
 * real: rook cannot roll them back (README, "A note on safety": point it at
 * staging). A profile has no prod/staging field, so the guard reads what
 * names the target: `target.endpoint`, `target.domain`, `target.command`,
 * `target.server`, `hook_env` values, and the values of the variables the
 * profile declares under `env`, from `rook env set` or the process.
 *
 * Reasons name the field or variable and the marker, never the value: a
 * variable the profile declares may be a credential.
 */

export type Assessment = { isRisky: boolean; reasons: string[] }

const LOCAL = /(^|[^a-z0-9])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([^a-z0-9]|$)/i

export function markersOf(patterns: string): RegExp | undefined {
  const words = patterns
    .split(',')
    .map(word => word.trim().toLowerCase())
    .filter(word => /^[a-z0-9_-]+$/.test(word))

  return words.length === 0 ? undefined : new RegExp(`(?:^|[^a-z0-9])(${words.join('|')})(?:[^a-z0-9]|$)`, 'i')
}

const flat = (value: YamlValue | undefined): string[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value.flatMap(flat)
      : isMap(value)
        ? Object.values(value).flatMap(flat)
        : [String(value)]

/** The variable names the profile declares under `env`. */
export const declaredVariables = (profileText: string): string[] =>
  list(parseMap(profileText).env).flatMap(item => {
    const name = isMap(item) ? str(item.variable) : str(item)

    return name !== undefined && /^[A-Z_][A-Z0-9_]*$/i.test(name) ? [name] : []
  })

export function assess(profileText: string, variables: Readonly<Record<string, string>>, patterns: string): Assessment {
  const markers = markersOf(patterns)

  if (markers === undefined) {
    return { isRisky: false, reasons: [] }
  }

  const profile = parseMap(profileText)
  const target = isMap(profile.target) ? profile.target : {}
  const fields: [string, string[]][] = [
    ...(['endpoint', 'domain', 'command', 'server', 'url', 'base_url'] as const).map(
      key => [`profile target.${key}`, flat(target[key])] as [string, string[]],
    ),
    ['profile hook_env', flat(profile.hook_env)],
    ...Object.entries(variables).map(([name, value]) => [`${name}`, [value]] as [string, string[]]),
  ]

  const reasons: string[] = []

  for (const [label, values] of fields) {
    for (const value of values) {
      if (LOCAL.test(value)) {
        continue
      }

      const hit = markers.exec(value)

      if (hit) {
        reasons.push(`${label} mentions "${hit[1]!.toLowerCase()}"`)
        break
      }
    }
  }

  return { isRisky: reasons.length > 0, reasons }
}

const ROOK_BINARY = /^(?:.*\/)?rook$|^@testmuai\/rook(?:@\S+)?$/

/**
 * Whether a shell command starts a rook run, however it is wrapped: chained
 * (`rook run && rook report`), piped (`rook run|tee log`), terminated without
 * a space (`rook run;echo`), quoted inside `bash -c "…"`, run by path or via
 * `npx @testmuai/rook`. The command is cut at every shell separator, and in
 * each piece the first word after the rook binary that is not a flag decides.
 */
export function isRunCommand(command: string): boolean {
  const pieces = command.split(/\$\(|[;&|()\n`]/)

  return pieces.some(piece => {
    const words = piece
      .split(/\s+/)
      .map(word => word.replace(/^['"]+|['"]+$/g, ''))
      .filter(Boolean)

    return words.some((word, at) => ROOK_BINARY.test(word) && words.slice(at + 1).find(next => !next.startsWith('-')) === 'run')
  })
}
