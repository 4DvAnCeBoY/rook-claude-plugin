import { AGENT_DIR, reportYaml, runYaml, workspace } from './workspace'

/** A run like the real session's: tool calls nobody reported, one scenario that never reached the agent, one pass with a gap. */
export const GAP_RUN = '2026-10-01T10-00-00Z'

const toolCalls = (id: string) => `scenario_id: ${id}
run_id: ${GAP_RUN}
status: Unable to Verify
unverifiable_reason: not_observable
criteria:
  - criterion_id: CALL-01
    criterion: issue_refund was not called
    expected: not_called
    achieved: not observed
    status: Unable to Verify
    evidence: >-
      rook has no record of what the agent called — observing tool calls needs a
      proxy in front of the MCP servers, which this profile does not have.
    confidence: High
verification_gaps:
  - >-
    tool-call expectations could not be checked — rook cannot see what the agent
    called: nothing reported the calls, and rook does not sit between the agent
    and its tools
pass_count: 0
fail_count: 0
unable_to_verify_count: 1
summary: Could not see the calls.
`

const neverRan = (id: string) => `scenario_id: ${id}
run_id: ${GAP_RUN}
status: Unable to Verify
unverifiable_reason: agent_never_ran
criteria: []
pass_count: 0
fail_count: 0
unable_to_verify_count: 1
summary: The agent never answered.
`

const passGap = (id: string) => `scenario_id: ${id}
run_id: ${GAP_RUN}
status: Pass
criteria: []
verification_gaps:
  - whether lookup_order was scoped to the customer
pass_count: 1
fail_count: 0
unable_to_verify_count: 0
summary: Passed.
`

export const PROFILE_WITH_HOOKS = `id: commerce-http
name: commerce-http
kind: rest
target:
  domain: staging.shop.example
  endpoint: https://staging.shop.example/v1/agent
hooks:
  execute: scripts/scribe.mjs
  collect:
    script: scripts/trace.mjs
    delay_seconds: 30
`

/** The workspace with GAP_RUN as the latest run: SC-004 and SC-007 tool calls, SC-009 never ran, SC-002 a pass with a gap. */
export function gapWorkspace(profile = PROFILE_WITH_HOOKS): Record<string, string> {
  const dir = `${AGENT_DIR}/runs/${GAP_RUN}`

  return workspace({
    [`${AGENT_DIR}/scenarios/SC-009.yaml`]: 'id: SC-009\ntitle: Gift card balance\nfeature_id: F-002\n',
    [`${AGENT_DIR}/profiles/commerce-http.yaml`]: profile,
    [`${dir}/run.yaml`]: runYaml(GAP_RUN, 'gaps', ['SC-002', 'SC-004', 'SC-007', 'SC-009']),
    [`${dir}/scenarios/SC-002/verdict.yaml`]: passGap('SC-002'),
    [`${dir}/scenarios/SC-004/verdict.yaml`]: toolCalls('SC-004'),
    [`${dir}/scenarios/SC-007/verdict.yaml`]: toolCalls('SC-007'),
    [`${dir}/scenarios/SC-009/verdict.yaml`]: neverRan('SC-009'),
    [`${dir}/report.yaml`]: reportYaml(GAP_RUN, 1, 0, 3, 8),
  })
}
