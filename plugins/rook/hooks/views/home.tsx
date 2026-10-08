import type { RookCluster, RookScenarioRow, RookStatus } from '../../types'
import { clip, excerpt, gapText, isExplained, reasonText } from '../format'
import { notesOf, plural } from '../health'
import type { GapCause, GapGroup } from '../health'
import { brokeLine, checkGroups, costLine, grewLine, releaseLine, STATUS_COLOR, STATUS_ICON } from '../home'
import type { ChangedFile, Cost, Owned, Release } from '../home'
import { OWNER_COLOR, OWNER_LABEL } from '../owner'
import type { El } from './kit'

/**
 * The pane's first tab: Release for a QE, My change for a developer. Pure:
 * every action arrives as a callback built in register.tsx. Owned by the
 * home feature.
 */

/** What both lenses show around their own body: the run, rook's word on it, the run buttons. */
export type HomeCommon = {
  el: El
  width: number
  /** `hardened adversarial matrix · 2026-09-28T15-48-44Z · 3/3 done` */
  runLine?: string
  /** Nothing in flight and the checklist allows a run. */
  canAct: boolean
  /** Scenarios whose newest verdict is a Fail: Re-run failed. */
  failing: number
  viewerUrl: string | null
  onOpen: (runId: string, id: string) => void
  onRunAll: () => void
  onRerunFailed: () => void
  onViewer: () => void
}

export type ReleaseProps = HomeCommon & {
  release: Release
  /** Every scenario's newest verdict counted, and the scenarios no run has judged. */
  counts: { pass: number; fail: number; unverifiable: number }
  neverRun: number
  /** `pass rate 50% · 12.5 credits · 1m04s` */
  metrics?: string
  moved: { fixed: string[]; regressed: string[] }
  headline?: string
  next: string[]
  clusters: RookCluster[]
  /** The latest run's rows, for a cluster's evidence. */
  runRows: RookScenarioRow[]
  expanded: string | null
  explaining: string | null
  gapGroups: GapGroup[]
  onToggle: (id: string) => void
  onExplain: () => void
  onFixOne: (id: string) => void
  onFixGaps: (cause: GapCause) => void
  onRetestGaps: (cause: GapCause, ids: string[]) => void
  onDraft: () => void
  onGenerate: () => void
}

export type ChangeProps = HomeCommon & {
  lastGreen?: string
  /** False when no run was fully green and `lastGreen` is the run before the first regression. */
  isGreen?: boolean
  regressions: Owned[]
  /** Agent bugs that were failing before this change too: still the developer's to fix, but not news. */
  stillFailing: Owned[]
  changed: ChangedFile[]
  cost: Cost
  /** The run the cost compares against. */
  previousRunId?: string
  notYours?: string
  /** Scenarios the changed files reach or the band calls stale: Re-test. */
  affected: string[]
  onFix: () => void
  onRetest: () => void
}

function History(props: { el: El; history: readonly RookStatus[] }) {
  const { Text } = props.el

  return (
    <Text>
      {props.history.map((status, at) => (
        <Text key={`h-${at}`} color={STATUS_COLOR[status]}>
          {STATUS_ICON[status]}
        </Text>
      ))}
    </Text>
  )
}

/** One scenario: opens the drill-down; chips and its recent verdicts beside it. */
function ScenarioRow(props: { el: El; prefix: string; o: Owned; width: number; withOwner?: boolean; note?: string; onOpen: (runId: string, id: string) => void }) {
  const { Box, Text, Button } = props.el
  const { o } = props

  return (
    <Box key={`${props.prefix}-${o.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button
          key={`${props.prefix}-${o.id}`}
          plain
          label={`${STATUS_ICON[o.status]} ${o.id} ${clip(o.title, Math.max(12, props.width - 34))}`}
          onPress={() => props.onOpen(o.runId, o.id)}
        />
        {o.isAdversarial && <Text color="magenta">[adversarial]</Text>}
        {props.withOwner === true && <Text color={OWNER_COLOR[o.owner]}>[{OWNER_LABEL[o.owner]}]</Text>}
        <History el={props.el} history={o.history} />
      </Box>
      {props.note !== undefined && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="truncate-end">
            {props.note}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function RunButtons(props: HomeCommon & { children?: unknown }) {
  const { Box, Button, Link } = props.el

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {props.children as never}
        {props.canAct && <Button key="run-all" label="Run all" hotkey="r" onPress={props.onRunAll} />}
        {props.canAct && props.failing > 0 && <Button key="rerun-failed" label="Re-run failed" hotkey="f" onPress={props.onRerunFailed} />}
        {props.viewerUrl === null && <Button key="viewer" label="Evidence viewer" hotkey="v" onPress={props.onViewer} />}
      </Box>
      {props.viewerUrl !== null && (
        <Box key="viewer-link">
          {/* rook's viewer answers localhost as well as 127.0.0.1; a Link takes only the name. */}
          <Link href={props.viewerUrl.replace('//127.0.0.1:', '//localhost:')} label={`evidence viewer ${props.viewerUrl.replace('//127.0.0.1:', '//localhost:')}`} />
        </Box>
      )}
    </Box>
  )
}

/** A failed row's criteria, inside an opened cluster. */
function RowDetail(props: { el: El; row: RookScenarioRow }) {
  const { Box, Text } = props.el
  const { row } = props

  return (
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
    </Box>
  )
}

/** rook's root-cause clusters: each opens to cause, fault, remedy and its scenarios' evidence. */
function Clusters(props: ReleaseProps) {
  const { Box, Text, Button, Markdown } = props.el
  const { clusters, expanded, explaining, width } = props

  const detail = (cluster: RookCluster) => (
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
          Not explained yet. Explain with rca asks rook for the cause and a remedy from this run's evidence, without calling the agent again: free if this
          agent version was explained already, otherwise it costs credits.
        </Text>
      )}
      {!isExplained(cluster) && explaining === null && <Button key="explain-rca" label="Explain with rca" onPress={props.onExplain} />}
      {!isExplained(cluster) && explaining !== null && <Text color="cyan">▸ rook is explaining {explaining}</Text>}
      {cluster.scenarios.slice(0, 8).flatMap(s => {
        const row = props.runRows.find(r => r.id === s.id)

        return [
          <Text key={`d-${cluster.id}-${s.id}`} wrap="truncate-end">
            <Text color="red">✗ {s.id}</Text> {s.title}
          </Text>,
          ...(row !== undefined && row.status === 'Fail' ? [<RowDetail key={`rd-${cluster.id}-${s.id}`} el={props.el} row={row} />] : []),
        ]
      })}
      <Button key={`fix-${cluster.id}`} label="Fix this with Claude" onPress={() => props.onFixOne(cluster.id)} />
    </Box>
  )

  if (clusters.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>root causes (rook)</Text>
      {clusters.slice(0, 8).flatMap(cluster => [
        <Button
          key={`c-${cluster.id}`}
          plain
          label={`${expanded === cluster.id ? '▾' : '▸'} ${cluster.id} ${cluster.kind === 'compromised' ? '[compromised] ' : ''}${clip(cluster.why, width - 24)} (${cluster.scenarios.length})${isExplained(cluster) ? ' · remedy' : ''}`}
          onPress={() => props.onToggle(cluster.id)}
        />,
        ...(expanded === cluster.id ? [detail(cluster)] : []),
      ])}
    </Box>
  )
}

/** "What nobody looked at": gaps grouped by cause, each with its remedy, Fix with Claude and Re-test. */
function Gaps(props: ReleaseProps) {
  const { Box, Text, Button } = props.el
  const { gapGroups, width } = props

  if (gapGroups.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      <Text bold>What nobody looked at</Text>
      {gapGroups.map(group => (
        <Box key={`uv-${group.cause}`} flexDirection="column">
          <Text color="yellow" wrap="truncate-end">
            ? {group.title} ({group.rows.length})
          </Text>
          {group.rows.slice(0, 6).map(row => (
            <Box key={`g-${row.id}`} paddingLeft={2}>
              <Text dimColor wrap="truncate-end">
                {row.id}
                {row.reason ? ` (${reasonText(row.reason)})` : ''} {notesOf(row).length > 0 ? clip(notesOf(row).join('; '), width) : gapText(row, width)}
              </Text>
            </Box>
          ))}
          <Box key={`uv-remedy-${group.cause}`} paddingLeft={2}>
            <Text wrap="wrap">→ {group.remedy}</Text>
          </Box>
          <Box flexDirection="row" gap={1} paddingLeft={2}>
            <Button key={`uv-fix-${group.cause}`} label="Fix with Claude" onPress={() => props.onFixGaps(group.cause)} />
            {props.canAct && (
              <Button
                key={`uv-retest-${group.cause}`}
                label={`Re-test ${group.rows.length === 1 ? 'this 1' : `these ${group.rows.length}`}`}
                onPress={() =>
                  props.onRetestGaps(
                    group.cause,
                    group.rows.map(row => row.id),
                  )
                }
              />
            )}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** QE: can this ship? Blockers, verdicts to check, suite health. */
export function ReleaseView(props: ReleaseProps) {
  const { Box, Text, Button } = props.el
  const { release, width } = props
  const gaps = release.coverage.gaps

  return (
    <Box flexDirection="column">
      {/* The release call at a glance, boxed in its colour: ready or not, the counts, the rates. */}
      <Box key="home-verdict-box" flexDirection="column" borderStyle="round" borderColor={!release.hasVerdicts ? 'gray' : release.isReady ? 'green' : 'red'} paddingX={1}>
        {release.hasVerdicts && (
          <Box key="home-verdict">
            <Text bold color={release.isReady ? 'green' : 'red'} wrap="truncate-end">
              {release.isReady ? '✓ Ready to ship' : `✗ Not ready: ${plural(release.blockers.length, 'blocker')}`}
            </Text>
          </Box>
        )}
        {(release.hasVerdicts || props.neverRun > 0) && (
          <Box key="home-counts" flexDirection="row" gap={2} flexWrap="wrap">
            <Text color="green">✓ {props.counts.pass} Pass</Text>
            <Text color="red">✗ {props.counts.fail} Fail</Text>
            <Text color="yellow">? {props.counts.unverifiable} Unable to Verify</Text>
            {props.neverRun > 0 && <Text dimColor>{props.neverRun} never run</Text>}
          </Box>
        )}
        {release.hasVerdicts && (
          <Box key="home-rates">
            <Text wrap="truncate-end">{releaseLine(release)}</Text>
          </Box>
        )}
      </Box>
      {props.runLine !== undefined && (
        <Text dimColor wrap="truncate-end">
          latest: {props.runLine}
        </Text>
      )}
      {props.metrics !== undefined && props.metrics !== '' && <Text dimColor>{props.metrics}</Text>}
      {(props.moved.fixed.length > 0 || props.moved.regressed.length > 0) && (
        <Text wrap="truncate-end">
          {props.moved.fixed.length > 0 && <Text color="green">↑ fixed {props.moved.fixed.join(', ')} </Text>}
          {props.moved.regressed.length > 0 && <Text color="red">↓ regressed {props.moved.regressed.join(', ')}</Text>}
        </Text>
      )}
      {props.headline !== undefined && <Text wrap="wrap">{props.headline}</Text>}

      {(release.blockers.length > 0 || props.clusters.length > 0) && <Text bold>Blockers</Text>}
      {release.blockers.slice(0, 12).map(o => (
        <ScenarioRow key={`hb-${o.id}`} el={props.el} prefix="hb" o={o} width={width} onOpen={props.onOpen} />
      ))}
      <Clusters {...props} />

      {release.toCheck.length > 0 && <Text bold>Verdicts to check</Text>}
      {checkGroups(release.toCheck).map(group => (
        <Box key={`hg-${group.key}`} flexDirection="column">
          <Text color={group.key === 'passbut' ? 'yellow' : group.key === 'harness' ? 'yellow' : 'blue'} wrap="truncate-end">
            {group.title} ({group.items.length})
          </Text>
          {group.remedy !== undefined && (
            <Box paddingLeft={2}>
              <Text dimColor wrap="wrap">
                → {clip(group.remedy, 300)}
              </Text>
            </Box>
          )}
          {group.items.slice(0, 8).map(o => (
            <ScenarioRow key={`hc-${o.id}`} el={props.el} prefix="hc" o={o} width={width} {...(group.key === 'passbut' && { note: o.why })} onOpen={props.onOpen} />
          ))}
          {group.items.length > 8 && <Text dimColor>  +{group.items.length - 8} more in the Scenarios tab</Text>}
        </Box>
      ))}
      <Gaps {...props} />

      {(release.suiteProblems.length > 0 || release.flaky.length > 0 || gaps.length > 0) && <Text bold>Suite health</Text>}
      {release.suiteProblems.slice(0, 8).map(o => (
        <ScenarioRow key={`hs-${o.id}`} el={props.el} prefix="hs" o={o} width={width} withOwner note={o.why} onOpen={props.onOpen} />
      ))}
      {release.flaky.slice(0, 8).map(o => (
        <ScenarioRow key={`hf-${o.id}`} el={props.el} prefix="hf" o={o} width={width} note="flaky: its verdict keeps changing" onOpen={props.onOpen} />
      ))}
      {gaps.length > 0 && (
        <Box key="home-gaps">
          <Text color="yellow" wrap="wrap">
            no scenarios: {gaps.map(f => (f.name ? `${f.id} ${f.name}` : f.id)).join(' · ')}
          </Text>
        </Box>
      )}
      {props.next.length > 0 && <Text bold>Next</Text>}
      {props.next.slice(0, 3).map((step, at) => (
        <Text key={`n-${at}`} dimColor wrap="wrap">
          · {clip(step, 240)}
        </Text>
      ))}

      <RunButtons {...props}>
        {release.blockers.length > 0 && <Button key="home-draft" label="Draft bug reports" variant="primary" hotkey="d" onPress={props.onDraft} />}
        {gaps.length > 0 && <Button key="home-generate" label={`Generate for ${plural(gaps.length, 'gap')}`} hotkey="i" onPress={props.onGenerate} />}
      </RunButtons>
    </Box>
  )
}

/** Developer: did my change break anything? Regressions since the last green run, what the edits reach, what they cost. */
export function ChangeView(props: ChangeProps) {
  const { Box, Text, Button } = props.el
  const { regressions, changed, cost, width } = props
  const costText = costLine(cost)

  return (
    <Box flexDirection="column">
      <Box key="home-verdict-box" flexDirection="column" borderStyle="round" borderColor={regressions.length > 0 ? 'red' : 'green'} paddingX={1}>
        <Box key="home-verdict">
          <Text bold color={regressions.length > 0 ? 'red' : 'green'} wrap="truncate-end">
            {regressions.length > 0 ? `✗ ${plural(regressions.length, 'regression')} since ${props.isGreen === false ? 'the baseline' : 'your last green'}` : '✓ No regressions from your change'}
          </Text>
        </Box>
        <Text dimColor wrap="wrap">
          {props.lastGreen === undefined ? 'no green run yet' : props.isGreen === false ? `baseline: ${props.lastGreen} (no fully green run yet; the run before the first regression)` : `last green: ${props.lastGreen}`}
          {props.runLine !== undefined ? ` · latest: ${props.runLine}` : ''}
        </Text>
      </Box>

      <Text bold>
        Your change <Text dimColor>· {props.lastGreen !== undefined ? 'since the last green run' : 'this session'}</Text>
      </Text>
      {changed.length === 0 && (
        <Box key="home-unchanged">
          <Text dimColor>
            {props.lastGreen !== undefined ? 'No tracked file edited since the last green run.' : 'No tracked file edited this session.'}
          </Text>
        </Box>
      )}
      {changed.slice(0, 10).map(file => (
        <Box key={`hfile-${file.path}`} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="cyan">✎ {file.path}</Text>
            {file.reason !== undefined && <Text dimColor> · {clip(file.reason, Math.max(20, width - file.path.length - 8))}</Text>}
          </Text>
          <Box flexDirection="row" gap={1} paddingLeft={2} flexWrap="wrap">
            {file.scenarios.length === 0 && <Text dimColor>reaches no scenario</Text>}
            {file.scenarios.slice(0, 12).map(s => (
              <Box key={`hfs-${file.path}-${s.id}`}>
                <Text color={s.status === undefined ? undefined : STATUS_COLOR[s.status]} dimColor={s.status === undefined}>
                  {s.status === undefined ? '·' : STATUS_ICON[s.status]} {s.id}
                  {s.isStale ? ' ⧗' : ''}
                </Text>
              </Box>
            ))}
            {file.scenarios.length > 12 && <Text dimColor>+{file.scenarios.length - 12} more</Text>}
          </Box>
        </Box>
      ))}
      {changed.some(f => f.scenarios.some(s => s.isStale)) && <Text dimColor>⧗ verdict older than the edit</Text>}

      {regressions.length > 0 && <Text bold>Broken by this change</Text>}
      {regressions.slice(0, 12).map(o => (
        <ScenarioRow key={`hr-${o.id}`} el={props.el} prefix="hr" o={o} width={width} note={brokeLine(o.row)} onOpen={props.onOpen} />
      ))}

      {props.stillFailing.length > 0 && (
        <Text bold>
          Still failing <Text dimColor>· agent bugs from before this change ({props.stillFailing.length})</Text>
        </Text>
      )}
      {props.stillFailing.slice(0, 6).map(o => (
        <ScenarioRow key={`hsf-${o.id}`} el={props.el} prefix="hsf" o={o} width={width} note={brokeLine(o.row)} onOpen={props.onOpen} />
      ))}
      {props.stillFailing.length > 6 && <Text dimColor>  +{props.stillFailing.length - 6} more: switch to the Release view (l) for all of them</Text>}

      {(costText !== '' || cost.grew.length > 0) && <Text bold>Cost of this change</Text>}
      {costText !== '' && (
        <Box key="home-cost">
          <Text wrap="truncate-end">
            {costText}
            {props.previousRunId !== undefined ? <Text dimColor> vs {props.previousRunId}</Text> : ''}
          </Text>
        </Box>
      )}
      {cost.grew.map(g => (
        <Box key={`hg-${g.id}`}>
          <Text color="yellow" wrap="truncate-end">
            ↑ {grewLine(g)}
          </Text>
        </Box>
      ))}

      {props.notYours !== undefined && (
        <Box key="home-not-yours">
          <Text dimColor wrap="truncate-end">
            Not caused by your code: {props.notYours}
          </Text>
        </Box>
      )}

      <RunButtons {...props}>
        {regressions.length > 0 && <Button key="home-fix" label={`Fix ${regressions.length} with Claude`} variant="primary" hotkey="x" onPress={props.onFix} />}
        {props.canAct && props.affected.length > 0 && (
          <Button key="home-retest" label={`Re-test ${plural(props.affected.length, 'affected scenario')}`} hotkey="a" onPress={props.onRetest} />
        )}
      </RunButtons>
    </Box>
  )
}
