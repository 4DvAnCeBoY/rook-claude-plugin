import { atom, read, update } from 'claude-code'
import type { CommandRunInput, EngineInterface, Register } from 'claude-code'

import type { RookCluster, RookRunView, RookScenarioRow, RookSnapshot } from '../types'
import {
  clip,
  clusterNote,
  credits,
  creditsPerScenario,
  duration,
  excerpt,
  failureContext,
  failureNote,
  gapText,
  generateText,
  isExplained,
  isReporting,
  metricsLine,
  orderedClusters,
  progressBar,
  reasonText,
  REPORTING,
  retestPrompt,
  runSummary,
  scenariosText,
  spinnerText,
  staleLine,
  statusLine,
  statusText,
  unlooked,
} from './format'
import { assess, declaredVariables, isRunCommand } from './guard'
import { impactOf, indexAgent, relativeTo } from './impact'
import type { AgentIndex } from './impact'
import { allowRulesOf, CLI_ENV, failureOf, generateArgs, jsonOf, parseGenerateFlags, parseRunFlags, runArgs } from './rook'
import type { Approval, CliResult, GenerateRequest, RunRequest } from './rook'
import { changesIn, countsOf, currentVerdicts, locate, readRun, RUN_ID, runIds } from './workspace'
import type { Io, Located, RowCache } from './workspace'

/**
 * rook inside Claude Code.
 *
 *  1. Tools the model calls — `run`, `report`, `status`, `scenarios`,
 *     `generate` — so Claude can test the agent it is building, read rook's
 *     evidence and root-cause clusters back, and write scenarios for it.
 *  2. A live pane: every scenario's latest verdict, the run in flight lane by
 *     lane, clusters with rook's remedies, failures you can open, and what
 *     nobody looked at. The turn's spinner carries the run's progress too.
 *  3. A band above the prompt when Claude edits a file the agent is built
 *     from: which scenarios touch it, and a button to re-test them.
 *  4. Failures of a run started elsewhere handed to Claude as context.
 *  5. A status line score over every scenario's latest verdict, with what the
 *     latest run fixed or regressed.
 *  6. `/rook` — pane, status, report, explain, run, scenarios, generate, ui,
 *     confirm-prod.
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
const VIEWER_START_MS = 15_000

const snapshotAtom = atom({ plugin: 'rook', key: 'snapshot' } as const, null)
const staleAtom = atom({ plugin: 'rook', key: 'stale' } as const, null)
const runningAtom = atom({ plugin: 'rook', key: 'running' } as const, null)
const confirmedAtom = atom({ plugin: 'rook', key: 'prodConfirmed' } as const, null)
const seenAtom = atom({ plugin: 'rook', key: 'seenFinished' } as const, null)
const bandHiddenAtom = atom({ plugin: 'rook', key: 'isBandHidden' } as const, false)
const expandedAtom = atom({ plugin: 'rook', key: 'expanded' } as const, null)
const viewerAtom = atom({ plugin: 'rook', key: 'viewerUrl' } as const, null)
const tickAtom = atom({ plugin: 'rook', key: 'tick' } as const, 0)

// The plugin's own tools as exact patterns: the engine's tool table is laid
// when the mod loads, before session.start registers them.
const RUN_TOOL = /^mcp__rook__run$/
const REPORT_TOOL = /^mcp__rook__report$/
const STATUS_TOOL = /^mcp__rook__status$/
const SCENARIOS_TOOL = /^mcp__rook__scenarios$/
const GENERATE_TOOL = /^mcp__rook__generate$/
/** Every tool that writes a file; MultiEdit exists on some builds only. */
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/

const USAGE = [
  '/rook                 open the live verdict pane',
  '/rook status          agents, scenarios and sync state',
  '/rook scenarios       every scenario with its latest verdict',
  '/rook report [run]    the latest (or named) run: clusters, verdicts, gaps, credits',
  "/rook explain [run]   hand the run's failures (and rook's remedies) to Claude as fix context",
  '/rook run [--only SC-001,SC-002] [--class …] [--category …] [--tag …] [--profile …] [--name …]',
  '          [--concurrency 1-8] [--resume <run>] [--run <run> --phases collect,judge] [--test] [--rca] [-- <instruction>]',
  '/rook generate [--total N] [--class …] [--category …] [--force] [-- <what to cover>]',
  '/rook ui              open the on-disk results viewer (rook ui --local)',
  '/rook confirm-prod [profile]  allow runs against a production-looking target for 15 minutes',
  '',
  "Runs and generate approve rook's own tool calls with --yes, unless allowRules is set in /config.",
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
  approval: Approval
  cwd: string
  located: Located | undefined
  agentIndex: AgentIndex | undefined
  isPolling: boolean
  isPrimed: boolean
  /** Set when something changed that the settled check cannot see (new scenarios). */
  isDirty: boolean
  /** The `rook ui --local` child, while it serves. */
  viewer: AbortController | undefined
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
    const isSettled =
      !ctx.isDirty && before?.agentId === loc.agentId && before.latest?.runId === latestId && before.latest?.finished === true

    if (isSettled) {
      return
    }

    ctx.isDirty = false

    const latest = latestId === undefined ? undefined : await readRun(io, loc.agentDir, latestId, ctx.rows)
    const current = await currentVerdicts(io, loc.agentDir, ids, ctx.rows)
    const index = ctx.agentIndex ?? (await indexAgent(io, loc.agentDir))
    ctx.agentIndex = index
    const judged = new Set(current.map(row => row.id))
    const profileId = (await io.read(`${loc.agentDir}/profiles/active`))?.trim()
    const snapshot: RookSnapshot = {
      agentId: loc.agentId,
      ...(profileId !== undefined && profileId !== '' && { profileId }),
      ...(latest !== undefined && { latest }),
      current,
      neverRun: index.scenarios.filter(scenario => !judged.has(scenario.id)).length,
      checkedAt: await $.clock.now(),
    }

    if (JSON.stringify({ ...before, checkedAt: 0 }) !== JSON.stringify({ ...snapshot, checkedAt: 0 })) {
      await update($, snapshotAtom, () => snapshot)
    }

    // Elapsed times in the lanes and the spinner move while anything is in flight.
    if (latest !== undefined && !latest.finished) {
      await update($, tickAtom, () => snapshot.checkedAt)
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

  return profileId === undefined || !/^[\w.][\w.-]{0,63}$/.test(profileId) ? undefined : { loc, profileId }
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
        `or ask the person to type /rook confirm-prod ${profileId} to allow runs with it for 15 minutes.`
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

  const args = runArgs(request, ctx.approval)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  const blocked = await prodBlock($, ctx, request.profile)

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

  const args = runArgs(request, ctx.approval)

  if ('error' in args) {
    return { deny: `rook: ${args.error}` }
  }

  const blocked = await prodBlock($, ctx, request.profile)

  if (blocked !== undefined) {
    return { deny: blocked }
  }

  const startedAt = await $.clock.now()

  await update($, runningAtom, () => ({ startedAt, label: request.only?.join(', ') ?? 'all', source: 'tool' }))
  await showStatus($, ctx)

  // Claude asked, not the person: the pane seats only where there is room for
  // an unasked one. The spinner carries the progress everywhere else.
  if (ctx.paneMode !== 'off') {
    void $.ui.open({ id: PANE, title: 'rook' }).catch(() => undefined)
  }

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

/** Every scenario with its latest verdict: rook's list, or the files on disk when rook cannot answer. */
async function scenariosReply($: EngineInterface, ctx: Ctx): Promise<string> {
  await poll($, ctx)
  const current = (await read($, snapshotAtom))?.current ?? []
  const listed = await rookJson($, ctx, ['scenarios', 'list', '--json'])

  if (listed.doc !== undefined && failureOf(listed) === undefined) {
    return scenariosText(listed.doc, current)
  }

  const loc = ctx.located ?? (await where($, ctx))

  if (loc === undefined) {
    return "rook: no rook workspace in this directory. Run `rook explore .` in the agent's repository first."
  }

  const index = ctx.agentIndex ?? (await indexAgent(ioOf($, ctx), loc.agentDir))
  ctx.agentIndex = index

  return (
    scenariosText({ agent_id: loc.agentId, total: index.scenarios.length, scenarios: index.scenarios.map(s => ({ scenario_id: s.id, title: s.title, feature_id: s.featureId })) }, current) +
    `\n(from the files on disk: rook scenarios list failed — ${clip(failureOf(listed) ?? 'no output', 160)})`
  )
}

/** `rook generate`, streamed like a run: it reads the code and writes scenarios, which takes minutes. */
async function generateRun($: EngineInterface, ctx: Ctx, request: GenerateRequest, signal?: AbortSignal): Promise<string> {
  const args = generateArgs(request, ctx.approval)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  try {
    const result = await rookRun($, ctx, args.argv, signal)
    const problem = failureOf(result)

    return problem !== undefined && result.doc === undefined ? `rook generate did not complete: ${problem}` : generateText(result.doc) + (problem ? `\n${problem}` : '')
  } finally {
    ctx.agentIndex = undefined // the scenario set changed
    ctx.isDirty = true
    await poll($, ctx)
  }
}

/**
 * `rook ui --local`: rook's read-only viewer over what is on disk, with each
 * scenario's request, response and evidence files. It serves until the child
 * ends, so the child lives as long as the loop reading it.
 */
async function startViewer($: EngineInterface, ctx: Ctx): Promise<string> {
  const known = await read($, viewerAtom)

  if (known !== null && ctx.viewer !== undefined) {
    return known
  }

  const stop = new AbortController()
  ctx.viewer = stop
  const stream = $.process.spawn({ argv: [ctx.bin, 'ui', '--local', '--no-open'], env: CLI_ENV, input: '', ...(ctx.cwd !== '' && { cwd: ctx.cwd }) })
  const iterator = stream[Symbol.asyncIterator]()
  let said = ''

  // A rook that prints no address (a prompt, a lock) must not hold the command forever.
  let isLate = false
  const late = new Promise<{ done: true; value: undefined }>(resolve =>
    $.clock.after(VIEWER_START_MS, () => {
      isLate = true
      resolve({ done: true, value: undefined })
    }),
  )
  const url = await (async () => {
    for (;;) {
      const step = await Promise.race([iterator.next(), late])

      if (step.done) {
        return undefined
      }

      said = (said + step.value.text).slice(-4000)
      const found = /http:\/\/(127\.0\.0\.1|localhost):\d+\/?/.exec(said)

      if (found) {
        return found[0]
      }
    }
  })()

  if (url === undefined) {
    ctx.viewer = undefined
    // Ended, not awaited: a child stuck where it cannot be interrupted must not hold the command either.
    void Promise.resolve(iterator.return?.(undefined as never)).catch(() => undefined)

    const last = said.trim() ? ` — ${clip(said.trim().split('\n').pop() ?? '', 160)}` : ''

    return isLate ? `rook: the viewer printed no address within ${VIEWER_START_MS / 1000}s${last}` : `rook: the viewer did not start${last}`
  }

  await update($, viewerAtom, () => url)

  // Keep reading so the child keeps serving; forget the address when it ends.
  void (async () => {
    try {
      while (!stop.signal.aborted && !(await iterator.next()).done) {
        // drained
      }
    } finally {
      await iterator.return?.(undefined as never)
      if (ctx.viewer === stop) {
        ctx.viewer = undefined
        await update($, viewerAtom, () => null)
      }
    }
  })().catch(() => undefined) // a reload ends the child and this module with it

  return url
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
  const rate = creditsPerScenario((await read($, snapshotAtom))?.latest)
  const estimate = rate === undefined ? undefined : rate * impact.scenarios.length

  await update($, staleAtom, () => ({ files, scenarios: impact.scenarios, isWholeAgent: impact.isWholeAgent, ...(estimate !== undefined && { estimate }), since }))
  await update($, bandHiddenAtom, () => false)
}

async function fixWithClaude($: EngineInterface, ctx: Ctx, run: RookRunView): Promise<void> {
  const loc = ctx.located ?? (await where($, ctx))

  if (loc !== undefined) {
    await $.prompt.submit({ text: `${failureContext(run, loc.agentDir, loc.agentId)}\n\nFix these failures.` })
  }
}

/** One cluster or one failed scenario, handed to Claude from the pane. */
async function fixOne($: EngineInterface, ctx: Ctx, run: RookRunView, id: string): Promise<void> {
  const loc = ctx.located ?? (await where($, ctx))

  if (loc === undefined) {
    return
  }

  const runDir = `${loc.agentDir}/runs/${run.runId}`
  const rows = new Map(run.rows.map(row => [row.id, row]))
  const cluster = run.clusters.find(c => c.id === id)
  const row = rows.get(id)
  const note = cluster ? clusterNote(cluster, rows, runDir) : row ? failureNote(row, `${runDir}/scenarios/${row.id}/verdict.yaml`) : undefined

  if (note !== undefined) {
    await $.prompt.submit({
      text: `rook run ${run.runId} against agent ${loc.agentId}:\n${note}\n\nFix this. If the evidence shows the criterion is wrong rather than the agent, say so. Then re-test with the rook run tool, passing only the scenario ids involved.`,
    })
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

// 6 · /rook
async function rookCommand($: EngineInterface, ctx: Ctx, e: CommandRunInput): Promise<{ text: string; context?: string[] }> {
  const [sub = 'pane', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
  const tail = e.args.trim().slice(sub.length).trim()

  switch (sub) {
    case 'pane':
    case 'open': {
      const opened = await $.ui.open({ id: PANE, title: 'rook' })

      return { text: opened.isPlaced ? 'rook pane opened.' : `rook pane is waiting: ${opened.reason}` }
    }
    case 'status':
      return { text: await statusReply($, ctx) }
    case 'scenarios':
      return { text: await scenariosReply($, ctx) }
    case 'report':
      return { text: (await reportText($, ctx, rest[0])).text }
    case 'explain': {
      const { text, context } = await reportText($, ctx, rest[0])

      return context === undefined
        ? { text: `${text}\n\nNothing failed, so there is nothing to explain.` }
        : { text: "rook: handed the failure clusters, rook's remedies and the evidence to Claude.", context: [context] }
    }
    case 'run': {
      const request = parseRunFlags(tail)

      return { text: 'error' in request ? `rook: ${request.error}` : await startRun($, ctx, request, 'command') }
    }
    case 'generate': {
      const request = parseGenerateFlags(tail)

      if ('error' in request) {
        return { text: `rook: ${request.error}` }
      }

      $.clock.after(0, async () => $.ui.toast(clip(await generateRun($, ctx, request).catch(error => `rook generate failed: ${String(error)}`), 300)))

      return { text: 'rook: generating scenarios in the background. A toast says when they are written; /rook scenarios lists them.' }
    }
    case 'ui':
    case 'viewer': {
      const url = await startViewer($, ctx)

      return { text: url.startsWith('http') ? `rook viewer: ${url} (read only: scenarios, runs, request/response and evidence files)` : url }
    }
    case 'confirm-prod': {
      if (e.origin.kind !== 'composer') {
        return { text: 'rook: confirm-prod must be typed by the person at the prompt.' }
      }

      // The profile a refusal named, or the active one.
      const target = await profileOf($, ctx, rest[0])

      if (target === undefined) {
        return {
          text: rest[0] === undefined ? 'rook: no rook workspace with an active profile here; nothing to confirm.' : `rook: "${clip(rest[0], 64)}" is not a profile id.`,
        }
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
}

const APPROVALS_NOTE =
  "rook's own tool calls during the command (reading the agent's code, running its commands) are approved with --yes, " +
  'unless the person set allowRules, in which case only those are approved and rook declines the rest.'

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    only: {
      type: 'array',
      items: { type: 'string', pattern: '^SC-\\d{1,6}$' },
      minItems: 1,
      maxItems: 200,
      description: 'Scenario ids to run, e.g. ["SC-004"]. The rook scenarios tool lists them.',
    },
    class: { type: 'string', enum: ['functional', 'non-functional', 'adversarial'] },
    category: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$', description: 'One rook category, e.g. prompt_injection' },
    tags: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, minItems: 1, maxItems: 20, description: 'Scenario tags' },
    profile: { type: 'string', pattern: '^[\\w.-]{1,64}$', description: 'Which profile to call the agent through (local, staging…). Default: the active one' },
    name: { type: 'string', maxLength: 120, description: 'A label for the run' },
    concurrency: { type: 'integer', minimum: 1, maximum: 8, description: 'Scenarios in flight at once' },
    resume: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z(-\\d+)?$', description: 'Carry finished work from this run into a new one' },
    continueRun: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z(-\\d+)?$',
      description: 'Continue this run in place, running only `phases` (for evidence that lands later)',
    },
    phases: { type: 'array', items: { type: 'string', enum: ['prepare', 'open', 'execute', 'close', 'collect', 'judge'] }, minItems: 1, maxItems: 6 },
    test: { type: 'boolean', description: 'Keep the run local: not synced upstream' },
    rca: { type: 'boolean', description: 'Also explain failure clusters: cause, whose fault, and a proposed diff. Costs more credits' },
    instruction: { type: 'string', maxLength: 2000, description: "Free text for rook's run planner, e.g. 'only the refund paths'" },
  },
} as const

export const register: Register = (on, options) => {
  const ctx: Ctx = {
    bin: textOption(options.rookPath, 'rook'),
    paneMode: textOption(options.pane, 'auto'),
    isStatusLine: flagOption(options.statusLine, true),
    isRetestBand: flagOption(options.retestBand, true),
    isFailureContext: flagOption(options.failureContext, true),
    isProdGuard: flagOption(options.prodGuard, true),
    prodPatterns: textOption(options.prodPatterns, 'prod,production,live'),
    approval: { allowRules: allowRulesOf(textOption(options.allowRules, '')) },
    cwd: '',
    located: undefined,
    agentIndex: undefined,
    isPolling: false,
    isPrimed: false,
    isDirty: false,
    viewer: undefined,
    rows: new Map(),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    ctx.cwd = e.cwd

    // session.start fires again on a hot reload, which kills any child the
    // previous load spawned: a run it marked as in flight is not anymore, nor
    // is the viewer it started.
    if ((await read($, runningAtom)) !== null) {
      await update($, runningAtom, () => null)
    }

    if ((await read($, viewerAtom)) !== null) {
      await update($, viewerAtom, () => null)
    }

    await $.command.register({
      name: 'rook',
      description: 'rook agent testing: pane, status, scenarios, report, explain, run, generate, ui, confirm-prod',
      argumentHint: '[pane|status|scenarios|report|explain|run|generate|ui|confirm-prod|help]',
    })
    await $.tool.register({
      name: 'run',
      description:
        'Run rook (TestMu AI agent assurance) scenarios against the agent under test in this workspace and return the verdicts: ' +
        'Pass / Fail / Unable to Verify per scenario, failures grouped into root-cause clusters (with cause, whose fault, and a proposed diff when rca ran), ' +
        'failing criteria with expected vs achieved and quoted evidence, and what nobody could verify. ' +
        "Use it after changing the agent's prompt, tools or code. It invokes the real agent (its writes are real) and spends rook credits, " +
        'so prefer `only` with the scenario ids you touched (the rook scenarios tool lists them). Unable to Verify is not Fail. A run can take minutes. ' +
        APPROVALS_NOTE,
      inputSchema: RUN_SCHEMA,
    })
    await $.tool.register({
      name: 'report',
      description:
        "Read a finished rook run from disk (no credits, no agent call): failures grouped into clusters with rook's causes and remedies, " +
        "failing criteria with rook's evidence, verification gaps, rook's next steps, credits. Defaults to the latest run.",
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
    await $.tool.register({
      name: 'scenarios',
      description:
        "Every rook scenario of the agent under test: id, feature, class, category, title, its latest verdict, and whether it is excluded or cannot run. No credits. Use it to choose `only` for the rook run tool.",
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    })
    await $.tool.register({
      name: 'generate',
      description:
        "Write rook scenarios for the agent under test (rook generate): rook reads the agent's features and writes scenarios for those that are new or changed. " +
        'Spends credits and takes minutes; it does not call the agent. Use `instruction` to say what to cover, `force` to re-derive every feature. ' +
        "If the agent gained a capability rook's features do not describe yet, the person needs to run `rook explore .` first. " +
        APPROVALS_NOTE,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', minimum: 1, maximum: 500, description: 'About how many scenarios in total' },
          classes: { type: 'array', items: { type: 'string', enum: ['functional', 'non-functional', 'adversarial'] }, minItems: 1, maxItems: 3 },
          categories: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }, minItems: 1, maxItems: 20 },
          force: { type: 'boolean', description: "Re-derive every feature's scenarios, whatever the pins say" },
          instruction: { type: 'string', maxLength: 2000, description: 'What the scenarios should cover' },
        },
      },
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
    const keys = ['only', 'class', 'category', 'tags', 'profile', 'name', 'concurrency', 'resume', 'continueRun', 'phases', 'instruction'] as const
    const request: RunRequest = {
      ...Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])),
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
    const snapshot = await read($, snapshotAtom)
    const latest = snapshot?.latest
    const health = snapshot && snapshot.current.length > 0 ? countsOf(snapshot.current) : undefined
    const tail = [
      latest
        ? `Latest run ${latest.runId}: ${latest.finished ? 'finished' : `running ${latest.done}/${latest.planned}`} · ` +
          `${latest.counts.pass} Pass · ${latest.counts.fail} Fail · ${latest.counts.unverifiable} Unable to Verify`
        : undefined,
      health
        ? `Every scenario's latest verdict: ${health.pass} Pass · ${health.fail} Fail · ${health.unverifiable} Unable to Verify` +
          `${snapshot!.neverRun > 0 ? ` · ${snapshot!.neverRun} never run` : ''}`
        : undefined,
    ].filter(Boolean)

    return { result: [await statusReply($, ctx), ...tail].join('\n') }
  })

  on('tool.call', { tool: SCENARIOS_TOOL }, async $ => ({ result: await scenariosReply($, ctx) }))

  on('tool.call', { tool: GENERATE_TOOL }, async ($, e, next) => {
    const input = e as unknown as GenerateRequest
    const keys = ['total', 'classes', 'categories', 'instruction'] as const
    const request: GenerateRequest = {
      ...Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])),
      ...(input.force === true && { force: true }),
    }

    return { result: await generateRun($, ctx, request, next.signal) }
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

  // 6 · /rook — Claude Code labels a command's output with the plugin's name already.
  on('command.run', { command: 'rook' }, async ($, e) => {
    const answer = await rookCommand($, ctx, e)

    return { ...answer, text: answer.text.replace(/^rook:\s*/, '') }
  })

  // 2 · the turn's spinner: where Claude's rook run is, at any terminal width
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const running = await read($, runningAtom)

    if (running === null || running.source !== 'tool') {
      return next(e)
    }

    await read($, tickAtom)
    const run = (await read($, snapshotAtom))?.latest
    const message = spinnerText(run?.finished ? undefined : run, running, await $.clock.now())

    return next({ ...e, props: { ...e.props, message } })
  })

  // 2 · the live pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Markdown } = $.ui.resolve(e)
    const snapshot = await read($, snapshotAtom)
    const running = await read($, runningAtom)
    const expanded = await read($, expandedAtom)
    const viewerUrl = await read($, viewerAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)

    if (snapshot === null) {
      return (
        <Box flexDirection="column">
          <Text bold>rook</Text>
          <Text dimColor>No rook workspace in this directory.</Text>
          <Text dimColor>Run `rook explore .` in your agent's repository, then `rook generate` and `rook profile add`.</Text>
        </Box>
      )
    }

    const run = snapshot.latest
    const failed = run?.rows.filter(row => row.status === 'Fail') ?? []
    const gaps = run === undefined ? [] : unlooked(run)
    const clusters = run?.finished ? orderedClusters(run).filter(cluster => cluster.kind !== 'unverifiable' || isExplained(cluster)) : []
    const clustered = new Set(clusters.flatMap(cluster => cluster.scenarios.map(s => s.id)))
    const loose = failed.filter(row => !clustered.has(row.id))
    // Scenarios whose newest verdict is a Fail from an earlier run: the latest run did not cover them.
    const earlier = snapshot.current.filter(row => row.status === 'Fail' && row.runId !== run?.runId)
    const failing = [...new Set([...failed.map(row => row.id), ...earlier.map(row => row.id)])]
    const health = countsOf(snapshot.current)
    const moved = changesIn(snapshot.current, run?.runId)
    const canAct = running === null
    const toggle = (id: string) => update($, expandedAtom, open => (open === id ? null : id))

    const rowDetail = (row: RookScenarioRow, isFixable = true) => (
      <Box key={`d-${row.id}`} flexDirection="column" paddingLeft={2}>
        {row.failing.slice(0, 6).map(c => (
          <Box key={`d-${row.id}-${c.id}`} flexDirection="column">
            <Text wrap="wrap">
              <Text bold>{c.id}</Text> {clip(c.criterion, 300)}
            </Text>
            <Text wrap="wrap">
              <Text color="green">expected </Text>
              {clip(c.expected, 400)}
            </Text>
            <Text wrap="wrap">
              <Text color="red">achieved </Text>
              {clip(c.achieved, 400)}
            </Text>
            {c.evidence !== '' && (
              <Text dimColor wrap="wrap">
                evidence {excerpt(c.evidence, 600)}
              </Text>
            )}
          </Box>
        ))}
        {row.failing.length === 0 && <Text wrap="wrap">{clip(row.summary, 400)}</Text>}
        {isFixable && fixButton(row.id)}
      </Box>
    )

    const clusterDetail = (cluster: RookCluster) => (
      <Box key={`d-${cluster.id}`} flexDirection="column" paddingLeft={2}>
        {cluster.cause !== undefined && <Text wrap="wrap">cause: {clip(cluster.cause, 600)}</Text>}
        {cluster.fault !== undefined && (
          <Text color={cluster.fault === 'agent' ? undefined : 'yellow'}>
            fault: {cluster.fault}
            {cluster.confidence ? ` · ${cluster.confidence} confidence` : ''}
          </Text>
        )}
        {cluster.where.length > 0 && <Text dimColor wrap="truncate-end">where: {cluster.where.join(', ')}</Text>}
        {cluster.remedy !== undefined && <Markdown key={`m-${cluster.id}`} text={excerpt(`**Remedy**\n\n${cluster.remedy}`, 9000)} />}
        {!isExplained(cluster) && <Text dimColor>Not explained yet: re-run with --rca for cause and remedy.</Text>}
        {cluster.scenarios.slice(0, 8).flatMap(s => {
          const row = run?.rows.find(r => r.id === s.id)

          return [
            <Text key={`d-${cluster.id}-${s.id}`} wrap="truncate-end">
              <Text color="red">✗ {s.id}</Text> {s.title}
            </Text>,
            ...(row !== undefined && row.status === 'Fail' ? [rowDetail(row, false)] : []),
          ]
        })}
        {fixButton(cluster.id)}
      </Box>
    )

    function fixButton(id: string) {
      return run !== undefined ? <Button key={`fix-${id}`} label="Fix this with Claude" onPress={() => fixOne($, ctx, run, id)} /> : null
    }

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">
          rook · {snapshot.agentId ?? ''}
          {snapshot.profileId ? <Text dimColor> · profile {snapshot.profileId}</Text> : ''}
        </Text>
        {snapshot.current.length > 0 && (
          <Box flexDirection="row" gap={2}>
            <Text dimColor>agent</Text>
            <Text color="green">✓ {health.pass}</Text>
            <Text color="red">✗ {health.fail}</Text>
            <Text color="yellow">? {health.unverifiable}</Text>
            {snapshot.neverRun > 0 && <Text dimColor>{snapshot.neverRun} never run</Text>}
          </Box>
        )}
        {run === undefined && (
          <Text dimColor>
            {snapshot.neverRun > 0 ? `${snapshot.neverRun} scenarios, none run yet. ` : 'No runs yet. '}Press Run all, or ask Claude to test the agent.
          </Text>
        )}
        {run !== undefined && (
          <Text dimColor wrap="truncate-end">
            latest: {run.name ? `${run.name} · ` : ''}
            {run.runId}
          </Text>
        )}
        {run !== undefined && (
          <Text>
            {progressBar(run.done, run.planned, Math.min(30, width - 16))} {run.done}/{run.planned} {run.finished ? 'done' : isReporting(run) ? REPORTING : 'running'}
          </Text>
        )}
        {run !== undefined && (
          <Box flexDirection="row" gap={2}>
            <Text color="green">✓ {run.counts.pass} Pass</Text>
            <Text color="red">✗ {run.counts.fail} Fail</Text>
            <Text color="yellow">? {run.counts.unverifiable} Unable to Verify</Text>
          </Box>
        )}
        {run?.finished && metricsLine(run) !== '' && <Text dimColor>{metricsLine(run)}</Text>}
        {(moved.fixed.length > 0 || moved.regressed.length > 0) && (
          <Text wrap="truncate-end">
            {moved.fixed.length > 0 && <Text color="green">↑ fixed {moved.fixed.map(row => row.id).join(', ')} </Text>}
            {moved.regressed.length > 0 && <Text color="red">↓ regressed {moved.regressed.map(row => row.id).join(', ')}</Text>}
          </Text>
        )}
        {running !== null && (
          <Text color="cyan">
            ▸ running {running.label} · {duration(Math.max(0, now - running.startedAt))}
          </Text>
        )}
        {run !== undefined &&
          !run.finished &&
          run.lanes.slice(0, 8).map(lane => {
            const elapsed = lane.since > 0 ? Math.max(0, now - lane.since) : undefined

            return (
              <Box key={`l-${lane.id}`}>
                <Text wrap="truncate-end">
                  <Text color="cyan">⟡ {lane.id}</Text>
                  {elapsed !== undefined && <Text color={elapsed > 60_000 ? 'yellow' : undefined}> {duration(elapsed)}</Text>}
                  <Text dimColor> {lane.phase}</Text> {lane.title}
                </Text>
              </Box>
            )
          })}
        {run?.headline !== undefined && <Text wrap="wrap">{run.headline}</Text>}
        {clusters.length > 0 && <Text bold>Clusters</Text>}
        {clusters.slice(0, 8).flatMap(cluster => [
          <Button
            key={`c-${cluster.id}`}
            plain
            label={`${expanded === cluster.id ? '▾' : '▸'} ${cluster.id} ${cluster.kind === 'compromised' ? '[compromised] ' : ''}${clip(cluster.why, width - 24)} (${cluster.scenarios.length})${isExplained(cluster) ? ' · remedy' : ''}`}
            onPress={() => toggle(cluster.id)}
          />,
          ...(expanded === cluster.id ? [clusterDetail(cluster)] : []),
        ])}
        {loose.length > 0 && <Text bold>Failed</Text>}
        {loose.slice(0, 12).flatMap(row => [
          <Button
            key={`f-${row.id}`}
            plain
            label={`${expanded === row.id ? '▾' : '▸'} ✗ ${row.id} ${row.compromised ? '[compromised] ' : ''}${clip(row.title || row.summary, width - 16)}`}
            onPress={() => toggle(row.id)}
          />,
          ...(expanded === row.id ? [rowDetail(row)] : []),
        ])}
        {earlier.length > 0 && <Text bold>Still failing from earlier runs</Text>}
        {earlier.slice(0, 12).map(row => (
          <Box key={`e-${row.id}`}>
            <Text wrap="truncate-end">
              <Text color="red">✗ {row.id}</Text> {row.title} <Text dimColor>· {row.runId}</Text>
            </Text>
          </Box>
        ))}
        {gaps.length > 0 && <Text bold>What nobody looked at</Text>}
        {gaps.slice(0, 8).map(row => (
          <Box key={`g-${row.id}`}>
            <Text dimColor wrap="truncate-end">
              ? {row.id}
              {row.reason ? ` (${reasonText(row.reason)})` : ''} {gapText(row, width)}
            </Text>
          </Box>
        ))}
        {run?.finished && run.next.length > 0 && <Text bold>Next</Text>}
        {run?.finished &&
          run.next.slice(0, 3).map((step, at) => (
            <Text key={`n-${at}`} dimColor wrap="wrap">
              · {clip(step, 240)}
            </Text>
          ))}
        <Box flexDirection="row" gap={1}>
          {canAct && <Button key="run-all" label="Run all" hotkey="r" onPress={() => paneRun($, ctx, {})} />}
          {canAct && failing.length > 0 && (
            <Button key="rerun-failed" label="Re-run failed" hotkey="f" onPress={() => paneRun($, ctx, { only: failing })} />
          )}
          {failed.length > 0 && run !== undefined && (
            <Button key="fix" label="Fix with Claude" variant="primary" hotkey="x" onPress={() => fixWithClaude($, ctx, run)} />
          )}
          {viewerUrl === null && (
            <Button key="viewer" label="Evidence viewer" hotkey="v" onPress={async () => $.ui.toast(await startViewer($, ctx))} />
          )}
        </Box>
        {viewerUrl !== null && (
          <Box key="viewer-link">
            {/* rook's viewer answers localhost as well as 127.0.0.1; a Link takes only the name. */}
            <Link href={viewerUrl.replace('//127.0.0.1:', '//localhost:')} label={`evidence viewer ${viewerUrl.replace('//127.0.0.1:', '//localhost:')}`} />
          </Box>
        )}
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
