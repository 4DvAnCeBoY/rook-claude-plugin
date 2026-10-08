import { atom, read, update } from 'claude-code'
import type { CommandRunInput, EngineInterface, Register } from 'claude-code'

import type { RookCluster, RookConfirm, RookReadiness, RookRunView, RookScenarioRow, RookSnapshot, RookStepId, RookTab } from '../types'
import type { El } from './views/kit'
import { TabBar } from './views/tabs'
import { ConfirmBar } from './views/confirm'
import { SetupTab } from './views/setup'
// ── imports: progress
import { JobLanes } from './views/job'
// ── end imports: progress

// ── imports: health
// ── end imports: health

// ── imports: runs tab
import { RunsTab } from './views/runs'
// ── end imports: runs tab

// ── imports: scenarios tab
import { ScenariosTab } from './views/scenarios'
// ── end imports: scenarios tab

// ── imports: setup tab
// ── end imports: setup tab

// ── imports: band
// ── end imports: band

// ── imports: status line
// ── end imports: status line

// ── imports: card
// ── end imports: card

// ── imports: ci
import { parseCiArgs, previewText, WORKFLOW_PATH, workflowYaml, writtenText } from './ci'
import type { CiPlan, CiRequest } from './ci'
// ── end imports: ci
import {
  agentsText,
  balanceText,
  balanceWarning,
  clip,
  clusterNote,
  curateText,
  creditsPerScenario,
  duration,
  excerpt,
  exploreText,
  failureContext,
  failureNote,
  gapText,
  generateText,
  isExplained,
  isReporting,
  metricsLine,
  orderedClusters,
  profilesText,
  profileTestText,
  progressBar,
  projectsText,
  rcaLine,
  reasonText,
  REPORTING,
  retestPrompt,
  runSummary,
  runsText,
  scenariosText,
  spinnerText,
  staleLine,
  statusLine,
  statusText,
  unlooked,
} from './format'
import { assess, declaredVariables, isRunCommand } from './guard'
import { impactOf, indexAgent, relativeTo } from './impact'
import { authOf, blockedText, blockerOf, checklistText, diskFacts, learned, NEEDS, readinessOf, setupLine, versionOf } from './readiness'
import type { CliFacts } from './readiness'
import type { AgentIndex } from './impact'
import {
  agentUseArgs,
  allowRulesOf,
  balanceOf,
  CLI_ENV,
  curateArgs,
  exploreArgs,
  failureOf,
  generateArgs,
  jsonOf,
  parseAgentList,
  parseExploreFlags,
  parseGenerateFlags,
  parseRunFlags,
  profileArgs,
  projectArgs,
  rcaOutcome,
  reportRcaArgs,
  runArgs,
} from './rook'
import type { Approval, CliResult, ExploreRequest, GenerateRequest, ProfileRequest, ProjectRequest, RunRequest } from './rook'
import { agentIdsOf, changesIn, countsOf, currentVerdicts, locate, projectDirName, readRun, ROOT, RUN_ID, runIds, runsElsewhere, runSummaries, scenarioSignature } from './workspace'
import type { Io, Located, RowCache } from './workspace'

/**
 * rook inside Claude Code.
 *
 *  1. Tools the model calls — `run`, `report`, `status`, `scenarios`,
 *     `generate` — so Claude can test the agent it is building, read rook's
 *     evidence and root-cause clusters back, and write scenarios for it;
 *     `project`, `explore`, `profile_test` so a repository with no rook
 *     setup gets one without leaving Claude Code.
 *  2. A live pane: every scenario's latest verdict, the run in flight lane by
 *     lane, clusters with rook's remedies, failures you can open, and what
 *     nobody looked at. The turn's spinner carries the run's progress too.
 *  3. A band above the prompt when Claude edits a file the agent is built
 *     from: which scenarios touch it, and a button to re-test them.
 *  4. Failures of a run started elsewhere handed to Claude as context.
 *  5. A status line score over every scenario's latest verdict, with what the
 *     latest run fixed or regressed.
 *  6. `/rook` — pane, status, report, explain, run, scenarios, agent,
 *     generate, project, explore, profile, ui, confirm-prod.
 *  7. A guard that refuses runs against a production-looking target until
 *     the person confirms.
 *  8. Depth: `report --rca` on a finished run, agent switching, scenario
 *     curation (`agent`, `curate` tools), and the credit balance.
 *  9. A setup checklist (installed, signed in, project, agent, scenarios,
 *     profile) wherever rook would refuse, with the one next step.
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
const lastErrorAtom = atom({ plugin: 'rook', key: 'lastError' } as const, null)
const agentsAtom = atom({ plugin: 'rook', key: 'agents' } as const, [])
const balanceAtom = atom({ plugin: 'rook', key: 'balance' } as const, null)
const explainingAtom = atom({ plugin: 'rook', key: 'explaining' } as const, null)
const tabAtom = atom({ plugin: 'rook', key: 'tab' } as const, 'health')
const confirmAtom = atom({ plugin: 'rook', key: 'confirm' } as const, null)

// ── atoms: progress
const jobAtom = atom({ plugin: 'rook', key: 'job' } as const, null)
// ── end atoms: progress

// ── atoms: health
// ── end atoms: health

// ── atoms: runs tab
const historyAtom = atom({ plugin: 'rook', key: 'history' } as const, null)
const compareAtom = atom({ plugin: 'rook', key: 'compare' } as const, [])
// ── end atoms: runs tab

// ── atoms: scenarios tab
const selectedAtom = atom({ plugin: 'rook', key: 'selected' } as const, [])
const filterAtom = atom({ plugin: 'rook', key: 'filter' } as const, 'all')
const draftAtom = atom({ plugin: 'rook', key: 'draft' } as const, '')
const flakyAtom = atom({ plugin: 'rook', key: 'flaky' } as const, {})
// ── end atoms: scenarios tab

// ── atoms: setup tab
const budgetAtom = atom({ plugin: 'rook', key: 'budget' } as const, null)
// ── end atoms: setup tab

// ── atoms: band
const untickedAtom = atom({ plugin: 'rook', key: 'unticked' } as const, [])
// ── end atoms: band

// ── atoms: status line
// ── end atoms: status line

// ── atoms: card
// ── end atoms: card

// ── atoms: ci
// ── end atoms: ci

// The plugin's own tools as exact patterns: the engine's tool table is laid
// when the mod loads, before session.start registers them.
const RUN_TOOL = /^mcp__rook__run$/
const REPORT_TOOL = /^mcp__rook__report$/
const STATUS_TOOL = /^mcp__rook__status$/
const SCENARIOS_TOOL = /^mcp__rook__scenarios$/
const RUNS_TOOL = /^mcp__rook__runs$/
const GENERATE_TOOL = /^mcp__rook__generate$/
const PROJECT_TOOL = /^mcp__rook__project$/
const EXPLORE_TOOL = /^mcp__rook__explore$/
const PROFILE_TOOL = /^mcp__rook__profile_test$/
const AGENT_TOOL = /^mcp__rook__agent$/
const CURATE_TOOL = /^mcp__rook__curate$/
// ── tool patterns: runs tab
// ── end tool patterns: runs tab
// ── tool patterns: setup tab
// ── end tool patterns: setup tab
// ── tool patterns: ci
const CI_TOOL = /^mcp__rook__ci$/
// ── end tool patterns: ci
/** Every tool that writes a file; MultiEdit exists on some builds only. */
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/

const USAGE = [
  '/rook                 open the live verdict pane',
  '/rook status          agents, scenarios and sync state',
  '/rook scenarios       every scenario with its latest verdict',
  '/rook runs [N]        the agent\'s runs on disk, newest first (default 20)',
  '/rook scenarios exclude|include SC-001 [SC-002 …]   leave scenarios out of runs, or bring them back',
  '/rook agent [list|use <id>]   the project\'s agents; switch the active one',
  '/rook report [run]    the latest (or named) run: clusters, verdicts, gaps, credits',
  "/rook explain [run]   hand the run's failures (and rook's remedies) to Claude as fix context",
  '/rook report|explain [run] --rca   have rook explain the clusters first, without calling the agent',
  '          (free if this agent version was explained already, otherwise it costs credits)',
  '/rook run [--only SC-001,SC-002] [--class …] [--category …] [--tag …] [--profile …] [--name …]',
  '          [--concurrency 1-8] [--resume <run>] [--run <run> --phases collect,judge] [--test] [--rca] [-- <instruction>]',
  '/rook generate [--total N] [--class …] [--category …] [--force] [-- <what to cover>]',
  '/rook project [list|use <id>|create <name>]  the rook project this workspace records to',
  "/rook explore [--force] [-- <instruction>]   read this repository: find the agents, write their features",
  '/rook profile [list|use <id>|test [id] [-- <goal>]]  how rook reaches the agent (add one: ! rook profile add …)',
  '/rook ui              open the on-disk results viewer (rook ui --local)',
  '/rook confirm-prod [profile]  allow runs against a production-looking target for 15 minutes',
  '',
  "Runs, generate, explore and profile test approve rook's own tool calls with --yes, unless allowRules is set in /config.",
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
  /** The scenario and feature files as last indexed, to notice changes made elsewhere. */
  indexSignature: string | undefined
  /** The `rook ui --local` child, while it serves. */
  viewer: AbortController | undefined
  rows: RowCache
  /** Installed and signed in, as the CLI last said: probed at start and when they block, not every poll. */
  cli: CliFacts
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

    return { exitCode: ran.exitCode, doc: jsonOf(ran.stdout), stderr: ran.stderr, stdout: ran.stdout }
  } catch (error) {
    return { exitCode: 1, doc: undefined, stderr: `could not run ${ctx.bin}: ${String(error)}` }
  }
}

/**
 * A run can outlast `process.run`'s ten-minute ceiling, so it is streamed: the
 * child lives as long as the loop reading it, and `signal` ends both.
 */
async function rookRun($: EngineInterface, ctx: Ctx, argv: string[], signal?: AbortSignal, env: Record<string, string> = {}): Promise<CliResult> {
  const stream = $.process.spawn({ argv: [ctx.bin, ...argv], env: { ...CLI_ENV, ...env }, input: '', ...(ctx.cwd !== '' && { cwd: ctx.cwd }) })
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

      return { exitCode: ended?.code ?? 1, doc: jsonOf(stdout), stderr, stdout }
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

  // A workspace that cannot run yet says which step is missing; outside one, nothing.
  const line = [statusLine(snapshot, running !== null), setupLine(snapshot?.readiness)].filter(Boolean).join(' · ')

  $.ui.status(line === '' ? undefined : line)
}

// ── readiness ────────────────────────────────────────────────────────────────

/** Ask the CLI what only it knows: installed, signed in. Two short calls, never on the poll. */
async function probe($: EngineInterface, ctx: Ctx): Promise<void> {
  const run = (args: string[]) =>
    $.process.run([ctx.bin, ...args], { env: CLI_ENV, stdin: '', timeoutMs: 20_000, ...(ctx.cwd !== '' && { cwd: ctx.cwd }) }).catch(() => undefined)
  const version = await run(['--version'])
  const installed = version === undefined ? null : versionOf(version.exitCode, version.stdout)

  if (installed === null) {
    ctx.cli = { ...ctx.cli, version: null }

    return
  }

  const auth = await run(['auth', 'status'])

  ctx.cli = { ...ctx.cli, version: installed, auth: auth === undefined ? 'unknown' : authOf(auth.exitCode, `${auth.stdout}\n${auth.stderr}`) }
}

async function readinessNow($: EngineInterface, ctx: Ctx): Promise<RookReadiness | undefined> {
  await poll($, ctx)

  return (await read($, snapshotAtom))?.readiness
}

/**
 * Why an action cannot be taken yet, in the checklist's words, or undefined.
 * A step the CLI decides is probed again before refusing: the person may have
 * run `! rook login` since.
 */
async function setupBlock($: EngineInterface, ctx: Ctx, need: readonly RookStepId[], doing: string): Promise<string | undefined> {
  let readiness = await readinessNow($, ctx)
  const step = blockerOf(readiness, need)

  if (step?.id === 'installed' || step?.id === 'signed_in') {
    await probe($, ctx)
    readiness = await readinessNow($, ctx)
  }

  return blockedText(readiness, need, doing)
}

/** A failed rook command that names a setup step (a remedy code, a missing binary) updates the checklist. */
async function learn($: EngineInterface, ctx: Ctx, result: CliResult): Promise<RookReadiness | undefined> {
  const next = learned(ctx.cli, await diskFacts(ioOf($, ctx)), result)

  if (next === undefined) {
    return undefined
  }

  ctx.cli = next

  return readinessNow($, ctx)
}

/** A failure with the setup step it revealed, when it revealed one. */
async function explained($: EngineInterface, ctx: Ctx, result: CliResult, problem: string, need: readonly RookStepId[], doing: string): Promise<string> {
  const blocked = blockedText(await learn($, ctx, result), need, doing)

  return blocked === undefined ? problem : `${problem}\n${blocked}`
}

/** "Check again" in the pane's checklist. */
async function recheck($: EngineInterface, ctx: Ctx): Promise<void> {
  ctx.cli = { ...ctx.cli, projectRefused: undefined }
  await probe($, ctx)
  await poll($, ctx)
}

async function poll($: EngineInterface, ctx: Ctx): Promise<void> {
  if (ctx.isPolling) {
    return
  }

  ctx.isPolling = true

  try {
    const io = ioOf($, ctx)
    const readiness = readinessOf(await diskFacts(io), ctx.cli)
    const loc = await where($, ctx)
    const before = await read($, snapshotAtom)

    if (loc === undefined) {
      // No agent to read: the snapshot carries only the checklist.
      const bare: RookSnapshot = { current: [], neverRun: 0, checkedAt: await $.clock.now(), readiness }

      if (JSON.stringify({ ...before, checkedAt: 0 }) !== JSON.stringify({ ...bare, checkedAt: 0 })) {
        await update($, snapshotAtom, () => bare)
      }

      return
    }

    await syncAgents($, ctx, loc)

    // Scenarios or features changed outside this session (rook generate in a
    // terminal, an exclude): re-read the index and redraw.
    const signature = `${loc.agentDir}#${await scenarioSignature(io, loc.agentDir)}`

    if (ctx.indexSignature !== signature) {
      if (ctx.indexSignature !== undefined) {
        ctx.agentIndex = undefined
        ctx.isDirty = true
      }

      ctx.indexSignature = signature
    }

    const ids = await runIds(io, loc.agentDir)
    const latestId = ids[0]
    const isSettled =
      !ctx.isDirty && before?.agentId === loc.agentId && before.latest?.runId === latestId && before.latest?.finished === true

    if (isSettled) {
      if (JSON.stringify(before.readiness) !== JSON.stringify(readiness)) {
        await update($, snapshotAtom, snapshot => (snapshot === null ? null : { ...snapshot, readiness }))
      }

      return
    }

    ctx.isDirty = false

    const latest = latestId === undefined ? undefined : await readRun(io, loc.agentDir, latestId, ctx.rows)
    const index = ctx.agentIndex ?? (await indexAgent(io, loc.agentDir))
    ctx.agentIndex = index
    const current = await currentVerdicts(io, loc.agentDir, ids, ctx.rows, new Set(index.scenarios.map(scenario => scenario.id)))
    const judged = new Set(current.map(row => row.id))
    const profileId = (await io.read(`${loc.agentDir}/profiles/active`))?.trim()
    const snapshot: RookSnapshot = {
      agentId: loc.agentId,
      ...(profileId !== undefined && profileId !== '' && { profileId }),
      ...(latest !== undefined && { latest }),
      current,
      neverRun: index.scenarios.filter(scenario => !judged.has(scenario.id)).length,
      runCount: ids.length,
      // Only looked for when this project has no runs: it explains an empty pane.
      ...(ids.length === 0 && { elsewhere: await runsElsewhere(io, loc.projectDir) }),
      checkedAt: await $.clock.now(),
      readiness,
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
    const result = await rookRun($, ctx, argv)
    const problem = failureOf(result)

    if (problem !== undefined) {
      // A toast vanishes; the pane keeps the failure until the next run starts.
      const text = await explained($, ctx, result, `run failed: ${problem}`, NEEDS.run, 'run')

      const at = await $.clock.now()

      await update($, lastErrorAtom, () => ({ source: 'run', text, at }))
      $.ui.toast(`rook: ${clip(text, 200)}`)
    }
  } catch (error) {
    const text = `could not start ${ctx.bin} — ${clip(String(error), 120)}`

    const at = await $.clock.now()

    await update($, lastErrorAtom, () => ({ source: 'run', text, at }))
    $.ui.toast(`rook: ${text}`)
  } finally {
    await update($, runningAtom, () => null)
    await poll($, ctx)
    await refreshBalance($, ctx)
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

  const unready = await setupBlock($, ctx, NEEDS.run, 'run')

  if (unready !== undefined) {
    return `rook: ${unready}`
  }

  const blocked = (await prodBlock($, ctx, request.profile)) ?? (await budgetBlock($, ctx, 'run'))

  if (blocked !== undefined) {
    return blocked
  }

  const label = request.only ? request.only.join(', ') : 'all runnable scenarios'

  const startedAt = await $.clock.now()

  await update($, runningAtom, () => ({ startedAt, label, source }))
  await update($, lastErrorAtom, () => null)
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

  const unready = await setupBlock($, ctx, NEEDS.run, 'run')

  if (unready !== undefined) {
    return { deny: `rook ${unready}` }
  }

  const blocked = (await prodBlock($, ctx, request.profile)) ?? (await budgetBlock($, ctx, 'run'))

  if (blocked !== undefined) {
    return { deny: blocked }
  }

  const startedAt = await $.clock.now()

  await update($, runningAtom, () => ({ startedAt, label: request.only?.join(', ') ?? 'all', source: 'tool' }))
  await update($, lastErrorAtom, () => null)
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
      return { result: await explained($, ctx, result, `rook run did not complete: ${problem}`, NEEDS.run, 'run') }
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
    const short = balanceWarning(await refreshBalance($, ctx), creditsPerScenario(run), run.counts.fail > 0 ? run.counts.fail : run.done)

    return { result: runSummary(run, loc.agentDir, loc.agentId, doc?.credits) + halted + (short === undefined ? '' : `\n${short}`) }
  } finally {
    await update($, runningAtom, () => null)
    await poll($, ctx)
  }
}

async function reportText($: EngineInterface, ctx: Ctx, runRef: string | undefined): Promise<{ text: string; context?: string }> {
  const loc = await where($, ctx)

  if (loc === undefined) {
    const readiness = await readinessNow($, ctx)

    return { text: readiness === undefined ? 'no rook agent in this directory.' : checklistText(readiness) }
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
  // `rook status` refuses without a project; the checklist is the better answer then.
  if ((await setupBlock($, ctx, NEEDS.status, 'read status')) !== undefined) {
    const readiness = await read($, snapshotAtom)

    return readiness?.readiness === undefined ? 'status is not available yet.' : checklistText(readiness.readiness)
  }

  const status = await rookJson($, ctx, ['status', '--json'])
  const problem = failureOf(status)

  if (status.doc === undefined || problem !== undefined) {
    const learnt = await learn($, ctx, status)

    return learnt === undefined ? `status failed: ${problem ?? 'no output'}` : checklistText(learnt)
  }

  return statusText(status.doc)
}

/** Every scenario with its latest verdict: rook's list, or the files on disk when rook cannot answer. */
/** The agent's runs, newest first, from run.yaml and report.yaml: no CLI call, no credits. */
async function runsReply($: EngineInterface, ctx: Ctx, limit: number): Promise<string> {
  const blocked = await setupBlock($, ctx, ['agent'], 'list runs')
  const loc = await where($, ctx)

  if (blocked !== undefined || loc === undefined) {
    return `rook: ${blocked ?? "can't list runs yet: no agent here."}`
  }

  const io = ioOf($, ctx)
  const ids = await runIds(io, loc.agentDir)

  return runsText(loc.agentId, await runSummaries(io, loc.agentDir, ids, limit), ids.length)
}

async function scenariosReply($: EngineInterface, ctx: Ctx): Promise<string> {
  await poll($, ctx)
  const snapshot = await read($, snapshotAtom)
  const current = snapshot?.current ?? []
  // Without a project rook only refuses: read the files on disk straight away.
  const listed = blockerOf(snapshot?.readiness, NEEDS.status) === undefined ? await rookJson($, ctx, ['scenarios', 'list', '--json']) : undefined

  if (listed !== undefined && listed.doc !== undefined && failureOf(listed) === undefined) {
    return scenariosText(listed.doc, current)
  }

  const loc = ctx.located ?? (await where($, ctx))

  if (loc === undefined) {
    const readiness = await readinessNow($, ctx)

    return readiness === undefined ? 'no rook agent in this directory.' : checklistText(readiness)
  }

  const index = ctx.agentIndex ?? (await indexAgent(ioOf($, ctx), loc.agentDir))
  ctx.agentIndex = index
  if (listed !== undefined) {
    await learn($, ctx, listed)
  }

  const unready = await setupBlock($, ctx, NEEDS.run, 'run them')

  return (
    scenariosText({ agent_id: loc.agentId, total: index.scenarios.length, scenarios: index.scenarios.map(s => ({ scenario_id: s.id, title: s.title, feature_id: s.featureId })) }, current) +
    (listed === undefined ? '\n(from the files on disk)' : `\n(from the files on disk: rook scenarios list failed — ${clip(failureOf(listed) ?? 'no output', 160)})`) +
    (unready === undefined ? '' : `\n${unready}`)
  )
}

/** `rook generate`, streamed like a run: it reads the code and writes scenarios, which takes minutes. */
async function generateRun($: EngineInterface, ctx: Ctx, request: GenerateRequest, signal?: AbortSignal): Promise<string> {
  const args = generateArgs(request, ctx.approval)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  const unready = (await setupBlock($, ctx, NEEDS.generate, 'generate scenarios')) ?? (await budgetBlock($, ctx, 'generate'))

  if (unready !== undefined) {
    return `rook: ${unready.replace(/^rook:\s*/, '')}`
  }

  try {
    const result = await rookRun($, ctx, args.argv, signal)
    const problem = failureOf(result)

    return problem !== undefined && (result.doc === undefined || (result.doc as { ok?: unknown }).ok === false)
      ? await explained($, ctx, result, `rook generate did not complete: ${problem}`, NEEDS.generate, 'generate scenarios')
      : generateText(result.doc, result.stdout ?? '') + (problem ? `\n${problem}` : '')
  } finally {
    ctx.agentIndex = undefined // the scenario set changed
    ctx.isDirty = true
    await poll($, ctx)
    await refreshBalance($, ctx)
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

/** `/rook generate`: in the background, its failure kept in the pane as well as toasted. */
async function backgroundGenerate($: EngineInterface, ctx: Ctx, request: GenerateRequest): Promise<void> {
  await update($, lastErrorAtom, () => null)
  const text = await generateRun($, ctx, request).catch(error => `rook generate failed: ${String(error)}`)

  // What was written always opens "rook generate: N scenario files written"; anything else failed.
  if (!text.startsWith('rook generate:')) {
    const at = await $.clock.now()

    await update($, lastErrorAtom, () => ({ source: 'generate', text: text.replace(/^rook(?::\s*|\s+)/, ''), at }))
  }

  $.ui.toast(clip(text, 300))
}

async function paneRun($: EngineInterface, ctx: Ctx, request: RunRequest): Promise<void> {
  $.ui.toast(await startRun($, ctx, request, 'pane'))
}

async function probeThenPoll($: EngineInterface, ctx: Ctx): Promise<void> {
  await probe($, ctx)
  await poll($, ctx)
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
      const readiness = await readinessNow($, ctx)
      const setup = readiness?.next === undefined ? '' : `\n${checklistText(readiness)}`

      return { text: (opened.isPlaced ? 'pane opened.' : `pane is waiting: ${opened.reason}`) + setup }
    }
    case 'tab': {
      const tab = rest[0] as RookTab | undefined

      if (tab !== 'health' && tab !== 'runs' && tab !== 'scenarios' && tab !== 'setup') {
        return { text: 'rook: tab health, runs, scenarios or setup.' }
      }

      await setTab($, tab)
      await $.ui.open({ id: PANE, title: 'rook' })

      return { text: `${tab} tab open.` }
    }
    case 'compare':
      return { text: await compareReply($, ctx, rest) }
    case 'flaky':
      return { text: await flakyReply($, ctx, rest) }
    case 'sync':
      return { text: await syncReply($, ctx) }
    case 'budget':
      return { text: await budgetReply($, ctx, rest) }
    case 'ci':
      return { text: await ciReply($, ctx, rest) }
    case 'status':
      return { text: await statusReply($, ctx) }
    case 'runs':
      return { text: await runsReply($, ctx, rest[0] !== undefined && /^\d{1,3}$/.test(rest[0]) ? Math.min(100, Math.max(1, Number(rest[0]))) : 20) }
    case 'scenarios':
      return { text: rest[0] === undefined || rest[0] === 'list' ? await scenariosReply($, ctx) : await curateReply($, ctx, rest[0], rest.slice(1).join(',').split(',').filter(Boolean)) }
    case 'agent':
    case 'agents':
      return { text: rest[0] === 'use' ? await switchAgent($, ctx, rest[1]) : await agentsReply($, ctx) }
    case 'report':
      if (rest.includes('--rca')) {
        return { text: await startExplain($, ctx, rest.find(word => word !== '--rca'), false) }
      }

      return { text: (await reportText($, ctx, rest[0])).text }
    case 'explain': {
      if (rest.includes('--rca')) {
        return { text: await startExplain($, ctx, rest.find(word => word !== '--rca'), true) }
      }

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

      const unready = await setupBlock($, ctx, NEEDS.generate, 'generate scenarios')

      if (unready !== undefined) {
        return { text: unready }
      }

      $.clock.after(0, () => backgroundGenerate($, ctx, request))

      return { text: 'generating scenarios in the background. A toast says when they are written; /rook scenarios lists them.' }
    }
    case 'project': {
      const [action = 'list', ...words] = rest

      if (action !== 'list' && action !== 'use' && action !== 'create') {
        return { text: 'rook: /rook project [list|use <id>|create <name>]' }
      }

      return { text: await projectReply($, ctx, action === 'use' ? { action, id: words[0] ?? '' } : action === 'create' ? { action, name: words.join(' ') } : { action }) }
    }
    case 'explore': {
      const request = parseExploreFlags(tail)

      if ('error' in request) {
        return { text: `rook: ${request.error}` }
      }

      const unready = await setupBlock($, ctx, NEEDS.explore, 'explore this repository')

      if (unready !== undefined) {
        return { text: unready }
      }

      $.clock.after(0, async () => $.ui.toast(clip(await exploreRun($, ctx, request).catch(error => `rook explore failed: ${String(error)}`), 300)))

      return { text: 'rook: exploring this repository in the background (minutes, spends credits). A toast says what it found; the pane picks the agent up.' }
    }
    case 'profile': {
      const [action = 'list', id] = rest
      const after = tail.slice(action.length).trim()
      const dashes = after.search(/(^|\s)--(\s|$)/)
      const goal = dashes < 0 ? '' : after.slice(dashes).replace(/^\s*--/, '').trim()

      if (action === 'add') {
        return { text: 'rook: profile add asks for connection details: type `! rook profile add <name> --from connection.md` (or --command \'<how the agent starts>\').' }
      }

      if (action !== 'list' && action !== 'use' && action !== 'test') {
        return { text: 'rook: /rook profile [list|use <id>|test [id] [-- <goal>]]' }
      }

      const request: ProfileRequest = { action, ...(id !== undefined && id !== '--' && { profile: id }), ...(goal !== '' && { goal }) }

      if (action !== 'test') {
        const answer = await profileReply($, ctx, request)

        return { text: 'deny' in answer ? answer.deny : answer.result }
      }

      // Checked before going to the background, so a refusal shows here and not in a toast.
      const args = profileArgs(request, ctx.approval)
      const unready = 'error' in args ? undefined : await setupBlock($, ctx, NEEDS.profileTest, 'test a profile')
      const blocked = 'error' in args ? `rook: ${args.error}` : unready !== undefined ? `rook: ${unready}` : await prodBlock($, ctx, request.profile)

      if (blocked !== undefined) {
        return { text: blocked }
      }

      $.clock.after(0, async () => {
        const answer = await profileReply($, ctx, request).catch(error => ({ deny: `rook profile test failed: ${String(error)}` }))

        $.ui.toast(clip('deny' in answer ? answer.deny : answer.result, 300))
      })

      return { text: `rook: testing ${request.profile ?? 'the active profile'} in the background: one call to the agent. A toast says what came back.` }
    }
    case 'ui':
    case 'viewer': {
      const url = await startViewer($, ctx)

      return { text: url.startsWith('http') ? `viewer: ${url} (read only: scenarios, runs, request/response and evidence files)` : url }
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

// ── setup from inside Claude Code: project, explore, profile ────────────────

/** `rook project`, `project use <id>`, `project create <name>`: no credits, no agent call. */
async function projectReply($: EngineInterface, ctx: Ctx, request: ProjectRequest): Promise<string> {
  const args = projectArgs(request)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  if (args.argv[1] === '--json') {
    let listed = await rookJson($, ctx, args.argv)

    // A rook from before `project --json` refuses the flag; its plain listing carries the same rows.
    if (listed.doc === undefined && /unknown option/i.test(listed.stderr)) {
      listed = await rookJson($, ctx, ['project'])
    }

    const problem = failureOf(listed)

    return problem === undefined ? projectsText(listed.doc, listed.stdout ?? '') : `rook project failed: ${problem}`
  }

  const ran = await rookJson($, ctx, args.argv)
  const problem = failureOf(ran)

  ctx.isDirty = true
  await poll($, ctx)

  return problem === undefined ? `rook: ${clip(ran.stdout?.trim() || 'done', 300)}` : `rook project ${args.argv[1]} failed: ${problem}`
}

/**
 * `rook explore .`, streamed like a run: it reads the codebase and writes
 * agents and features, which takes minutes and spends credits. A workspace
 * that did not exist may afterwards, so the pane is re-read from scratch.
 */
/** The agents rook has written for the selected project, with their feature counts: what explore actually produced. */
async function agentsOnDisk($: EngineInterface, ctx: Ctx): Promise<{ id: string; features: number }[]> {
  const io = ioOf($, ctx)
  const facts = await diskFacts(io)
  const projects = await io.list(`${ROOT}/projects`).catch(() => [])
  const project = projectDirName(projects.filter(entry => entry.kind === 'dir').map(entry => entry.name), facts.projectId)

  if (project === undefined) {
    return []
  }

  const projectDir = `${ROOT}/projects/${project}`
  const found: { id: string; features: number }[] = []

  for (const id of await agentIdsOf(io, projectDir)) {
    const features = (await io.list(`${projectDir}/agents/${id}/features`).catch(() => [])).filter(entry => entry.name.endsWith('.yaml')).length
    found.push({ id, features })
  }

  return found
}

async function exploreRun($: EngineInterface, ctx: Ctx, request: ExploreRequest, signal?: AbortSignal): Promise<string> {
  const args = exploreArgs(request, ctx.approval)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  const unready = await setupBlock($, ctx, NEEDS.explore, 'explore this repository')

  if (unready !== undefined) {
    return `rook: ${unready}`
  }

  try {
    const result = await rookRun($, ctx, args.argv, signal)

    if (result.exitCode !== 0) {
      const problem = failureOf(result) ?? `rook exited ${result.exitCode}`

      return `rook explore did not complete: ${problem}${/project/i.test(problem) ? ' (the rook project tool lists and selects projects)' : ''}`
    }

    return exploreText(result.stdout ?? '', await agentsOnDisk($, ctx))
  } finally {
    ctx.agentIndex = undefined // agents and features were written
    ctx.isDirty = true
    await poll($, ctx)
  }
}

/**
 * State directories for a profile test. `rook profile test` hands the scripts
 * none (a run does), so a profile that keeps its session in ROOK_STATE_DIR
 * failed with "ROOK_STATE_DIR is required" before reaching the agent. rook
 * passes its own environment to the scripts and sets these only when it has
 * one, so a run still uses its own per-scenario directory. A fresh pair per
 * test, under the system temp directory: no session carries from one test to
 * the next, and nothing collects in the repository.
 */
async function probeStateEnv($: EngineInterface): Promise<Record<string, string>> {
  const base = `${((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')}/rook-profile-test-${await $.clock.now()}`

  return { ROOK_STATE_DIR: `${base}/state`, ROOK_RUN_STATE_DIR: `${base}/run-state` }
}

/**
 * `rook profile` (list), `profile use <id>`, `profile test [id]`. A test calls
 * the real agent through the profile, so the production guard applies to the
 * profile being tested.
 */
async function profileReply($: EngineInterface, ctx: Ctx, request: ProfileRequest, signal?: AbortSignal): Promise<{ result: string } | { deny: string }> {
  const args = profileArgs(request, ctx.approval)

  if ('error' in args) {
    return { deny: `rook: ${args.error}` }
  }

  if (args.argv[1] === undefined) {
    const listed = await rookJson($, ctx, args.argv)

    return { result: listed.exitCode === 0 ? profilesText(listed.stdout ?? '') : `rook profile failed: ${failureOf(listed) ?? `rook exited ${listed.exitCode}`}` }
  }

  if (args.argv[1] === 'use') {
    const ran = await rookJson($, ctx, args.argv)

    ctx.isDirty = true
    await poll($, ctx)

    return { result: ran.exitCode === 0 ? `rook: ${clip(ran.stdout?.trim() || 'done', 200)}` : `rook profile use failed: ${failureOf(ran) ?? `rook exited ${ran.exitCode}`}` }
  }

  const blocked = (await setupBlock($, ctx, NEEDS.profileTest, 'test a profile')) ?? (await prodBlock($, ctx, request.profile))

  if (blocked !== undefined) {
    return { deny: blocked.startsWith('rook') ? blocked : `rook: ${blocked}` }
  }

  try {
    const result = await rookRun($, ctx, args.argv, signal, await probeStateEnv($))

    return { result: profileTestText(request.profile, result.exitCode, result.stdout ?? '', result.stderr) }
  } finally {
    ctx.isDirty = true // a profile that answered is verified, and may have become the active one
    await poll($, ctx)
  }
}


// ── depth: rca on a finished run, agents, curation, the balance ─────────────

/** `rook plan --json`: credits left. Fetched at session start and after anything that spends, never per poll. */
async function refreshBalance($: EngineInterface, ctx: Ctx): Promise<number | null> {
  const plan = await rookJson($, ctx, ['plan', '--json'])
  const balance = failureOf(plan) === undefined ? (balanceOf(plan.doc) ?? null) : null

  if ((await read($, balanceAtom)) !== balance) {
    await update($, balanceAtom, () => balance)
  }

  return balance
}

/** The project's agent ids for the pane: rook's own directory names, re-listed with each poll's locate. */
async function syncAgents($: EngineInterface, ctx: Ctx, loc: Located): Promise<void> {
  const ids = await agentIdsOf(ioOf($, ctx), loc.projectDir)

  if (String(await read($, agentsAtom)) !== String(ids)) {
    await update($, agentsAtom, () => ids)
  }
}

/** The run a --rca would explain (the named one, or the latest), or why there is nothing to spend on. */
async function explainable($: EngineInterface, ctx: Ctx, runRef: string | undefined): Promise<{ runId: string } | { refusal: string }> {
  // Explaining reads the run's evidence and rook's controller: it needs a project and an agent, not a profile.
  const blocked = await setupBlock($, ctx, NEEDS.generate, 'explain a run')
  const loc = await where($, ctx)

  if (blocked !== undefined || loc === undefined) {
    return { refusal: `rook: ${blocked ?? "can't explain a run yet: no agent here."}` }
  }

  if (runRef !== undefined && !RUN_ID.test(runRef)) {
    return { refusal: `rook: "${clip(runRef, 40)}" is not a run id (2026-09-28T15-54-56Z form).` }
  }

  const io = ioOf($, ctx)
  const ids = await runIds(io, loc.agentDir)
  const runId = runRef ?? ids[0]
  const run = runId === undefined || !ids.includes(runId) ? undefined : await readRun(io, loc.agentDir, runId, ctx.rows)

  if (runId === undefined || run === undefined) {
    return { refusal: runRef ? `rook: no run ${runRef} for agent ${loc.agentId}.` : `rook: agent ${loc.agentId} has no runs yet.` }
  }

  if (!run.finished) {
    return { refusal: `rook: run ${runId} has not finished; it can be explained once its report is written.` }
  }

  if (run.counts.fail === 0 && run.clusters.length === 0) {
    return { refusal: `rook: run ${runId} has no failures or clusters to explain; nothing was spent.` }
  }

  if (run.clusters.length > 0 && run.clusters.every(isExplained)) {
    return { refusal: `rook: every cluster of run ${runId} is explained already; nothing was spent. The rook report tool (without rca) reads it.` }
  }

  return { runId }
}

/**
 * `rook report <run> --rca`, streamed like a run (the explainer reads code
 * and can take minutes), then the run re-read from disk: report.yaml's
 * clusters with their causes, and remedies/CL-xx.md. The caller has set
 * `explaining`; this clears it.
 */
async function explainRca($: EngineInterface, ctx: Ctx, runId: string, signal?: AbortSignal): Promise<{ text: string; context?: string }> {
  try {
    const args = reportRcaArgs(runId, ctx.approval)

    if ('error' in args) {
      return { text: `rook: ${args.error}` }
    }

    const result = await rookRun($, ctx, args.argv, signal)
    const problem = failureOf(result)

    if (problem !== undefined) {
      return { text: `rook report --rca did not complete: ${problem}` }
    }

    ctx.isDirty = true // the latest run's clusters changed under a settled snapshot
    await poll($, ctx)
    const head = rcaLine(runId, rcaOutcome(result.stdout ?? ''))
    const report = await reportText($, ctx, runId)

    return { text: `${head}\n${report.text}`, ...(report.context !== undefined && { context: `${head}\n${report.context}` }) }
  } finally {
    await update($, explainingAtom, () => null)
    await refreshBalance($, ctx)
  }
}

/** The model's --rca: inline, so the explained clusters come back as the report tool's result. */
async function toolExplain($: EngineInterface, ctx: Ctx, runRef: string | undefined, signal: AbortSignal): Promise<string> {
  if ((await read($, explainingAtom)) !== null) {
    return 'rook: rook is already explaining a run; wait for it, then read it with the rook report tool.'
  }

  const target = await explainable($, ctx, runRef)

  if ('refusal' in target) {
    return target.refusal
  }

  await update($, explainingAtom, () => target.runId)
  const { text, context } = await explainRca($, ctx, target.runId, signal)

  return context ?? text
}

/** An --rca the person asked for (pane, /rook): in the background; `isHandedOver` gives Claude the result as context. */
async function startExplain($: EngineInterface, ctx: Ctx, runRef: string | undefined, isHandedOver: boolean): Promise<string> {
  if ((await read($, explainingAtom)) !== null) {
    return 'rook: rook is already explaining a run.'
  }

  const target = await explainable($, ctx, runRef)

  if ('refusal' in target) {
    return target.refusal
  }

  await update($, explainingAtom, () => target.runId)
  $.clock.after(0, () => backgroundExplain($, ctx, target.runId, isHandedOver))

  return (
    `rook: explaining run ${target.runId} in the background. The agent is not called again; ` +
    'it is free if this agent version was explained already, otherwise it costs credits. The pane shows the causes and remedies when it lands.'
  )
}

async function backgroundExplain($: EngineInterface, ctx: Ctx, runId: string, isHandedOver: boolean): Promise<void> {
  const answer = await explainRca($, ctx, runId).catch(error => ({ text: `rook report --rca failed: ${String(error)}`, context: undefined }))

  $.ui.toast(clip(answer.text.split('\n')[0] ?? '', 200))

  if (isHandedOver && answer.context !== undefined) {
    const text = `<rook-run-result>\n${answer.context}\n</rook-run-result>`

    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  }
}

async function paneExplain($: EngineInterface, ctx: Ctx, runId: string): Promise<void> {
  $.ui.toast(await startExplain($, ctx, runId, false))
}

/** `rook agent` (prose: `* id  name`), or the agent directories on disk when rook cannot answer. */
async function agentList($: EngineInterface, ctx: Ctx): Promise<{ id: string; name: string; isActive: boolean }[]> {
  const listed = await rookJson($, ctx, ['agent'])
  const parsed = listed.exitCode === 0 ? parseAgentList(listed.stdout ?? '') : []
  const loc = parsed.length > 0 ? undefined : (ctx.located ?? (await where($, ctx)))

  return loc === undefined ? parsed : (await agentIdsOf(ioOf($, ctx), loc.projectDir)).map(id => ({ id, name: id, isActive: id === loc.agentId }))
}

async function agentsReply($: EngineInterface, ctx: Ctx): Promise<string> {
  return agentsText(await agentList($, ctx))
}

/** `rook agent use <id>`, then everything the mod knew about the old agent is let go and re-read. */
async function switchAgent($: EngineInterface, ctx: Ctx, id: string | undefined): Promise<string> {
  const args = agentUseArgs(id)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  if ((await read($, runningAtom)) !== null || (await read($, explainingAtom)) !== null) {
    return 'rook: rook is busy with the current agent; switch once it finishes.'
  }

  const known = await agentList($, ctx)
  const agent = known.find(a => a.id === id)

  if (known.length > 0 && agent === undefined) {
    return `rook: no agent ${id} in this project. Agents: ${known.map(a => a.id).join(', ')}.`
  }

  if (agent?.isActive) {
    return `rook: ${id} is already the active agent.`
  }

  const ran = await rookJson($, ctx, args.argv)

  if (ran.exitCode !== 0) {
    return `rook agent use failed: ${failureOf(ran) ?? 'no output'}`
  }

  ctx.agentIndex = undefined
  ctx.located = undefined
  ctx.isDirty = true

  if ((await read($, staleAtom)) !== null) {
    await update($, staleAtom, () => null) // the band named the old agent's scenarios
  }

  await update($, expandedAtom, () => null)
  await poll($, ctx)

  return `rook: ${id} is now the active agent. Runs, scenarios and reports follow it.`
}

async function paneSwitch($: EngineInterface, ctx: Ctx, id: string): Promise<void> {
  $.ui.toast(await switchAgent($, ctx, id))
}

/** `rook scenarios exclude|include <ids> --json`; the scenario set is re-read after. */
async function curateReply($: EngineInterface, ctx: Ctx, verb: string, ids: string[]): Promise<string> {
  const args = curateArgs(verb, ids)

  if ('error' in args) {
    return `rook: ${args.error}`
  }

  const ran = await rookJson($, ctx, args.argv)
  const problem = failureOf(ran)

  if (problem !== undefined) {
    return `rook scenarios ${verb} failed: ${problem}`
  }

  ctx.agentIndex = undefined
  ctx.isDirty = true
  await poll($, ctx)

  return curateText(ran.doc)
}

// ── shared: tabs and the confirm bar ─────────────────────────────────────────

async function setTab($: EngineInterface, tab: RookTab): Promise<void> {
  await update($, tabAtom, () => tab)
}

/** Park a credit-spending action in the pane until the person confirms it. */
async function askConfirm($: EngineInterface, confirm: RookConfirm): Promise<void> {
  await update($, confirmAtom, () => confirm)
}

/** The pane's Confirm: replay the parked action. */
async function confirmNow($: EngineInterface, ctx: Ctx): Promise<void> {
  const confirm = await read($, confirmAtom)

  await update($, confirmAtom, () => null)

  if (confirm?.action === 'run') {
    await paneRun($, ctx, confirm.only === undefined ? {} : { only: confirm.only })
  } else if (confirm?.action === 'generate') {
    const request: GenerateRequest = {
      ...(confirm.instruction !== undefined && { instruction: confirm.instruction }),
      ...(confirm.total !== undefined && { total: confirm.total }),
      ...(confirm.force === true && { force: true }),
    }

    $.ui.toast('rook: generating scenarios in the background.')
    $.clock.after(0, () => backgroundGenerate($, ctx, request))
  }
}

// ══ feature: progress (generate / explore lanes) ═════════════════════════════
// ══ end feature: progress ════════════════════════════════════════════════════

// ══ feature: health (Unable to Verify fixer, cancel, run confirm) ════════════
// ══ end feature: health ══════════════════════════════════════════════════════

// ══ feature: runs tab (history, compare) ═════════════════════════════════════

/** `/rook compare <run> <run>`. */
async function compareReply($: EngineInterface, ctx: Ctx, args: string[]): Promise<string> {
  void $
  void ctx
  void args

  return 'rook: compare is not built yet.'
}

// ══ end feature: runs tab ════════════════════════════════════════════════════

// ══ feature: scenarios tab (filter, select, detail, flaky, generate box) ═════

/** `/rook flaky <id> [times]`. */
async function flakyReply($: EngineInterface, ctx: Ctx, args: string[]): Promise<string> {
  void $
  void ctx
  void args

  return 'rook: flaky checks are not built yet.'
}

// ══ end feature: scenarios tab ═══════════════════════════════════════════════

// ══ feature: setup tab (profile wizard, sync, budget) ════════════════════════

/** Refuses a run or generate that the session's credit budget would not cover; undefined when allowed. */
async function budgetBlock($: EngineInterface, ctx: Ctx, kind: 'run' | 'generate'): Promise<string | undefined> {
  void $
  void ctx
  void kind

  return undefined
}

/** `/rook budget [N|off]`. */
async function budgetReply($: EngineInterface, ctx: Ctx, args: string[]): Promise<string> {
  void $
  void ctx
  void args

  return 'rook: budgets are not built yet.'
}

/** `/rook sync`: record this project upstream (rook sync). */
async function syncReply($: EngineInterface, ctx: Ctx): Promise<string> {
  void $
  void ctx

  return 'rook: sync is not built yet.'
}

// ══ end feature: setup tab ═══════════════════════════════════════════════════

// ══ feature: band (precise re-test) ══════════════════════════════════════════
// ══ end feature: band ════════════════════════════════════════════════════════

// ══ feature: status line ═════════════════════════════════════════════════════
// ══ end feature: status line ═════════════════════════════════════════════════

// ══ feature: card (transcript verdict card) ══════════════════════════════════
// ══ end feature: card ════════════════════════════════════════════════════════

// ══ feature: ci ══════════════════════════════════════════════════════════════

/** `/rook ci`: write a CI workflow that runs rook on pull requests. */
async function ciReply($: EngineInterface, ctx: Ctx, args: string[]): Promise<string> {
  const request = parseCiArgs(args)

  return 'error' in request ? `rook: ${request.error}` : ciAnswer($, ctx, request)
}

/** What the workflow needs from this workspace: the active profile's variable names, the installed build. Never a value. */
async function ciPlan($: EngineInterface, ctx: Ctx, request: CiRequest): Promise<CiPlan | undefined> {
  const loc = ctx.located ?? (await where($, ctx))

  if (loc === undefined) {
    return undefined
  }

  const target = await profileOf($, ctx)
  const profileText = target === undefined ? undefined : await ioOf($, ctx).read(`${loc.agentDir}/profiles/${target.profileId}.yaml`)
  // `rook --version` prints the build's commit; readiness keeps only a semver, so ask again.
  const version = await $.process
    .run([ctx.bin, '--version'], { env: CLI_ENV, stdin: '', timeoutMs: 10_000 })
    .then(ran => (ran.exitCode === 0 ? /\b[0-9a-f]{7,40}\b/.exec(ran.stdout)?.[0] : undefined))
    .catch(() => undefined)

  return {
    ...(target !== undefined && profileText !== undefined && { profileId: target.profileId }),
    variables: profileText === undefined ? [] : declaredVariables(profileText),
    ...(version !== undefined && { version }),
    allowRules: ctx.approval.allowRules,
    failOnUnverifiable: request.failOnUnverifiable,
  }
}

/** Preview, or write the workflow when asked and nothing is there (or `force`). Shared by /rook ci and the ci tool. */
async function ciAnswer($: EngineInterface, ctx: Ctx, request: CiRequest): Promise<string> {
  const plan = await ciPlan($, ctx, request)

  if (plan === undefined) {
    return 'rook: no rook workspace here. /rook ci writes a workflow for the agent set up in this directory (/rook explore sets one up).'
  }

  const yaml = workflowYaml(plan)
  const path = ctx.cwd === '' ? WORKFLOW_PATH : `${ctx.cwd.replace(/\/$/, '')}/${WORKFLOW_PATH}`
  const exists = await $.fs.exists(path).catch(() => false)

  if (!request.write) {
    return previewText(plan, yaml, exists)
  }

  if (exists && !request.force) {
    return `rook: ${WORKFLOW_PATH} exists already and was left as it is. /rook ci shows what would replace it; /rook ci write --force replaces it.`
  }

  try {
    await $.fs.write(path, yaml)
  } catch (error) {
    return `rook: could not write ${WORKFLOW_PATH}: ${clip(String(error), 200)}`
  }

  return writtenText(plan)
}

// ══ end feature: ci ══════════════════════════════════════════════════════════

const APPROVALS_NOTE =
  "rook's own tool calls during the command (reading the agent's code, running its commands) are approved with --yes, " +
  'unless the person set allowRules, in which case only those are approved and rook declines the rest.'

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    only: {
      type: 'array',
      items: { type: 'string', pattern: '^SC-\\d{3,6}$' },
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
    indexSignature: undefined,
    viewer: undefined,
    rows: new Map(),
    cli: {},
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

    if ((await read($, explainingAtom)) !== null) {
      await update($, explainingAtom, () => null)
    }

    await $.command.register({
      name: 'rook',
      description: 'rook agent testing: pane, status, runs, scenarios, agent, report, explain, run, generate, project, explore, profile, ui, confirm-prod',
      argumentHint: '[pane|status|runs|scenarios [exclude|include]|agent [use]|report|explain [--rca]|run|generate|project|explore|profile|ui|confirm-prod|help]',
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
        "failing criteria with rook's evidence, verification gaps, rook's next steps, credits. Defaults to the latest run. " +
        'With rca: true, rook first explains the run\'s clusters (cause, whose fault, a proposed diff) from the evidence it already has, ' +
        'without calling the agent again: free when this agent version was explained already, otherwise it costs credits and takes minutes. ' +
        APPROVALS_NOTE,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          run_id: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z(-\\d+)?$' },
          rca: { type: 'boolean', description: 'Have rook explain the clusters first (rook report --rca). Costs credits unless already explained at this agent version' },
        },
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
      name: 'runs',
      description:
        "The agent's runs on disk, newest first: run id, name, size, Pass / Fail / Unable to Verify, credits, and whether it was a local test run. No credits. Use it to find a run id for the rook report tool (and its rca option).",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many of the newest runs (default 20)' } },
      },
    })
    await $.tool.register({
      name: 'agent',
      description:
        "The rook project's agents, the active one marked (rook agent). With `use`, make another agent active (rook agent use): " +
        'runs, scenarios and reports then follow it. No credits.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { use: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$', description: 'The agent id to make active' } },
      },
    })
    await $.tool.register({
      name: 'curate',
      description:
        'Leave rook scenarios out of runs (exclude) or bring them back (include). Excluded scenarios stay on disk; nothing is deleted. ' +
        'No credits. The rook scenarios tool shows which are excluded.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'ids'],
        properties: {
          action: { type: 'string', enum: ['exclude', 'include'] },
          ids: { type: 'array', items: { type: 'string', pattern: '^SC-\\d{3,6}$' }, minItems: 1, maxItems: 200, description: 'Scenario ids, e.g. ["SC-004"]' },
        },
      },
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
    await $.tool.register({
      name: 'project',
      description:
        'List, select or create the rook (TestMu AI agent assurance) project this workspace records to. explore, generate and runs need one selected: ' +
        'use this when rook says no project is selected. action list (the default) shows ids and names with the active one marked; ' +
        'use selects one by id; create makes one and selects it — only when the person asked for a new project, with the name they gave. No credits.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'use', 'create'] },
          id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$', description: 'For use: the project id from the list' },
          name: { type: 'string', minLength: 1, maxLength: 120, description: 'For create: the project name' },
        },
      },
    })
    await $.tool.register({
      name: 'explore',
      description:
        "Set rook up for the agent in this repository (rook explore .): rook reads the codebase, finds the agents and writes each one's features under .testmuai/rook/. " +
        "Use it in a repository with no rook workspace, and again when the agent gained capabilities rook's features do not describe. " +
        'Needs a selected project (the rook project tool). Spends credits and takes minutes; it does not call the agent. ' +
        'Use `instruction` to say where the agent lives or what to focus on, `force` to re-derive every agent. ' +
        'Afterwards the rook generate tool writes scenarios, and the person adds a profile so rook can reach the agent. ' +
        APPROVALS_NOTE,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          force: { type: 'boolean', description: 'Re-derive every agent, whatever the hashes say' },
          instruction: { type: 'string', maxLength: 2000, description: "Where the agent lives or what to look for, e.g. 'the support bot under services/support'" },
        },
      },
    })
    await $.tool.register({
      name: 'profile_test',
      description:
        "rook profiles: how rook reaches the agent under test (local, staging…). action test (the default) calls the agent once through a profile — " +
        'the active one unless `profile` names another — and returns what came back; a profile that answers is marked verified. ' +
        'It invokes the real agent, so a production-looking profile is refused until the person confirms. ' +
        "action list shows the active agent's profiles; action use makes one active. " +
        'Do not try to ADD a profile: it needs connection details only the person has. Ask them to type ' +
        "`! rook profile add <name> --from connection.md` (a curl, a spec or notes) or `! rook profile add <name> --command '<how the agent starts>'`. " +
        APPROVALS_NOTE,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['test', 'list', 'use'] },
          profile: { type: 'string', pattern: '^[\\w.-]{1,64}$', description: 'Profile id. For test: default the active one. Required for use' },
          goal: { type: 'string', maxLength: 500, description: "For test: what to send the agent. Default: 'Say hello and nothing else.'" },
        },
      },
    })

    // ── tool registrations: runs tab
    // ── end tool registrations: runs tab

    // ── tool registrations: setup tab
    // ── end tool registrations: setup tab

    // ── tool registrations: ci
    await $.tool.register({
      name: 'ci',
      description:
        `Make rook a pull-request check: a GitHub Actions workflow (${WORKFLOW_PATH}) that installs rook, signs in from repository secrets, ` +
        "runs the agent's functional scenarios (or the ROOK_ONLY ids) with rook run --test --json, uploads the run folder, and fails on Fail verdicts " +
        '(Unable to Verify too when fail_on_unverifiable). Without write it previews: the path, the secret names the person must add, and the YAML. ' +
        'With write it writes the file, unless one exists (force replaces it). No credits, no agent call. Secret values never go in the file: ' +
        'tell the person which secrets to add; do not ask them for the values.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          write: { type: 'boolean', description: 'Write the workflow file; default false (preview only)' },
          force: { type: 'boolean', description: 'With write: replace an existing workflow file' },
          fail_on_unverifiable: { type: 'boolean', description: 'Fail the check on Unable to Verify as well as on Fail' },
        },
      },
    })
    // ── end tool registrations: ci

    await poll($, ctx)
    ctx.isPrimed = true
    $.clock.every(POLL_MS, () => poll($, ctx))
    // Installed and signed in are asked once, off the start path: `rook auth status` is a network call.
    $.clock.after(0, async () => {
      // After the install probe, so a missing rook costs one failed call, not two.
      await probeThenPoll($, ctx)
      if (ctx.cli.version !== null) {
        await refreshBalance($, ctx)
      }
    })

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

  on('tool.call', { tool: REPORT_TOOL }, async ($, e, next) => {
    const { run_id: runId, rca } = e as unknown as { run_id?: unknown; rca?: unknown }

    if (rca === true) {
      return { result: await toolExplain($, ctx, typeof runId === 'string' ? runId : undefined, next.signal) }
    }

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
    const balance = balanceText(await refreshBalance($, ctx))

    return { result: [await statusReply($, ctx), ...tail, ...(balance === undefined ? [] : [`Credit balance: ${balance}`])].join('\n') }
  })

  on('tool.call', { tool: SCENARIOS_TOOL }, async $ => ({ result: await scenariosReply($, ctx) }))

  on('tool.call', { tool: RUNS_TOOL }, async ($, e) => {
    const limit = (e as unknown as { limit?: unknown }).limit

    return { result: await runsReply($, ctx, typeof limit === 'number' && Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 20) }
  })

  on('tool.call', { tool: AGENT_TOOL }, async ($, e) => {
    const use = (e as unknown as { use?: unknown }).use

    return { result: use === undefined ? await agentsReply($, ctx) : await switchAgent($, ctx, typeof use === 'string' ? use : String(use)) }
  })

  on('tool.call', { tool: CURATE_TOOL }, async ($, e) => {
    const { action, ids } = e as unknown as { action?: unknown; ids?: unknown }

    return { result: await curateReply($, ctx, String(action), Array.isArray(ids) ? ids.map(String) : []) }
  })

  on('tool.call', { tool: GENERATE_TOOL }, async ($, e, next) => {
    const input = e as unknown as GenerateRequest
    const keys = ['total', 'classes', 'categories', 'instruction'] as const
    const request: GenerateRequest = {
      ...Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])),
      ...(input.force === true && { force: true }),
    }

    return { result: await generateRun($, ctx, request, next.signal) }
  })

  on('tool.call', { tool: PROJECT_TOOL }, async ($, e) => {
    const input = e as unknown as ProjectRequest
    const request: ProjectRequest = {
      ...(input.action !== undefined && { action: input.action }),
      ...(input.id !== undefined && { id: input.id }),
      ...(input.name !== undefined && { name: input.name }),
    }

    return { result: await projectReply($, ctx, request) }
  })

  on('tool.call', { tool: EXPLORE_TOOL }, async ($, e, next) => {
    const input = e as unknown as ExploreRequest
    const request: ExploreRequest = {
      ...(input.instruction !== undefined && { instruction: input.instruction }),
      ...(input.force === true && { force: true }),
    }

    return { result: await exploreRun($, ctx, request, next.signal) }
  })

  on('tool.call', { tool: PROFILE_TOOL }, async ($, e, next) => {
    const input = e as unknown as ProfileRequest
    const request: ProfileRequest = {
      ...(input.action !== undefined && { action: input.action }),
      ...(input.profile !== undefined && { profile: input.profile }),
      ...(input.goal !== undefined && { goal: input.goal }),
    }

    return profileReply($, ctx, request, next.signal)
  })

  // ── tool handlers: runs tab
  // ── end tool handlers: runs tab

  // ── tool handlers: setup tab
  // ── end tool handlers: setup tab

  // ── tool handlers: ci
  on('tool.call', { tool: CI_TOOL }, async ($, e) => {
    const { write, force, fail_on_unverifiable: strict } = e as unknown as { write?: unknown; force?: unknown; fail_on_unverifiable?: unknown }

    return { result: await ciAnswer($, ctx, { write: write === true, force: force === true, failOnUnverifiable: strict === true }) }
  })
  // ── end tool handlers: ci

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

    // "rook: …" and "rook status failed" alike would read "rook: rook …".
    return { ...answer, text: answer.text.replace(/^rook(?::\s*|\s+)/, '') }
  })

  // ── render hooks: card
  // ── end render hooks: card

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
    const resolved = $.ui.resolve(e)
    const { Box, Text, Button, Link, Markdown } = resolved
    const el = resolved as unknown as El
    const snapshot = await read($, snapshotAtom)
    const running = await read($, runningAtom)
    const expanded = await read($, expandedAtom)
    const viewerUrl = await read($, viewerAtom)
    const lastError = await read($, lastErrorAtom)
    const agents = await read($, agentsAtom)
    const balance = balanceText(await read($, balanceAtom))
    const explaining = await read($, explainingAtom)
    const tab = await read($, tabAtom)
    const confirm = await read($, confirmAtom)
    await read($, tickAtom)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)

    // ── pane seam: progress
    const job = await read($, jobAtom)
    const jobView = job === null ? null : <JobLanes el={el} job={job} now={now} />
    // ── end pane seam: progress

    const confirmView =
      confirm === null ? null : <ConfirmBar el={el} confirm={confirm} onConfirm={() => confirmNow($, ctx)} onCancel={() => update($, confirmAtom, () => null)} />
    const readiness = snapshot?.readiness
    const failedBefore = lastError !== null && (
      <Box key="last-error">
        <Text color="red" wrap="wrap">
          last {lastError.source} failed: {clip(lastError.text.replace(/^run failed: /, ''), 600)}
        </Text>
      </Box>
    )

    // No agent to show: the setup checklist, the next step highlighted.
    if (snapshot === null || snapshot.agentId === undefined) {
      return (
        <Box flexDirection="column">
          <SetupTab el={el} readiness={readiness} onRecheck={() => recheck($, ctx)} />
          {failedBefore}
          {jobView}
          {confirmView}
        </Box>
      )
    }

    const header = (
      <Text bold wrap="truncate-end">
        rook · {snapshot.agentId ?? ''}
        {snapshot.profileId ? <Text dimColor> · profile {snapshot.profileId}</Text> : ''}
        {balance !== undefined ? <Text dimColor> · {balance}</Text> : ''}
      </Text>
    )
    const frame = (body: unknown) => (
      <Box flexDirection="column">
        {header}
        <TabBar el={el} tab={tab} onTab={next => setTab($, next)} />
        {failedBefore}
        {jobView}
        {confirmView}
        {body as never}
      </Box>
    )

    // ── pane seam: runs tab
    if (tab === 'runs') {
      return frame(<RunsTab el={el} />)
    }
    // ── end pane seam: runs tab

    // ── pane seam: scenarios tab
    if (tab === 'scenarios') {
      return frame(<ScenariosTab el={el} />)
    }
    // ── end pane seam: scenarios tab

    // ── pane seam: setup tab
    if (tab === 'setup') {
      return frame(<SetupTab el={el} readiness={readiness} onRecheck={() => recheck($, ctx)} />)
    }
    // ── end pane seam: setup tab

    // The Health tab. ── pane seam: health (owned by the health feature, through the end of this hook)
    // Results can be read while rook would refuse to run (no project selected, signed out…): say so, offer no run.
    const runBlock = blockedText(readiness, NEEDS.run, 'run')

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
    // Runs need nothing in flight and a checklist that allows them; the agent switch below needs only the first.
    const canAct = running === null && runBlock === undefined
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
        {!isExplained(cluster) && (
          <Text dimColor wrap="wrap">
            Not explained yet. Explain with rca asks rook for the cause and a remedy from this run's evidence, without calling the agent again: free if
            this agent version was explained already, otherwise it costs credits.
          </Text>
        )}
        {!isExplained(cluster) && run !== undefined && explaining === null && (
          <Button key="explain-rca" label="Explain with rca" onPress={() => paneExplain($, ctx, run.runId)} />
        )}
        {!isExplained(cluster) && explaining !== null && <Text color="cyan">▸ rook is explaining {explaining}</Text>}
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

    return frame(
      <Box flexDirection="column">
        {agents.length > 1 && (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>agents</Text>
            {agents.map(id =>
              id === snapshot.agentId ? (
                <Text key={`a-${id}`} bold>
                  ● {id}
                </Text>
              ) : running === null && explaining === null ? (
                <Button key={`agent-${id}`} label={`use ${id}`} onPress={() => paneSwitch($, ctx, id)} />
              ) : (
                <Text key={`a-${id}`} dimColor>
                  {id}
                </Text>
              ),
            )}
          </Box>
        )}
        {runBlock !== undefined && (
          <Box key="run-block">
            <Text color="yellow" wrap="wrap">
              ⚠ {runBlock}
            </Text>
          </Box>
        )}
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
            {snapshot.neverRun > 0 ? `${snapshot.neverRun} scenarios, none run yet.` : 'No runs yet.'}
            {runBlock === undefined ? ' Press Run all, or ask Claude to test the agent.' : ''}
          </Text>
        )}
        {run === undefined && (snapshot.elsewhere?.length ?? 0) > 0 && (
          <Box key="elsewhere">
            <Text color="yellow" wrap="wrap">
              {`${snapshot.elsewhere!.map(other => `${other.runs} run${other.runs === 1 ? '' : 's'} in ${other.project}`).join(', ')} on disk: rook reads only the selected project. ` +
                'To see them, select that project with /rook project use <id>, or run here.'}
            </Text>
          </Box>
        )}
        {run !== undefined && (
          <Text dimColor wrap="truncate-end">
            latest: {run.name ? `${run.name} · ` : ''}
            {run.runId}
            {(snapshot.runCount ?? 0) > 1 ? ` · ${snapshot.runCount} runs (/rook runs)` : ''}
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
