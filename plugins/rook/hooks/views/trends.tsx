import { pct } from '../history'
import { CELL_COLOR, CELL_GLYPH, scaledSparkline, sparkline, tokenCount, tokenDelta, TREND_COLOR, trendCounts } from '../trends'
import type { HeatGrid, ScenarioTrend, TrendRun } from '../trends'
import type { El } from './kit'

export type TrendsTabProps = {
  el: El
  grid: HeatGrid
  /** The newest finished runs, oldest first. */
  runs: TrendRun[]
  /**
   * The interactive grid (a `Client` drawn in register.tsx) where the surface
   * has one; null draws the text grid with a Button per scenario instead.
   */
  heat: unknown
  /** Open one scenario of one run in the drill-down. */
  onOpen: (runId: string, id: string) => void
}

/** `2026-09-28 15:48` from a run id. */
const shortRun = (runId: string): string => runId.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2}).*$/, '$1 $2:$3')

const TREND_ORDER: ScenarioTrend[] = ['regressed', 'flaky', 'never passed', 'fixed']

/** The latest of a series and what it was the run before: `50% (was 0%)`. */
const latestOf = (values: readonly (number | undefined)[], show: (n: number) => string): string => {
  const known = values.filter((v): v is number => v !== undefined)
  const latest = known.at(-1)
  const before = known.at(-2)

  return latest === undefined ? '' : `latest ${show(latest)}${before === undefined ? '' : ` (was ${show(before)})`}`
}

/** The Trends tab: is a scenario flaky, regressed, or has it never passed; and how each run did. Owned by the trends feature. */
export function TrendsTab(props: TrendsTabProps) {
  const { Box, Text, Button } = props.el
  const { grid, runs } = props

  if (grid.rows.length === 0 && runs.length === 0) {
    return <Text dimColor>No judged runs yet: trends start with the first finished run.</Text>
  }

  const passRates = runs.map(r => r.passRate)
  const trusted = runs.map(r => r.trusted)
  const tokens = runs.map(r => r.tokens)
  const delta = tokenDelta(runs)
  const counts = trendCounts(grid)
  const named = TREND_ORDER.filter(t => counts[t] > 0)
  const latestCell = (cells: readonly string[]) => {
    for (let c = cells.length - 1; c >= 0; c--) {
      if (cells[c] !== '') {
        return c
      }
    }

    return -1
  }

  return (
    <Box flexDirection="column">
      {runs.length > 0 && (
        <Box key="trend-runs" flexDirection="column">
          <Box key="trend-pass">
            <Text wrap="truncate-end">
              <Text dimColor>{'pass rate'.padEnd(10)}</Text>
              {sparkline(passRates)} <Text dimColor>{latestOf(passRates, pct)}</Text>
            </Text>
          </Box>
          {trusted.some(v => v !== undefined) && (
            <Box key="trend-trusted">
              <Text wrap="truncate-end">
                <Text dimColor>{'trusted'.padEnd(10)}</Text>
                {sparkline(trusted)} <Text dimColor>{latestOf(trusted, pct)}</Text>
              </Text>
            </Box>
          )}
          {tokens.some(v => v !== undefined) && (
            <Box key="trend-tokens">
              <Text wrap="truncate-end">
                <Text dimColor>{'tokens'.padEnd(10)}</Text>
                {scaledSparkline(tokens)} <Text dimColor>{latestOf(tokens, tokenCount)}</Text>
                {delta === undefined ? '' : <Text dimColor> · {delta}</Text>}
              </Text>
            </Box>
          )}
          <Box key="trend-runs-note">
            <Text dimColor wrap="truncate-end">
              last {runs.length} finished run{runs.length === 1 ? '' : 's'}, oldest first
            </Text>
          </Box>
        </Box>
      )}
      {grid.rows.length > 0 && (
        <Box key="trend-grid" flexDirection="column">
          <Box key="trend-counts">
            <Text wrap="truncate-end">
              {named.length === 0 ? (
                <Text dimColor>Nothing flaky, regressed or never passed in the last {grid.runIds.length} runs.</Text>
              ) : (
                named.map((t, i) => (
                  <Text key={`count-${t}`} color={TREND_COLOR[t]}>
                    {i > 0 ? ' · ' : ''}
                    {counts[t]} {t}
                  </Text>
                ))
              )}
            </Text>
          </Box>
          <Box key="heat-legend">
            <Text dimColor wrap="truncate-end">
              columns: runs oldest → newest
              {grid.runIds.length > 0 ? ` (1 = ${shortRun(grid.runIds[0]!)}, ${grid.runIds.length} = ${shortRun(grid.runIds.at(-1)!)})` : ''}
            </Text>
          </Box>
          {props.heat !== null && props.heat !== undefined
            ? (props.heat as never)
            : grid.rows.map(row => {
                const last = latestCell(row.cells)
                const runId = grid.runIds[last]

                return (
                  <Box key={`heat-${row.id}`} flexDirection="row" gap={1}>
                    {runId === undefined ? (
                      <Text key={`heat-id-${row.id}`}>{row.id}</Text>
                    ) : (
                      <Button key={`heat-open-${row.id}`} plain label={row.id} onPress={() => props.onOpen(runId, row.id)} />
                    )}
                    <Text key={`heat-cells-${row.id}`}>
                      {row.cells.map((cell, c) => (
                        <Text key={`heat-${row.id}-${c}`} color={CELL_COLOR[cell]} dimColor={cell === ''}>
                          {CELL_GLYPH[cell]}{' '}
                        </Text>
                      ))}
                    </Text>
                    {row.trend !== undefined && (
                      <Text key={`heat-trend-${row.id}`} color={TREND_COLOR[row.trend]}>
                        {row.trend}
                      </Text>
                    )}
                  </Box>
                )
              })}
        </Box>
      )}
    </Box>
  )
}
