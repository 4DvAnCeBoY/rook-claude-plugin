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
  checkedAt: number
  readiness?: RookReadiness
}

export type RookStale = {
  files: string[]
  scenarios: { id: string; title: string }[]
  /** True when no feature names the file: every scenario of the agent may be affected. */
  isWholeAgent: boolean
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
    }
  }
}
