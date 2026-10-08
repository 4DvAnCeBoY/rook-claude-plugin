import type { RookLane } from '../../types'
import { elapsed } from '../format'
import type { JudgedRow, LiveState } from '../live'
import { newFailText, STATUS_ICON } from '../live'
import { OWNER_COLOR } from '../owner'
import type { El } from './kit'

const STATUS_COLOR = { Pass: 'green', Fail: 'red', 'Unable to Verify': 'yellow' } as const

/**
 * The run in flight at the top of every tab: one headline, its lanes, and the
 * verdicts that just came in, each opening the drill-down. Owned by the live
 * feature; `canCancel` only for a run this session started.
 */
export function LiveBlock(props: {
  el: El
  headline: string
  lanes: readonly RookLane[]
  judged: readonly JudgedRow[]
  now: number
  width: number
  canCancel: boolean
  onOpen: (id: string) => void
  onCancel: () => void
}) {
  const { Box, Text, Button } = props.el
  const { lanes, judged, now, width } = props

  return (
    <Box key="live" flexDirection="column">
      <Box key="live-head" flexDirection="row" gap={1}>
        <Box flexShrink={1} flexGrow={1}>
          <Text color="cyan" wrap="truncate-end">
            {props.headline}
          </Text>
        </Box>
        {props.canCancel ? <Button key="cancel-run" label="Cancel" hotkey="c" role="dismiss" onPress={props.onCancel} /> : null}
      </Box>
      {lanes.slice(0, 8).map(lane => {
        const took = lane.since > 0 ? Math.max(0, now - lane.since) : undefined

        return (
          <Box key={`live-lane-${lane.id}`} paddingLeft={2}>
            <Text wrap="truncate-end">
              <Text color="cyan">⟡ {lane.id}</Text>
              <Text dimColor> {lane.phase}</Text>
              {took !== undefined ? <Text color={took > 60_000 ? 'yellow' : undefined}> {elapsed(took)}</Text> : ''} {lane.title}
            </Text>
          </Box>
        )
      })}
      {judged.length > 0 ? (
        <Text key="live-judged-title" dimColor>
          just judged
        </Text>
      ) : null}
      {judged.map(row => (
        <Box key={`live-judged-${row.id}`} flexDirection="row" gap={1} paddingLeft={2}>
          <Text color={STATUS_COLOR[row.status]}>{STATUS_ICON[row.status]}</Text>
          <Button
            key={`judged-${row.id}`}
            plain
            label={`${row.id} ${clipTo(row.title, Math.max(8, width - 30))}${row.isStale ? ' ⧗' : ''}`}
            onPress={() => props.onOpen(row.id)}
          />
          {row.owner !== undefined ? <Text color={OWNER_COLOR[row.owner]}>[{row.ownerLabel}]</Text> : null}
        </Box>
      ))}
    </Box>
  )
}

/** The band above the prompt while a run is in flight. Open (o) and, for this session's run, Cancel (c). */
export function RunBand(props: { el: El; text: string; canCancel: boolean; onOpen: () => void; onCancel: () => void }) {
  const { Box, Text, Button } = props.el

  return (
    <Box key="run-band" flexDirection="row" gap={1}>
      <Box flexShrink={1} flexGrow={1}>
        <Text color="cyan" wrap="truncate-end">
          {props.text}
        </Text>
      </Box>
      <Button key="band-open" label="Open" hotkey="o" onPress={props.onOpen} />
      {props.canCancel ? <Button key="band-cancel" label="Cancel" hotkey="c" role="dismiss" onPress={props.onCancel} /> : null}
    </Box>
  )
}

/** A run started elsewhere broke scenarios that passed before: shown until dismissed. */
export function NewFailBand(props: { el: El; newFail: NonNullable<LiveState['newFail']>; onOpen: () => void; onDismiss: () => void }) {
  const { Box, Text, Button } = props.el

  return (
    <Box key="newfail-band" flexDirection="row" gap={1}>
      <Box flexShrink={1} flexGrow={1}>
        <Text color="red" wrap="truncate-end">
          {newFailText(props.newFail)}
        </Text>
      </Box>
      <Button key="band-open" label="Open" hotkey="o" onPress={props.onOpen} />
      <Button key="newfail-dismiss" label="Dismiss" role="dismiss" onPress={props.onDismiss} />
    </Box>
  )
}

const clipTo = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)
