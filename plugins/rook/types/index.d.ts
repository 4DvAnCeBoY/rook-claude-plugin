export type RookStatus = 'Pass' | 'Fail' | 'Unable to Verify'

export type RookCounts = { pass: number; fail: number; unverifiable: number }

export type RookFailingCriterion = {
  id: string
  criterion: string
  expected: string
  achieved: string
  evidence: string
}

export type RookScenarioRow = {
  id: string
  title: string
  status: RookStatus
  /** `agent_never_ran`, `not_observable` or `undecidable`, for Unable to Verify. */
  reason?: string
  /** What the judge could not look at, even on a Pass. */
  gaps: string[]
  /** What rook said about each criterion it could not check: the way to make it observable. */
  unchecked: string[]
  compromised: boolean
  summary: string
  failing: RookFailingCriterion[]
  /** verdict.yaml `compliance_percentage`: the share of criteria that passed. */
  compliance?: number
  /** verdict.yaml `forbidden_hits`: patterns the scenario forbids that appeared anyway. */
  forbiddenHits?: string[]
  /** Criterion ids that passed with Low confidence: a pass to check, not to trust. */
  weakPasses?: string[]
  latencyMs?: number
  turns?: number
  tokens?: { input: number; output: number }
}

/** Who acts on a scenario's verdict (hooks/owner.ts). */
export type RookOwner =
  /** The agent did the wrong thing: hooks ran, it replied, the judge failed it with confidence. */
  | 'agent'
  /** The scenario asks for something this environment cannot give, or has never passed. */
  | 'scenario'
  /** A profile hook failed or no reply was recorded: the agent was not really tested. */
  | 'harness'
  /** The judge could not check, or failed it only with Low confidence. */
  | 'judge'
  /** Pass, but a forbidden pattern appeared, a criterion passed weakly, or compliance is under 100. */
  | 'passbut'
  | 'pass'

/** Who is looking: the pane leads with release readiness for a QE, with the effect of their change for a developer. */
export type RookLens = 'qe' | 'dev'

/** verdict.yaml `confidence`: rook writes High, Medium or Low. */
export type RookConfidence = 'High' | 'Medium' | 'Low'

/** One acceptance criterion as judged, passes included. */
export type RookCriterion = {
  id: string
  criterion: string
  status: RookStatus
  expected: string
  achieved: string
  evidence: string
  confidence?: RookConfidence
}

/** One profile hook of a scenario, from hooks.json. `prepare` and `judge` appear only when rook records them. */
export type RookPhase = {
  name: string
  ran: boolean
  ok: boolean
  durationMs?: number
  error?: string
  /** Tool calls the hook observed (execute's `data.calls`). */
  calls?: { name: string; arguments?: unknown }[]
}

/** One turn of the conversation rook had with the agent (response.json `transcript`). */
export type RookTurn = {
  role: 'user' | 'agent' | string
  content: string
  /** The judge quoted this turn as evidence of a failing or unchecked criterion. */
  isCited?: boolean
}

/** Everything one scenario's run left on disk, for the drill-down. Read on demand, never per poll. */
export type RookEvidence = {
  id: string
  runId: string
  title: string
  status: RookStatus
  goal?: string
  /** snapshot.yaml `why`: the failure the scenario is meant to catch. */
  why?: string
  featureId?: string
  criteria: RookCriterion[]
  phases: RookPhase[]
  transcript: RookTurn[]
  /** The agent's final reply. */
  output?: string
  toolCalls: { name: string; arguments?: unknown }[]
  summary: string
  gaps: string[]
  compliance?: number
  forbiddenHits: string[]
  latencyMs?: number
  turns?: number
  tokens?: { input: number; output: number }
  /** Paths, relative to the workspace, a prompt can point Claude at. */
  paths: { verdict: string; response?: string; hooks?: string; request?: string }
}

/** A scenario's verdict in each of the newest runs that judged it, oldest first. */
export type RookVerdictHistory = { id: string; runs: { runId: string; status: RookStatus }[] }

/** What a scan of a repository with no `.testmuai/rook/` found that rook can start from. */
export type RookRepoFound = {
  path: string
  kind: 'agent' | 'requirements' | 'connection' | 'ci'
  /** A short description: `an agent: OpenAI Agents SDK`, `requirements: 9 headings`. */
  what: string
}

/**
 * A group of failures rook found one shape for (report.yaml `clusters`).
 * `cause` onwards are present once `--rca` explained it.
 */
export type RookCluster = {
  id: string
  why: string
  /** `failed`, `unverifiable` or `compromised`. */
  kind: string
  featureId?: string
  scenarios: { id: string; title: string }[]
  cause?: string
  remedy?: string
  /** `agent`, `scenario`, `harness` or `unclear`: whose fault the failure is. */
  fault?: string
  confidence?: string
  /** Files rook says to open. */
  where: string[]
}

/** A scenario in flight: its directory exists, its verdict does not yet. */
export type RookLane = {
  id: string
  title: string
  /** The last phase rook's hooks finished, or `starting` / `judging`. */
  phase: string
  /** When the scenario started, ms since epoch. */
  since: number
}

export type RookRunView = {
  runId: string
  name?: string
  created?: string
  planned: number
  done: number
  finished: boolean
  /** Unfinished on disk but over: cancelled, or nothing has written to it for a while (rook was stopped). Never reported as finished. */
  stopped?: boolean
  counts: RookCounts
  rows: RookScenarioRow[]
  lanes: RookLane[]
  clusters: RookCluster[]
  passRate?: number
  credits?: number
  durationMs?: number
  headline?: string
  narrative?: string
  next: string[]
}

/** One scenario's newest verdict across every run, and the one before it. */
export type RookCurrent = {
  id: string
  title: string
  status: RookStatus
  runId: string
  /** The verdict this scenario had in the run before `runId`, if any. */
  was?: RookStatus
}

export type RookStepId = 'installed' | 'signed_in' | 'project' | 'agent' | 'scenarios' | 'profile'

/** One step of the setup checklist; `hint` is the exact next action when it is not ticked. */
export type RookReadyStep = { id: RookStepId; label: string; ok: boolean; hint?: string }

export type RookReadiness = {
  steps: RookReadyStep[]
  /** The first unticked step's hint: what to do next. */
  next?: string
  /** `.testmuai/rook/` exists here: outside one the mod stays silent. */
  hasWorkspace: boolean
}

/** A background run or generate that failed: kept in the pane until the next one starts. */
export type RookLastError = { source: 'run' | 'generate'; text: string; at: number }

export type RookSnapshot = {
  /** Undefined when no agent can be read from disk: the pane shows the setup checklist. */
  agentId?: string
  profileId?: string
  latest?: RookRunView
  /** Every scenario's newest verdict, newest runs first: the agent's health, whatever the last run's scope. */
  current: RookCurrent[]
  /** Scenarios the agent has that no run has judged yet. */
  neverRun: number
  /** Runs of this agent on disk. */
  runCount?: number
  /** Runs kept under project folders other than the selected one: rook reads only the selected project. */
  elsewhere?: { project: string; runs: number }[]
  checkedAt: number
  readiness?: RookReadiness
  /** Outside a rook workspace: what the repository holds that rook could start from (feature: keys and setup). */
  repoFound?: RookRepoFound[]
}

export type RookStale = {
  files: string[]
  /** `why`: how the edit reaches it (a feature cites the file, an import, a tool name it shares). */
  scenarios: { id: string; title: string; why?: string }[]
  /** True when no feature names the file: every scenario of the agent may be affected. */
  isWholeAgent: boolean
  /** How the set was chosen when no feature cites the file (`shared code: matched 3 scenarios by tool names …`). */
  reason?: string
  /** What re-testing them would cost at the latest run's credits per scenario. */
  estimate?: number
  since: number
}

export type RookRunning = {
  startedAt: number
  label: string
  source: 'tool' | 'command' | 'pane'
}

export type RookProdConfirmation = { cwd: string; profile: string; until: number }

/** The pane's tabs. `health` is labelled Release for a QE and My change for a developer. */
export type RookTab = 'health' | 'runs' | 'scenarios' | 'setup' | 'trends'

/**
 * Something that spends credits, waiting for the person's yes in the pane.
 * Data only: the confirm button replays it.
 */
export type RookConfirm =
  | { action: 'run'; only?: string[]; label: string; credits?: number }
  | { action: 'generate'; instruction?: string; total?: number; force?: boolean; label: string; credits?: number }
  /** Re-run one scenario `times` times in a row (flaky check). */
  | { action: 'flaky'; id: string; times: number; label: string; credits?: number }
  | { action: 'profile-test'; profile?: string; label: string; credits?: number }
  /** `rook explore .` from the guided start (feature: keys): reads the code, writes the agent's features. */
  | { action: 'explore'; instruction?: string; label: string; credits?: number }

/** One step of a generate or explore in flight: a feature being planned, a scenario being written. */
export type RookJobLane = { id: string; label: string; phase: string; since: number; planned?: number; done?: number }

/** A generate or explore in flight, for the pane's lanes and the spinner. */
export type RookJob = { kind: 'generate' | 'explore'; label: string; startedAt: number; lanes: RookJobLane[]; last?: string; done?: number; planned?: number; source?: 'tool' | 'background' }

/** One finished run, for the Runs tab and the status line's trend. */
export type RookRunSummary = {
  runId: string
  name?: string
  created?: string
  planned: number
  counts: RookCounts
  passRate?: number
  credits?: number
  durationMs?: number
  isTest?: boolean
}

/** A per-session credit cap the mod enforces before run and generate. */
export type RookBudget = {
  limit: number
  spent: number
  /** The `rook plan` balance when the budget was set: spent is that minus the balance now. Absent when it could not be read. */
  startBalance?: number
}

declare module 'claude-code' {
  interface PluginState {
    rook: {
      snapshot: RookSnapshot | null
      stale: RookStale | null
      running: RookRunning | null
      /** The person's /rook confirm-prod: for which directory and profile, and until when (ms since epoch). */
      prodConfirmed: RookProdConfirmation | null
      /** The newest finished run this session has already reported on. */
      seenFinished: string | null
      isBandHidden: boolean
      /** The pane row opened to show its detail: a scenario id or a cluster id. */
      expanded: string | null
      /** The address `rook ui --local` serves on, once started. */
      viewerUrl: string | null
      /** Bumped while a run is in flight, so elapsed times redraw. */
      tick: number
      /** The last background failure, until the next run or generate starts. */
      lastError: RookLastError | null
      /** The project's agent ids, for the pane's switch. */
      agents: string[]
      /** `rook plan` credits available; null until fetched or when rook could not say. */
      balance: number | null
      /** The run `rook report --rca` is explaining now. */
      explaining: string | null
      /** The pane's open tab. */
      tab: RookTab
      /** A credit-spending action waiting for the person's yes. */
      confirm: RookConfirm | null

      // ── feature: progress (generate / explore lanes)
      job: RookJob | null
      // ── end feature: progress

      // ── feature: health (Unable to Verify fixer, cancel, run confirm)
      // ── end feature: health

      // ── feature: runs tab (history, compare)
      history: RookRunSummary[] | null
      compare: string[]
      /** The run the Runs tab opened, read from disk. */
      runOpen: RookRunView | null
      /** The two runs compareAtom holds, diffed scenario by scenario (hooks/history.ts `RunDiff`). */
      runDiff: {
        base: { runId: string; name?: string; counts: RookCounts; passRate?: number; credits?: number; durationMs?: number; finished: boolean }
        head: { runId: string; name?: string; counts: RookCounts; passRate?: number; credits?: number; durationMs?: number; finished: boolean }
        /** Fail or Unable to Verify in base, Pass in head. */
        fixed: { id: string; title: string; base?: RookStatus; head?: RookStatus }[]
        /** Pass in base, Fail or Unable to Verify in head. */
        regressed: { id: string; title: string; base?: RookStatus; head?: RookStatus }[]
        /** Judged in head only. */
        added: { id: string; title: string; base?: RookStatus; head?: RookStatus }[]
        /** Judged in base only. */
        missing: { id: string; title: string; base?: RookStatus; head?: RookStatus }[]
        /** Not Pass in base, Fail in head. */
        stillFailing: { id: string; title: string; base?: RookStatus; head?: RookStatus }[]
        /** Not Pass in base, Unable to Verify in head: not a Fail. */
        stillUnverified?: { id: string; title: string; base?: RookStatus; head?: RookStatus }[]
        /** Pass in both. */
        stillPassing: number
        delta: { pass: number; fail: number; unverifiable: number; passRate?: number; credits?: number }
      } | null
      // ── end feature: runs tab

      // ── feature: scenarios tab (filter, select, detail, flaky, generate box)
      selected: string[]
      filter: string
      draft: string
      flaky: Record<string, RookStatus[]>
      /** The scenario's newest verdict from before its flaky check, which counts toward the judgement. */
      flakyPrior: Record<string, RookStatus>
      /** The scenario opened in the Scenarios tab. */
      scenarioDetail: string | null
      // ── end feature: scenarios tab

      // ── feature: setup tab (profile wizard, sync, budget)
      budget: RookBudget | null
      /** `rook status --json` read back for the Setup tab, and the last `rook sync`; null until checked. */
      sync: {
        checkedAt: number
        offline: boolean
        agents: { id: string; tree: string; version?: number; upstream?: number; changes: string[]; owedRuns: number }[]
        said?: string
        error?: string
        isSyncing?: boolean
      } | null
      // ── end feature: setup tab

      // ── feature: band (precise re-test)
      /** Scenario ids the person unticked in the re-test band: left out of Re-test. */
      unticked: string[]
      /** The band's Details list is open. */
      isBandOpen: boolean
      // ── end feature: band

      // ── feature: status line
      // ── end feature: status line

      // ── feature: card (transcript verdict card)
      // ── end feature: card

      // ── feature: ci
      // ── end feature: ci

      // ── shared: lens and drill-down
      /** Who is looking; persisted in $.store, toggled with `l` in the pane. */
      lens: RookLens
      /** The scenario the drill-down shows: its run and id. Opened from any list in any tab. */
      detail: { runId: string; id: string } | null
      /** The drill-down's evidence, read when `detail` changes. */
      evidence: RookEvidence | null
      /** Each scenario's newest verdicts across runs (hooks/history.ts `verdictHistory`), re-read when runs change. */
      verdicts: RookVerdictHistory[]
      // ── end shared: lens and drill-down

      // ── feature: drill-down (scenario evidence, owner actions, prompts)
      // ── end feature: drill-down

      // ── feature: home (Release for QE, My change for dev)
      // ── end feature: home

      // ── feature: trends (heat grid, runs per scenario)
      // ── end feature: trends

      // ── feature: live (run band, streamed results, stale verdicts, status line states)
      // ── end feature: live

      // ── feature: keys (focus, hotkeys, fresh repo, setup toggles)
      // ── end feature: keys
    }
  }
}
