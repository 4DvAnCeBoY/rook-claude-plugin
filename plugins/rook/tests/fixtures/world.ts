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
  toasts: string[]
  statuses: (string | undefined)[]
  appended: string[]
  submitted: string[]
  commands: string[]
  tools: string[]
  /** argv of every rook invocation */
  invocations: string[][]
  /** What the fake `rook run` does: write files, then print this document. */
  onRun: (argv: readonly string[]) => { stdout: string; code: number; writes?: Record<string, string> }
  status: { stdout: string; code: number }
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
    toasts: [],
    statuses: [],
    appended: [],
    submitted: [],
    commands: [],
    tools: [],
    invocations: [],
    onRun: () => ({ stdout: JSON.stringify({ ok: true, halted: false, credits: 0 }), code: 0 }),
    status: { stdout: JSON.stringify({ project_id: 'P', offline: false, agents: [] }), code: 0 },
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
    const dir = relOf(e.path ?? '')
    const names = new Map<string, 'file' | 'dir'>()

    for (const file of world.files.keys()) {
      if (file.startsWith(`${dir}/`)) {
        const rest = file.slice(dir.length + 1)
        names.set(rest.split('/')[0] ?? '', rest.includes('/') ? 'dir' : 'file')
      }
    }

    return {
      value: [...names.entries()].sort().map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })),
    }
  })

  on('env.get', ($, e) => ({ value: env[e.name] }))

  on('process.run', ($, e) => {
    if (world.isMissingBinary) {
      return { deny: `ENOENT: ${e.argv[0]}` }
    }

    if (e.argv[1] === '--version' || e.argv[1] === 'auth') {
      world.probes.push([...e.argv])
      const probe = e.argv[1] === 'auth' ? world.auth : world.version

      return { value: { exitCode: probe.code, stdout: probe.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    world.invocations.push([...e.argv])

    return { value: { exitCode: world.status.code, stdout: world.status.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('process.spawn', async function* ($, e) {
    world.invocations.push([...e.argv])
    const ran = world.onRun(e.argv)

    for (const [path, text] of Object.entries(ran.writes ?? {})) {
      world.files.set(path, text)
    }

    await world.during?.()
    yield { stream: 'stderr' as const, text: 'running…\n' }
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
