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
  compromised: boolean
  summary: string
  failing: RookFailingCriterion[]
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
  passRate?: number
  credits?: number
  headline?: string
}

export type RookSnapshot = {
  agentId?: string
  latest?: RookRunView
  previous?: { runId: string; passed: number; failed: number }
  checkedAt: number
}

export type RookStale = {
  files: string[]
  scenarios: { id: string; title: string }[]
  /** True when no feature names the file: every scenario of the agent may be affected. */
  isWholeAgent: boolean
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
    }
  }
}
