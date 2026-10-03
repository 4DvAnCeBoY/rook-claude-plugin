import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RookRunView, RookSnapshot } from '../types'
import {
  clip,
  credits,
  failureContext,
  progressBar,
  retestPrompt,
  runSummary,
  staleLine,
  statusLine,
  statusText,
  unlooked,
} from './format'
import { assess, declaredVariables, isRunCommand } from './guard'
import { impactOf, indexAgent, relativeTo } from './impact'
import type { AgentIndex } from './impact'
import { CLI_ENV, failureOf, jsonOf, parseRunFlags, runArgs } from './rook'
import type { CliResult, RunRequest } from './rook'
import { locate, previousFinished, readRun, RUN_ID, runIds } from './workspace'
import type { Io, Located, RowCache } from './workspace'

/**
 * rook inside Claude Code.
 *
 *  1. Tools the model calls — `run`, `report`, `status` — so Claude can test
 *     the agent it is building and read rook's evidence back.
 *  2. A live pane: progress, Pass / Fail / Unable to Verify, credits, and what
 *     nobody looked at.
 *  3. A band above the prompt when Claude edits a file the agent is built
 *     from: which scenarios touch it, and a button to re-test them.
 *  4. Failures of a run started elsewhere handed to Claude as context.
 *  5. A status line score with the trend against the previous run.
 *  6. `/rook` — pane, status, report, explain, run, confirm-prod.
 *  7. A guard that refuses runs against a production-looking target until
 *     the person confirms.
 *
 * Everything rook-side goes through the published CLI contract (`--json`
 * documents) and the documented `.testmuai/rook/` layout. The mod holds no
 * prompts and no keys: rook's controller supplies those.
 */

const PANE = 'rook'
const POLL_MS = 3_000
const CONFIRM_MS = 15 * 60_000

const snapshotAtom = atom({ plugin: 'rook', key: 'snapshot' } as const, null)
const staleAtom = atom({ plugin: 'rook', key: 'stale' } as const, null)
const runningAtom = atom({ plugin: 'rook', key: 'running' } as const, null)
const confirmedAtom = atom({ plugin: 'rook', key: 'prodConfirmed' } as const, null)
const seenAtom = atom({ plugin: 'rook', key: 'seenFinished' } as const, null)
const bandHiddenAtom = atom({ plugin: 'rook', key: 'isBandHidden' } as const, false)

// The plugin's own tools as exact patterns: the engine's tool table is laid
// when the mod loads, before session.start registers them.
const RUN_TOOL = /^mcp__rook__run$/
const REPORT_TOOL = /^mcp__rook__report$/
const STATUS_TOOL = /^mcp__rook__status$/
/** Every tool that writes a file; MultiEdit exists on some builds only. */
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/

const USAGE = [
  '/rook                 open the live verdict pane',
  '/rook status          agents, scenarios and sync state',
  '/rook report [run]    the latest (or named) run: verdicts, gaps, credits',
  "/rook explain [run]   hand the run's failures to Claude as fix context",
  '/rook run [--only SC-001,SC-002] [--class adversarial] [--category …] [--name …] [--test] [--rca]',
  '/rook confirm-prod    allow runs against a production-looking target for 15 minutes',
].join('\n')

/** The options and the caches of one load of the module; what a drawing reads lives in $.state. */
type Ctx = {
  bin: string
  paneMode: string
  isStatusLine: boolean
  isRetestBand: boolean
  isFailureContext: boolean
  isProdGuard: boolean
  prodPatterns: string
  cwd: string
  located: Located | undefined
  agentIndex: AgentIndex | undefined
  isPolling: boolean
  isPrimed: boolean
  rows: RowCache
}

function textOption(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function flagOption(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Paths rooted at the session's directory: a relative path would follow the process's, which need not be it. */
function ioOf($: EngineInterface, ctx: Ctx): Io {
  const at = (path: string) => (path.startsWith('/') || ctx.cwd === '' ? path : `${ctx.cwd.replace(/\/$/, '')}/${path}`)

  return {
    read: path =>
      $.fs.read(at(path)).then(
        text => (typeof text === 'string' ? text : undefined),
        () => undefined,
      ),
    list: path => $.fs.list(at(path)).catch(() => []),
  }
}

// ── the rook CLI ─────────────────────────────────────────────────────────────

/** A short rook command (status): bounded wait, whole output. */
async function rookJson($: EngineInterface, ctx: Ctx, args: string[]): Promise<CliResult> {
  try {
    const ran = await $.process.run([ctx.bin, ...args], { env: CLI_ENV, stdin: '', timeoutMs: 60_000, ...(ctx.cwd !== '' && { cwd: ctx.cwd }) })

    return { exitCode: ran.exitCode, doc: jsonOf(ran.stdout), stderr: ran.stderr }
  } catch (error) {
    return { exitCode: 1, doc: undefined, stderr: `could not run ${ctx.bin}: ${String(error)}` }
  }
}

/**
 * A run can outlast `process.run`'s ten-minute ceiling, so it is streamed: the
 * child lives as long as the loop reading it, and `signal` ends both.
 */
async function rookRun($: EngineInterface, ctx: Ctx, argv: string[], signal?: AbortSignal): Promise<CliResult> {
  const stream = $.process.spawn({ argv: [ctx.bin, ...argv], env: CLI_ENV, input: '', ...(ctx.cwd !== '' && { cwd: ctx.cwd }) })
  const iterator = stream[Symbol.asyncIterator]()
  let stdout = ''
  let stderr = ''

  for (;;) {
    if (signal?.aborted) {
      await iterator.return?.(undefined as never)

      return { exitCode: 130, doc: undefined, stderr: `${stderr}\ninterrupted` }
    }

    const step = await iterator.next()

    if (step.done) {
      const ended = step.value as { code: number | null } | undefined

      return { exitCode: ended?.code ?? 1, doc: jsonOf(stdout), stderr }
    }

    if (step.value.stream === 'stdout') {
      stdout += step.value.text
    } else {
      stderr = (stderr + step.value.text).slice(-20_000)
    }
  }
}

// ── reading the workspace ────────────────────────────────────────────────────

async function where($: EngineInterface, ctx: Ctx): Promise<Located | undefined> {
  ctx.located = await locate(ioOf($, ctx))

  return ctx.located
}

// 5 · the status line
async function showStatus($: EngineInterface, ctx: Ctx): Promise<void> {
  if (!ctx.isStatusLine) {
    return
  }

  const snapshot = await read($, snapshotAtom)
  const running = await read($, runningAtom)

  $.ui.status(statusLine(snapshot, running !== null))
}

async function poll($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.isPolling) {
    return
  }

  ctx.isPolling = true

  try {
    const io = ioOf($, ctx)
    const loc = await where($, ctx)
    const before = await read($, snapshotAtom)

    if (loc === undefined) {
      if (before !== null) {
        await update($, snapshotAtom, () => null)
      }

      return
    }

    const ids = await runIds(io, loc.agentDir)
    const latestId = ids[0]
    const isSettled = before?.agentId === loc.agentId && before.latest?.runId === latestId && before.latest?.finished === true

    if (isSettled) {
      return
    }

    const latest = latestId === undefined ? undefined : await readRun(io, loc.agentDir, latestId, ctx.rows)
    const previous = latest?.finished ? await previousFinished(io, loc.agentDir, ids, latest.runId) : undefined
    const snapshot: RookSnapshot = {
      agentId: loc.agentId,
      ...(latest !== undefined && { latest }),
      ...(previous !== undefined && { previous }),
      checkedAt: await $.clock.now(),
    }

    if (JSON.stringify({ ...before, checkedAt: 0 }) !== JSON.stringify({ ...snapshot, checkedAt: 0 })) {
      await update($, snapshotAtom, () => snapshot)
    }

    if (latest?.finished) {
      // An agent seen for the first time (a workspace that appeared, `rook agent
      // use`) brings its history with it: its latest run is not news.
      await finished($, ctx, loc, latest, before?.agentId !== loc.agentId)
    }
  } finally {
    ctx.isPolling = false
    await showStatus($, ctx)
  }
}

// 4 · failures of a run started elsewhere
/** A run reached report.yaml. Report it once, and never one from before this session. */
async function finished($: EngineInterface, ctx: Ctx, loc: Located, run: RookRunView, isNewAgent: boolean): Promise<void> {
  if ((await read($, seenAtom)) === run.runId) {
    return
  }

  await update($, seenAtom, () => run.runId)

  if (!ctx.isPrimed || isNewAgent) {
    return
  }

  if ((await read($, staleAtom)) !== null) {
    await update($, staleAtom, () => null)
  }

  if ((await read($, runningAtom))?.source === 'tool') {
    return // the tool's own result carries the verdicts
  }

  const { pass, fail, unverifiable } = run.counts
  $.ui.toast(`rook: run ${run.runId} finished — ${pass} Pass · ${fail} Fail · ${unverifiable} Unable to Verify`)

  if (ctx.isFailureContext && fail > 0) {
    const text = `<rook-run-result>\n${failureContext(run, loc.agentDir, loc.agentId)}\n</rook-run-result>`

    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  }
}

// ── 7 · production guard ─────────────────────────────────────────────────────

async function variableValues($: EngineInterface, ctx: Ctx, names: readonly string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {}

  if (names.length === 0) {
    return values
  }

  const home = (await $.env.get('ROOK_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.testmuai/rook`
  let stored: Record<string, unknown> = {}

  try {
    const envFile = JSON.parse((await ioOf($, ctx).read(`${home}/env.json`)) ?? '{}') as { projects?: Record<string, Record<string, unknown>> }
    stored = envFile.projects?.[ctx.cwd] ?? {}
  } catch {
    stored = {}
  }

  // `rook env set` keeps the values here, keyed by the directory rook ran in.
  // rook takes its workspace from the working directory with no upward
  // search, so that is this session's directory too. The shell's own environment is not
  // read, since a module may only read variables it names literally.
  for (const name of names) {
    const value = stored[name]

    if (typeof value === 'string') {
      values[name] = value
    }
  }

  return values
}

/** Why a run must not start now, or undefined when it may. */
/** The profile a run would use: the one named, or the agent's active one. */
async function profileOf($: EngineInterface, ctx: Ctx, profileRef?: string): Promise<{ loc: Located; profileId: string } | undefined> {
  const loc = ctx.located ?? (await where($, ctx))

  if (loc === undefined) {
    return undefined
  }

  const profileId = profileRef ?? (await ioOf($, ctx).read(`${loc.agentDir}/profiles/active`))?.trim()

  return profileId === undefined || !/^[\w.-]+$/.test(profileId) ? undefined : { loc, profileId }
}

async function prodBlock($: EngineInterface, ctx: Ctx, profileRef?: string): Promise<string | undefined> {
  if (!ctx.isProdGuard) {
    return undefined
  }

  const target = await profileOf($, ctx, profileRef)

  if (target === undefined) {
    return undefined
  }

  const { loc, profileId } = target
  const confirmed = await read($, confirmedAtom)

  // A confirmation covers the directory and profile it was given for, nothing else.
  if (confirmed !== null && confirmed.cwd === ctx.cwd && confirmed.profile === profileId && confirmed.until > (await $.clock.now())) {
    return undefined
  }

  const io = ioOf($, ctx)

  const profileText = await io.read(`${loc.agentDir}/profiles/${profileId}.yaml`)

  if (profileText === undefined) {
    return undefined
  }

  const verdict = assess(profileText, await variableValues($, ctx, declaredVariables(profileText)), ctx.prodPatterns)

  return verdict.isRisky
    ? `rook: profile "${profileId}" looks like it targets production (${verdict.reasons.join('; ')}). ` +
        "The agent's writes are real and rook cannot roll them back. Point the profile at staging, " +
        'or ask the person to type /rook confirm-prod to allow runs for 15 minutes.'
    : undefined
}

// ── running ──────────────────────────────────────────────────────────────────

async function backgroundRun($: EngineInterface, ctx: Ctx, argv: string[]): Promise<void> {
  try {
    const problem = failureOf(await rookRun($, ctx, argv))

    if (problem !== undefined) {
      $.ui.toast(`rook: ${clip(problem, 160)}`)
    }
  } catch (error) {
    $.ui.toast(`rook: could not start ${ctx.bin} — ${clip(String(error), 120)}`)
  } finally {
    await update($, runningAtom, () => null)
    await poll($, ctx)
  }
}

/** A run the person started (pane button, /rook run): in the background, reported when it lands. */
async function startRun($: EngineInterface, ctx: Ctx, request: RunRequest, source: 'command' | 'pane'): Promise<string> {
  if ((await read($, runningAtom)) !== null) {
    return 'rook: a run is already in progress.'
  }

  const args = runArgs(request)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  const blocked = await prodBlock($, ctx)

  if (blocked !== undefined) {
    return blocked
  }

  const label = request.only ? request.only.join(', ') : 'all runnable scenarios'

  const startedAt = await $.clock.now()

  await update($, runningAtom, () => ({ startedAt, label, source }))
  await showStatus($, ctx)
  $.clock.after(0, () => backgroundRun($, ctx, args.argv))

  return `rook: running ${label} in the background. Progress shows in the pane and the status line.`
}

// 1 · the model's run: inline, so the verdicts come back as the tool's result
async function toolRun($: EngineInterface, ctx: Ctx, request: RunRequest, signal: AbortSignal): Promise<{ result: string } | { deny: string }> {
  if ((await read($, runningAtom)) !== null) {
    return { deny: 'rook: a run is already in progress; wait for it, then read it with the rook report tool.' }
  }

  const args = runArgs(request)

  if ('error' in args) {
    return { deny: `rook: ${args.error}` }
  }

  const blocked = await prodBlock($, ctx)

  if (blocked !== undefined) {
    return { deny: blocked }
  }

  const startedAt = await $.clock.now()

  await update($, runningAtom, () => ({ startedAt, label: request.only?.join(', ') ?? 'all', source: 'tool' }))
  await showStatus($, ctx)

  try {
    const result = await rookRun($, ctx, args.argv, signal)
    const problem = failureOf(result)
    const doc = result.doc as { run_id?: string; halted?: boolean; credits?: number } | undefined
    const runId = doc?.run_id

    if (problem !== undefined && runId === undefined) {
      return { result: `rook run did not complete: ${problem}` }
    }

    const loc = ctx.located ?? (await where($, ctx))

    if (runId === undefined || loc === undefined || !RUN_ID.test(runId)) {
      return { result: `rook run finished, but returned no run id to read.${problem ? ` ${problem}` : ''}` }
    }

    await update($, seenAtom, () => runId)
    const run = await readRun(ioOf($, ctx), loc.agentDir, runId, ctx.rows)

    if (run === undefined) {
      return { result: `rook run ${runId} finished, but ${loc.agentDir}/runs/${runId}/ could not be read.` }
    }

    if ((await read($, staleAtom)) !== null) {
      await update($, staleAtom, () => null)
    }

    const halted = doc?.halted ? '\nThe run HALTED before finishing: treat it as incomplete, not as a full suite.' : ''

    return { result: runSummary(run, loc.agentDir, loc.agentId, doc?.credits) + halted }
  } finally {
    await update($, runningAtom, () => null)
    await poll($, ctx)
  }
}

async function reportText($: EngineInterface, ctx: Ctx, runRef: string | undefined): Promise<{ text: string; context?: string }> {
  const loc = await where($, ctx)

  if (loc === undefined) {
    return { text: "rook: no rook workspace in this directory. Run `rook explore .` in the agent's repository first." }
  }

  if (runRef !== undefined && !RUN_ID.test(runRef)) {
    return { text: `rook: "${clip(runRef, 40)}" is not a run id (2026-09-28T15-54-56Z form).` }
  }

  const io = ioOf($, ctx)
  const ids = await runIds(io, loc.agentDir)
  const runId = runRef ?? ids[0]

  if (runId === undefined || !ids.includes(runId)) {
    return { text: runRef ? `rook: no run ${runRef} for agent ${loc.agentId}.` : `rook: agent ${loc.agentId} has no runs yet.` }
  }

  const run = await readRun(io, loc.agentDir, runId, ctx.rows)

  if (run === undefined) {
    return { text: `rook: run ${runId} has no run.yaml.` }
  }

  if (!run.finished) {
    return { text: `rook: run ${runId} is still running — ${run.done}/${run.planned} judged, ${run.counts.fail} failing so far.` }
  }

  const summary = runSummary(run, loc.agentDir, loc.agentId, run.credits)

  return { text: summary, ...(run.counts.fail > 0 && { context: failureContext(run, loc.agentDir, loc.agentId) }) }
}

async function statusReply($: EngineInterface, ctx: Ctx): Promise<string> {
  const status = await rookJson($, ctx, ['status', '--json'])

  return status.doc === undefined ? `rook status failed: ${failureOf(status) ?? 'no output'}` : statusText(status.doc)
}

// ── 3 · re-test after edits ──────────────────────────────────────────────────

async function noted($: EngineInterface, ctx: Ctx, path: string): Promise<void> {
  const rel = relativeTo(ctx.cwd, path)

  if (rel === undefined) {
    return
  }

  if (rel.startsWith('.testmuai/')) {
    ctx.agentIndex = undefined // scenarios or features were rewritten

    return
  }

  const loc = ctx.located ?? (await where($, ctx))

  if (loc === undefined) {
    return
  }

  const index = ctx.agentIndex ?? (await indexAgent(ioOf($, ctx), loc.agentDir))
  ctx.agentIndex = index
  const stale = await read($, staleAtom)
  const files = [...new Set([...(stale?.files ?? []), rel])].filter(file => impactOf(index, [file]) !== undefined)
  const impact = impactOf(index, files)

  if (impact === undefined) {
    return
  }

  const since = await $.clock.now()

  await update($, staleAtom, () => ({ files, scenarios: impact.scenarios, isWholeAgent: impact.isWholeAgent, since }))
  await update($, bandHiddenAtom, () => false)
}

async function fixWithClaude($: EngineInterface, ctx: Ctx, run: RookRunView): Promise<void> {
  const loc = ctx.located ?? (await where($, ctx))

  if (loc !== undefined) {
    await $.prompt.submit({ text: `${failureContext(run, loc.agentDir, loc.agentId)}\n\nFix these failures.` })
  }
}

async function retest($: EngineInterface): Promise<void> {
  const stale = await read($, staleAtom)

  await update($, bandHiddenAtom, () => true)

  if (stale !== null) {
    await $.prompt.submit({ text: retestPrompt(stale) })
  }
}

async function paneRun($: EngineInterface, ctx: Ctx, request: RunRequest): Promise<void> {
  $.ui.toast(await startRun($, ctx, request, 'pane'))
}

// ── the module ───────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    bin: textOption(options.rookPath, 'rook'),
    paneMode: textOption(options.pane, 'auto'),
    isStatusLine: flagOption(options.statusLine, true),
    isRetestBand: flagOption(options.retestBand, true),
    isFailureContext: flagOption(options.failureContext, true),
    isProdGuard: flagOption(options.prodGuard, true),
    prodPatterns: textOption(options.prodPatterns, 'prod,production,live'),
    cwd: '',
    located: undefined,
    agentIndex: undefined,
    isPolling: false,
    isPrimed: false,
    rows: new Map(),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    ctx.cwd = e.cwd

    // session.start fires again on a hot reload, which kills any child the
    // previous load spawned: a run it marked as in flight is not anymore.
    if ((await read($, runningAtom)) !== null) {
      await update($, runningAtom, () => null)
    }

    await $.command.register({
      name: 'rook',
      description: 'rook agent testing: pane, status, report, explain, run, confirm-prod',
      argumentHint: '[pane|status|report|explain|run|confirm-prod|help]',
    })
    await $.tool.register({
      name: 'run',
      description:
        'Run rook (TestMu AI agent assurance) scenarios against the agent under test in this workspace and return the verdicts: ' +
        'Pass / Fail / Unable to Verify per scenario, failing criteria with expected vs achieved and quoted evidence, and what nobody could verify. ' +
        "Use it after changing the agent's prompt, tools or code. It invokes the real agent (its writes are real) and spends rook credits, " +
        'so prefer `only` with the scenario ids you touched. Unable to Verify is not Fail. A run can take minutes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          only: {
            type: 'array',
            items: { type: 'string', pattern: '^SC-\\d{1,6}$' },
            minItems: 1,
            maxItems: 200,
            description: 'Scenario ids to run, e.g. ["SC-004"]',
          },
          class: { type: 'string', enum: ['functional', 'non-functional', 'adversarial'] },
          category: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', description: 'One rook category, e.g. prompt_injection' },
          name: { type: 'string', maxLength: 120, description: 'A label for the run' },
          test: { type: 'boolean', description: 'Keep the run local: not synced upstream' },
          rca: { type: 'boolean', description: 'Also explain failure clusters (root cause, remedy); costs more credits' },
        },
      },
    })
    await $.tool.register({
      name: 'report',
      description:
        "Read a finished rook run from disk (no credits, no agent call): verdict counts, failing criteria with rook's evidence, verification gaps, credits. Defaults to the latest run.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { run_id: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z(-\\d+)?$' } },
      },
    })
    await $.tool.register({
      name: 'status',
      description: "rook's view of this workspace: the project's agents, scenario counts, sync state, unfinished runs. No credits.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    })

    await poll($, ctx)
    ctx.isPrimed = true
    $.clock.every(POLL_MS, () => poll($, ctx))

    if (ctx.paneMode === 'auto' && ctx.located !== undefined) {
      void $.ui.open({ id: PANE, title: 'rook' })
    }

    return started
  })

  // 1 · tools the model calls
  on('tool.call', { tool: RUN_TOOL }, ($, e, next) => {
    const input = e as unknown as RunRequest
    const request: RunRequest = {
      ...(input.only !== undefined && { only: input.only }),
      ...(input.class !== undefined && { class: input.class }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.test === true && { test: true }),
      ...(input.rca === true && { rca: true }),
    }

    return toolRun($, ctx, request, next.signal)
  })

  on('tool.call', { tool: REPORT_TOOL }, async ($, e) => {
    const runId = (e as unknown as { run_id?: unknown }).run_id
    const { text, context } = await reportText($, ctx, typeof runId === 'string' ? runId : undefined)

    return { result: context ?? text }
  })

  on('tool.call', { tool: STATUS_TOOL }, async $ => {
    const latest = (await read($, snapshotAtom))?.latest
    const tail = latest
      ? `\nLatest run ${latest.runId}: ${latest.finished ? 'finished' : `running ${latest.done}/${latest.planned}`} · ` +
        `${latest.counts.pass} Pass · ${latest.counts.fail} Fail · ${latest.counts.unverifiable} Unable to Verify`
      : ''

    return { result: (await statusReply($, ctx)) + tail }
  })

  // 7 · production guard over the model's shell
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isRunCommand(e.command)) {
      return next(e)
    }

    const blocked = await prodBlock($, ctx, /--profile[= ]([\w.-]+)/.exec(e.command)?.[1])

    return blocked === undefined ? next(e) : { deny: blocked }
  })

  // 3 · edits to the agent under test
  on('tool.call', { tool: EDIT_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined

    if (ctx.isRetestBand && path !== undefined && ran.deny === undefined && ran.isError !== true) {
      await noted($, ctx, path).catch(() => undefined)
    }

    return ran
  })

  // 6 · /rook
  on('command.run', { command: 'rook' }, async ($, e) => {
    const [sub = 'pane', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)

    switch (sub) {
      case 'pane':
      case 'open': {
        const opened = await $.ui.open({ id: PANE, title: 'rook' })

        return { text: opened.isPlaced ? 'rook pane opened.' : `rook pane is waiting: ${opened.reason}` }
      }
      case 'status':
        return { text: await statusReply($, ctx) }
      case 'report':
        return { text: (await reportText($, ctx, rest[0])).text }
      case 'explain': {
        const { text, context } = await reportText($, ctx, rest[0])

        return context === undefined
          ? { text: `${text}\n\nNothing failed, so there is nothing to explain.` }
          : { text: 'rook: handed the failing criteria and evidence to Claude.', context: [context] }
      }
      case 'run': {
        const request = parseRunFlags(rest.join(' '))

        return { text: 'error' in request ? `rook: ${request.error}` : await startRun($, ctx, request, 'command') }
      }
      case 'confirm-prod': {
        if (e.origin.kind !== 'composer') {
          return { text: 'rook: confirm-prod must be typed by the person at the prompt.' }
        }

        const target = await profileOf($, ctx)

        if (target === undefined) {
          return { text: 'rook: no rook workspace with an active profile here; nothing to confirm.' }
        }

        const until = (await $.clock.now()) + CONFIRM_MS

        await update($, confirmedAtom, () => ({ cwd: ctx.cwd, profile: target.profileId, until }))

        return {
          text:
            `rook: runs with profile "${target.profileId}" in this directory are allowed for the next 15 minutes, ` +
            "even though its target looks like production. Its writes are real and rook cannot roll them back.",
        }
      }
      default:
        return { text: USAGE }
    }
  })

  // 2 · the live pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snapshot = await read($, snapshotAtom)
    const running = await read($, runningAtom)
    const width = Math.max(20, e.props.bodyColumns)

    if (snapshot === null) {
      return (
        <Box flexDirection="column">
          <Text bold>rook</Text>
          <Text dimColor>No rook workspace in this directory.</Text>
          <Text dimColor>Run `rook explore .` in your agent's repository to start.</Text>
        </Box>
      )
    }

    const run = snapshot.latest
    const failed = run?.rows.filter(row => row.status === 'Fail') ?? []
    const gaps = run === undefined ? [] : unlooked(run)
    const canAct = running === null
    const trend =
      snapshot.previous === undefined || run === undefined
        ? undefined
        : `${run.counts.pass - snapshot.previous.passed >= 0 ? '+' : ''}${run.counts.pass - snapshot.previous.passed} Pass vs ${snapshot.previous.runId}`
    const facts = run?.finished
      ? [run.passRate === undefined ? undefined : `pass rate ${Math.round(run.passRate <= 1 ? run.passRate * 100 : run.passRate)}%`, credits(run.credits), trend]
          .filter(Boolean)
          .join(' · ')
      : ''

    return (
      <Box flexDirection="column">
        <Text bold>rook · {snapshot.agentId ?? ''}</Text>
        {run === undefined && <Text dimColor>No runs yet. Press Run all, or ask Claude to test the agent.</Text>}
        {run !== undefined && (
          <Text dimColor wrap="truncate-end">
            {run.name ?? 'run'} · {run.runId}
          </Text>
        )}
        {run !== undefined && (
          <Text>
            {progressBar(run.done, run.planned, Math.min(30, width - 16))} {run.done}/{run.planned} {run.finished ? 'done' : 'running'}
          </Text>
        )}
        {run !== undefined && (
          <Box flexDirection="row" gap={2}>
            <Text color="green">✓ {run.counts.pass} Pass</Text>
            <Text color="red">✗ {run.counts.fail} Fail</Text>
            <Text color="yellow">? {run.counts.unverifiable} Unable to Verify</Text>
          </Box>
        )}
        {facts !== '' && <Text dimColor>{facts}</Text>}
        {running !== null && <Text color="cyan">▸ running {running.label}</Text>}
        {failed.length > 0 && <Text bold>Failed</Text>}
        {failed.slice(0, 12).map(row => (
          <Box key={`f-${row.id}`}>
            <Text wrap="truncate-end">
              <Text color="red">✗ {row.id}</Text> {row.compromised ? '[compromised] ' : ''}
              {row.title || clip(row.summary, width)}
            </Text>
          </Box>
        ))}
        {gaps.length > 0 && <Text bold>What nobody looked at</Text>}
        {gaps.slice(0, 8).map(row => (
          <Box key={`g-${row.id}`}>
            <Text dimColor wrap="truncate-end">
              {['?', row.id, row.reason, clip(row.gaps.join('; '), width)].filter(Boolean).join(' ')}
            </Text>
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          {canAct && <Button key="run-all" label="Run all" hotkey="r" onPress={() => paneRun($, ctx, {})} />}
          {canAct && failed.length > 0 && (
            <Button key="rerun-failed" label="Re-run failed" hotkey="f" onPress={() => paneRun($, ctx, { only: failed.map(row => row.id) })} />
          )}
          {failed.length > 0 && run !== undefined && (
            <Button key="fix" label="Fix with Claude" variant="primary" hotkey="x" onPress={() => fixWithClaude($, ctx, run)} />
          )}
        </Box>
      </Box>
    )
  })

  // 3 · the re-test band
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ctx.isRetestBand || e.props.hasSurvey) {
      return next(e)
    }

    const stale = await read($, staleAtom)

    if (stale === null || (await read($, bandHiddenAtom))) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap={1}>
        <Text color="yellow">◆ rook</Text>
        <Text wrap="truncate-end">{staleLine(stale)}</Text>
        <Button key="retest" label="Re-test" variant="primary" onPress={() => retest($)} />
        <Button key="dismiss" label="Dismiss" role="dismiss" onPress={() => update($, bandHiddenAtom, () => true)} />
      </Box>
    )
  })
}
