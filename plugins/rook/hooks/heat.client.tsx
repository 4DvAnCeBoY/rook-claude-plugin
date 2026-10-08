// Each scenario across recent runs as a heat grid: one row per scenario, one
// column per run, ✓ ✗ ? coloured, blank where the scenario was not in that run.
// Hover or move the cursor for `SC-004 · run <id> · Fail`; click or Enter
// posts `ui.message` { type: 'pick', runId, id }. Keys the grid does not use
// are posted back as { type: 'key', key } so the pane's hotkeys keep working.
import type { ClientModule } from 'claude-code'

type Cell = 'P' | 'F' | 'U' | ''
type Row = { id: string; cells: Cell[]; trend?: string }
type Props = { runIds: string[]; rows: Row[] }
type At = { r: number; c: number }
type State = { cursor?: At; hover?: At }

const GLYPH: Record<Cell, string> = { P: '✓', F: '✗', U: '?', '': '·' }
const COLOR: Record<Cell, string | undefined> = { P: 'green', F: 'red', U: 'yellow', '': undefined }
const STATUS: Record<Cell, string> = { P: 'Pass', F: 'Fail', U: 'Unable to Verify', '': 'not in this run' }
const TREND: Record<string, string> = { flaky: 'yellow', regressed: 'red', 'never passed': 'red', fixed: 'green' }
const CELL_W = 2

const Heat: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const runIds = props.runIds ?? []
  const rows = props.rows ?? []
  const nameW = Math.max(7, ...rows.map(row => row.id.length)) + 1
  const same = (a: At | undefined, b: At | undefined) => a?.r === b?.r && a?.c === b?.c
  const clamp = (at: At): At => ({ r: Math.max(0, Math.min(rows.length - 1, at.r)), c: Math.max(0, Math.min(runIds.length - 1, at.c)) })

  const at = (x: number, y: number): At | undefined => {
    const r = y - 1
    const c = Math.floor((x - nameW) / CELL_W)

    return r >= 0 && r < rows.length && c >= 0 && c < runIds.length ? { r, c } : undefined
  }

  const pick = (cell: At) => {
    const row = rows[cell.r]
    const runId = runIds[cell.c]

    if (row !== undefined && runId !== undefined && (row.cells[cell.c] ?? '') !== '') {
      surface.post({ type: 'pick', runId, id: row.id })
    }
  }

  surface.onPointer(e => {
    const cell = at(e.x, e.y)

    if (e.type === 'leave') {
      if (state.hover !== undefined) {
        surface.setState({ ...state, hover: undefined })
      }

      return
    }

    if (e.type === 'move' && !same(cell, state.hover)) {
      surface.setState({ ...state, hover: cell })
    }

    if (e.type === 'down' && e.button === 'left' && cell !== undefined) {
      surface.setState({ cursor: cell, hover: cell })
      pick(cell)
    }
  })

  surface.onKey(e => {
    const cursor = state.cursor ?? { r: 0, c: Math.max(0, runIds.length - 1) }
    const move: Record<string, At> = {
      up: { r: cursor.r - 1, c: cursor.c },
      down: { r: cursor.r + 1, c: cursor.c },
      left: { r: cursor.r, c: cursor.c - 1 },
      right: { r: cursor.r, c: cursor.c + 1 },
    }
    const next = move[e.key]

    if (next !== undefined) {
      if (rows.length > 0 && runIds.length > 0) {
        surface.setState({ ...state, cursor: clamp(next) })
      }
    } else if (e.key === 'return') {
      pick(cursor)
    } else if (e.key.length === 1 && e.ctrl === undefined && e.meta === undefined) {
      // Not the grid's: the pane's hotkeys (tabs, lens).
      surface.post({ type: 'key', key: e.key })
    }
  })

  const shown = state.hover ?? state.cursor
  const shownRow = shown === undefined ? undefined : rows[shown.r]
  const shownRun = shown === undefined ? undefined : runIds[shown.c]
  const line =
    shownRow !== undefined && shownRun !== undefined
      ? `${shownRow.id} · run ${shownRun} · ${STATUS[shownRow.cells[shown!.c] ?? '']}`
      : 'Hover or use the arrows for a verdict · click or Enter opens it'

  return (
    <Box flexDirection="column">
      <Box key="heat-head" flexDirection="row">
        <Text dimColor>{'run'.padEnd(nameW)}</Text>
        {runIds.map((runId, c) => (
          <Text key={`h-${runId}`} dimColor bold={shown?.c === c}>
            {String((c + 1) % 10).padEnd(CELL_W)}
          </Text>
        ))}
      </Box>
      {rows.map((row, r) => (
        <Box key={`r-${row.id}`} flexDirection="row">
          <Text color={row.trend === undefined ? undefined : TREND[row.trend]} bold={shown?.r === r}>
            {row.id.padEnd(nameW)}
          </Text>
          {runIds.map((runId, c) => {
            const cell = row.cells[c] ?? ''
            const isOn = shown?.r === r && shown?.c === c

            return (
              <Text key={`c-${row.id}-${runId}`} color={COLOR[cell]} dimColor={cell === ''} inverse={isOn}>
                {(cell === '' ? ' ' : GLYPH[cell]).padEnd(CELL_W)}
              </Text>
            )
          })}
          {row.trend !== undefined && (
            <Text key={`t-${row.id}`} color={TREND[row.trend]}>
              {' '}
              {row.trend}
            </Text>
          )}
        </Box>
      ))}
      <Text key="heat-line" dimColor={shownRow === undefined} wrap="truncate-end">
        {line}
      </Text>
    </Box>
  )
}

export default Heat
