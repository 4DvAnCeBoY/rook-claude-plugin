import type { On, RenderInput, SessionStartInput } from 'claude-code'

import { CWD, HOME } from './workspace'

/**
 * The world beneath the plugin, in memory: a file tree `$.fs` reads, a fake
 * `rook` binary `$.process` runs, and a record of everything the plugin asked
 * the engine to do.
 */
export type World = {
  files: Map<string, string>
  opened: string[]
  /** Every `$.ui.open`, with whether it asked for the keyboard. */
  opens: { id: string; focus?: boolean }[]
  toasts: string[]
  statuses: (string | undefined)[]
  appended: string[]
  submitted: string[]
  commands: string[]
  tools: string[]
  /** argv of every rook invocation */
  invocations: string[][]
  /** The environment each spawned rook was given, beside its argv. */
  spawnEnvs: Record<string, string>[]
  /** What the fake `rook run` does: write files, then print this document. */
  onRun: (argv: readonly string[]) => { stdout: string; code: number; stderr?: string; writes?: Record<string, string> }
  status: { stdout: string; code: number }
  /** A per-argv answer for a short command; `status` answers whatever this leaves undefined. */
  answer: (argv: readonly string[]) => { stdout: string; code: number; stderr?: string } | undefined
  /** Answers for one short command, by its words after `rook` (`agent use`, `scenarios exclude`): the longest match wins over `status`. */
  replies: Record<string, { stdout: string; code: number; writes?: Record<string, string> }>
  /**
   * `rook plan --json`. Balance checks are counted here rather than in
   * `invocations`, so a test about what ran stays about what ran.
   */
  plan: { stdout: string; code: number }
  planChecks: number
  /** When set, `$.process` cannot start the binary at all. */
  isMissingBinary: boolean
  /** Called while a spawned rook is running, before it prints. */
  during: (() => Promise<void>) | undefined
  /** `rook --version` and `rook auth status`: the readiness probes, kept out of `invocations`. */
  version: { stdout: string; code: number }
  auth: { stdout: string; code: number }
  probes: string[][]
}

const relOf = (path: string) => (path.startsWith(`${CWD}/`) ? path.slice(CWD.length + 1) : path.replace(/^\.\//, ''))

export function worldOf(on: On, files: Readonly<Record<string, string>>, env: Readonly<Record<string, string>> = { HOME }): World {
  const world: World = {
    files: new Map(Object.entries(files)),
    opened: [],
    opens: [],
    toasts: [],
    statuses: [],
    appended: [],
    submitted: [],
    commands: [],
    tools: [],
    invocations: [],
    spawnEnvs: [],
    onRun: () => ({ stdout: JSON.stringify({ ok: true, halted: false, credits: 0 }), code: 0 }),
    status: { stdout: JSON.stringify({ project_id: 'P', offline: false, agents: [] }), code: 0 },
    answer: () => undefined,
    replies: {},
    plan: { stdout: JSON.stringify({ username: 'dev', subscription: 'Team', credits: 120.5 }), code: 0 },
    planChecks: 0,
    isMissingBinary: false,
    during: undefined,
    version: { stdout: 'rook 0.1.0\n', code: 0 },
    auth: { stdout: 'signed in as dev · Example Org · team\n', code: 0 },
    probes: [],
  }

  on('fs.read', ($, e) => {
    const text = world.files.get(relOf(e.path))

    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })

  on('fs.list', ($, e) => {
    const dir = e.path === CWD || e.path === `${CWD}/` ? '.' : relOf(e.path ?? '')
    const names = new Map<string, 'file' | 'dir'>()
    // `.`: the repository's top level, everything not under an absolute path
    const prefix = dir === '.' ? '' : `${dir}/`

    for (const file of world.files.keys()) {
      if (file.startsWith(prefix) && !(prefix === '' && file.startsWith('/'))) {
        const rest = file.slice(prefix.length)
        names.set(rest.split('/')[0] ?? '', rest.includes('/') ? 'dir' : 'file')
      }
    }

    return {
      value: [...names.entries()].sort().map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
    }
  })

  on('env.get', ($, e) => ({ value: env[e.name] }))

  on('process.run', ($, e) => {
    // Missing from PATH: the bare name does not start; a full path to a file on the disk does.
    if (world.isMissingBinary && !(e.argv[0]?.startsWith('/') && world.files.has(e.argv[0]))) {
      return { deny: `ENOENT: ${e.argv[0]}` }
    }

    if (e.argv[1] === '--version' || e.argv[1] === 'auth') {
      world.probes.push([...e.argv])
      const probe = e.argv[1] === 'auth' ? world.auth : world.version

      return { value: { exitCode: probe.code, stdout: probe.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    const words = e.argv.slice(1).join(' ')

    if (words === 'plan --json') {
      world.planChecks += 1

      return { value: { exitCode: world.plan.code, stdout: world.plan.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    world.invocations.push([...e.argv])
    const key = Object.keys(world.replies)
      .filter(prefix => words === prefix || words.startsWith(`${prefix} `))
      .sort((a, b) => b.length - a.length)[0]
    const reply: { stdout: string; code: number; stderr?: string; writes?: Record<string, string> } =
      world.answer(e.argv) ?? (key === undefined ? world.status : world.replies[key]!)

    for (const [path, text] of Object.entries(reply.writes ?? {})) {
      world.files.set(path, text)
    }

    return { value: { exitCode: reply.code, stdout: reply.stdout, stderr: reply.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('process.spawn', async function* ($, e) {
    world.invocations.push([...e.argv])
    world.spawnEnvs.push({ ...((e as { env?: Record<string, string> }).env ?? {}) })
    const ran = world.onRun(e.argv)

    for (const [path, text] of Object.entries(ran.writes ?? {})) {
      world.files.set(path, text)
    }

    await world.during?.()
    yield { stream: 'stderr' as const, text: 'running…\n' }
    if (ran.stderr !== undefined) {
      yield { stream: 'stderr' as const, text: ran.stderr }
    }
    if (ran.stdout !== '') {
      yield { stream: 'stdout' as const, text: ran.stdout }
    }

    // `rook ui --local` serves until it is stopped
    if (e.argv[1] === 'ui') {
      await new Promise(() => undefined)
    }

    return { value: { code: ran.code, signal: null } } as never
  })

  on('command.register', ($, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })

  on('tool.register', ($, e) => {
    world.tools.push(e.name)

    return { value: { tool: `mcp__rook__${e.name}` } }
  })

  on('ui.open', ($, e) => {
    world.opened.push(e.id)
    world.opens.push({ id: e.id, ...(e.focus !== undefined && { focus: e.focus }) })

    return { value: { isPlaced: true } } as never
  })

  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })

  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })

  // The kit has no store beneath session.append, so the row is recorded on its way past and the call is let through.
  on('session.append', ($, e, next) => {
    const blocks = e.message.content as readonly { type: string; text?: string }[]
    world.appended.push(blocks.map(block => block.text ?? '').join(''))

    return next(e)
  })

  on('prompt.submit', ($, e) => {
    world.submitted.push(e.text)

    return { text: e.text } as never
  })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // the spinner as the engine draws it: its message while one overrides the word
  on('ui.render', { component: 'Spinner' }, ($, e) => ({ type: 'Text', children: [e.props.message ?? e.props.word] }) as never)
  // what the engine draws where no plugin draws: never a Box, so a test tells the plugin's own apart
  on('ui.render', () => ({ type: 'Text', children: [''] }) as never)

  return world
}

export const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: CWD }

export const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'rook',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { title: 'rook', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 44 }, view: {} },
}

export const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} },
}

export const command = (args = '', kind: 'composer' | 'plugin' = 'composer') => ({
  command: 'rook',
  args,
  origin: kind === 'composer' ? { kind: 'composer' as const } : ({ kind: 'plugin' as const, name: 'other' } as never),
  presentation: { isFullscreen: true, columns: 180 },
})
