import type { RookRunSummary, RookRunView, RookStatus } from '../../types'
import { credits, duration } from '../format'
import { deltaLine, pct } from '../history'
import type { RunDiff, RunDiffRow } from '../history'
import type { El } from './kit'

export type RunsTabProps = {
  el: El
  history: RookRunSummary[] | null
  /** The run opened to its detail. */
  open: RookRunView | null
  /** Up to two run ids picked for comparing. */
  compare: string[]
  diff: RunDiff | null
  /** A run rca is explaining now. */
  explaining: string | null
  onOpen: (runId: string) => void
  onBack: () => void
  onReport: () => void
  onExplain: () => void
  onCompareWith: () => void
  onPick: (runId: string) => void
  onClearCompare: () => void
  /** The opened run against the finished run before it: who regressed, who was fixed. */
  versus?: { previous: string; regressed: string[]; fixed: string[] } | null
  /** Open one scenario of the opened run in the drill-down. */
  onScenario?: (id: string) => void
}

const ICON: Record<RookStatus, { glyph: string; color: string }> = {
  Pass: { glyph: '✓', color: 'green' },
  Fail: { glyph: '✗', color: 'red' },
  'Unable to Verify': { glyph: '?', color: 'yellow' },
}

/** A scenario row of a run's detail: `✗ SC-004 Manager-approval override…`. */
export const scenarioLine = (row: { id: string; title: string; status: RookStatus }): string => `${ICON[row.status].glyph} ${row.id}${row.title ? ` ${row.title}` : ''}`

/** `vs each scenario's verdict before: regressed SC-002 · fixed SC-004`, or that nothing moved. */
export const versusLine = (versus: { regressed: readonly string[]; fixed: readonly string[] }): string =>
  versus.regressed.length === 0 && versus.fixed.length === 0
    ? "vs each scenario's verdict before: none regressed or was fixed"
    : `vs each scenario's verdict before: ${[
        versus.regressed.length > 0 ? `regressed ${versus.regressed.join(', ')}` : undefined,
        versus.fixed.length > 0 ? `fixed ${versus.fixed.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')}`

/** `2026-09-28 15:49` from rook's ISO `created`; the run id's own date when there is none. */
const when = (run: RookRunSummary): string => {
  const at = run.created ?? run.runId.replace(/T(\d{2})-(\d{2})-(\d{2})Z.*/, 'T$1:$2:$3Z')

  return at.replace('T', ' ').slice(0, 16)
}

/** One line of the list: the run, when, ✓/✗/?, pass rate, credits, duration, test. */
export const runLine = (run: RookRunSummary): string =>
  [
    run.name ? `${run.name} (${run.runId})` : run.runId,
    when(run),
    `✓${run.counts.pass} ✗${run.counts.fail} ?${run.counts.unverifiable}`,
    run.passRate === undefined ? undefined : pct(run.passRate),
    credits(run.credits),
    run.durationMs === undefined ? undefined : duration(run.durationMs),
    run.isTest ? 'test' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

/** The Runs tab: run history, a run's detail, and two runs compared. Owned by the runs-tab feature. */
export function RunsTab(props: RunsTabProps) {
  const { Box, Text, Button } = props.el
  const { history, open, compare, diff } = props

  if (diff !== null && compare.length === 2) {
    return <CompareView {...props} diff={diff} />
  }

  const picking = compare.length === 1 ? compare[0] : undefined

  if (open !== null && picking === undefined) {
    return <RunDetail {...props} run={open} />
  }

  if (history === null) {
    return <Text dimColor>Reading the runs on disk…</Text>
  }

  if (history.length === 0) {
    return <Text dimColor>No finished runs yet.</Text>
  }

  return (
    <Box flexDirection="column">
      {picking === undefined ? (
        <Text dimColor wrap="truncate-end">
          {history.length} finished run{history.length === 1 ? '' : 's'}, newest first. Open one for its detail.
        </Text>
      ) : (
        <Box key="picking" flexDirection="row" gap={1}>
          <Text color="cyan" wrap="truncate-end">
            Compare {picking} with…
          </Text>
          <Button key="pick-cancel" plain label="Cancel" role="dismiss" onPress={props.onClearCompare} />
        </Box>
      )}
      {history.map(run =>
        run.runId === picking ? (
          <Text key={`run-${run.runId}`} bold wrap="truncate-end">
            ▸ {runLine(run)}
          </Text>
        ) : (
          <Button
            key={`run-${run.runId}`}
            plain
            label={runLine(run)}
            onPress={() => (picking === undefined ? props.onOpen(run.runId) : props.onPick(run.runId))}
          />
        ),
      )}
    </Box>
  )
}

function RunDetail(props: RunsTabProps & { run: RookRunView }) {
  const { Box, Text, Button } = props.el
  const { run } = props
  const metrics = [
    run.passRate === undefined ? undefined : `pass rate ${pct(run.passRate)}`,
    credits(run.credits),
    run.durationMs === undefined ? undefined : duration(run.durationMs),
  ]
    .filter(Boolean)
    .join(' · ')
  const canExplain = run.finished && (run.counts.fail > 0 || run.clusters.length > 0) && !(run.clusters.length > 0 && run.clusters.every(cluster => cluster.remedy !== undefined))

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">
        {run.name ? `${run.name} · ` : ''}
        {run.runId}
        {run.finished ? '' : ' · unfinished'}
      </Text>
      {run.headline !== undefined && <Text wrap="wrap">{run.headline}</Text>}
      <Text key="run-counts">
        <Text color="green">✓ {run.counts.pass} Pass</Text> · <Text color="red">✗ {run.counts.fail} Fail</Text> ·{' '}
        <Text color="yellow">? {run.counts.unverifiable} Unable to Verify</Text>
      </Text>
      {metrics !== '' && <Text dimColor>{metrics}</Text>}
      <Text key="run-clusters" dimColor>
        {run.clusters.length} cluster{run.clusters.length === 1 ? '' : 's'}
        {run.clusters.some(cluster => cluster.remedy !== undefined) ? ' (explained)' : ''}
      </Text>
      {props.versus !== undefined && props.versus !== null && props.versus.previous !== run.runId && (
        <Box key="run-versus">
          <Text wrap="wrap">
            {versusLine(props.versus)}
          </Text>
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="run-report" label="Report to Claude" hotkey="s" onPress={props.onReport} />
        {canExplain &&
          (props.explaining === run.runId ? (
            <Text key="run-explaining" color="cyan">
              explaining…
            </Text>
          ) : (
            <Button key="run-explain" label="Explain with rca" hotkey="w" onPress={props.onExplain} />
          ))}
        <Button key="run-compare" label="Compare with…" hotkey="m" onPress={props.onCompareWith} />
        <Button key="run-back" plain label="Back" hotkey="b" role="dismiss" onPress={props.onBack} />
      </Box>
      {run.rows.length > 0 && (
        <Box key="run-scenarios" flexDirection="column">
          <Text dimColor>
            {run.rows.length} scenario{run.rows.length === 1 ? '' : 's'} judged · open one for its evidence
          </Text>
          {run.rows.map(row =>
            props.onScenario === undefined ? (
              <Text key={`run-sc-${row.id}`} color={ICON[row.status].color} wrap="truncate-end">
                {scenarioLine(row)}
              </Text>
            ) : (
              <Button key={`run-sc-${row.id}`} plain label={scenarioLine(row)} onPress={() => props.onScenario!(row.id)} />
            ),
          )}
        </Box>
      )}
    </Box>
  )
}

function CompareView(props: RunsTabProps & { diff: RunDiff }) {
  const { Box, Text, Button } = props.el
  const { diff } = props
  const short = (status: RunDiffRow['base']) => (status === undefined ? '–' : status === 'Unable to Verify' ? '?' : status)
  const section = (key: string, title: string, color: string | undefined, rows: readonly RunDiffRow[]) =>
    rows.length === 0 ? null : (
      <Box key={key} flexDirection="column">
        <Text bold color={color}>
          {title} ({rows.length})
        </Text>
        {rows.map(row => (
          <Box key={`${key}-${row.id}`}>
            <Text wrap="truncate-end">
              {'  '}
              {row.id} {short(row.base)} → {short(row.head)}
              {row.title ? <Text dimColor> {row.title}</Text> : ''}
            </Text>
          </Box>
        ))}
      </Box>
    )
  const side = (label: string, s: RunDiff['base']) => (
    <Text key={`cmp-${label}`} wrap="truncate-end">
      <Text dimColor>{label} </Text>
      {s.name ? `${s.name} · ` : ''}
      {s.runId} · ✓{s.counts.pass} ✗{s.counts.fail} ?{s.counts.unverifiable} · {pct(s.passRate)}
      {s.credits === undefined ? '' : ` · ${credits(s.credits)}`}
    </Text>
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>Compare</Text>
        <Button key="cmp-back" plain label="Done" role="dismiss" onPress={props.onClearCompare} />
      </Box>
      {side('base', diff.base)}
      {side('head', diff.head)}
      <Text key="cmp-delta" wrap="wrap">
        {deltaLine(diff)}
      </Text>
      {section('cmp-fixed', 'Fixed', 'green', diff.fixed)}
      {section('cmp-regressed', 'Regressed', 'red', diff.regressed)}
      {section('cmp-added', 'New in head', undefined, diff.added)}
      {section('cmp-missing', 'Not re-run in head', 'yellow', diff.missing)}
      {section('cmp-still', 'Still failing', 'red', diff.stillFailing)}
      {section('cmp-unverified', 'Still Unable to Verify (not Fail)', 'yellow', diff.stillUnverified ?? [])}
      <Text dimColor>{diff.stillPassing} still passing</Text>
    </Box>
  )
}
