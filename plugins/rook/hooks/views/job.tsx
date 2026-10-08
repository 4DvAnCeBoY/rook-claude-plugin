import type { RookJob } from '../../types'
import { progressBar } from '../format'
import { countText, elapsed, isLaneDone, shownLanes } from '../progress'
import type { El } from './kit'

/** A generate or explore in flight: one line, then a lane per step. Owned by the progress feature. */
export function JobLanes(props: { el: El; job: RookJob; now: number; width?: number }) {
  const { Box, Text } = props.el
  const { job, now } = props
  const width = props.width ?? 64
  const { lanes, hidden } = shownLanes(job)
  const count = countText(job)
  const hasBar = job.planned !== undefined && job.planned > 0

  return (
    <Box flexDirection="column">
      <Text color="cyan" wrap="truncate-end">
        ▸ rook {job.kind} · {job.label} · {elapsed(now - job.startedAt)}
        {count !== undefined && !hasBar ? ` · ${count}` : ''}
      </Text>
      {hasBar ? (
        <Text key="job-bar" wrap="truncate-end">
          {progressBar(job.done ?? 0, job.planned!, Math.min(30, width - 16))} {count}
        </Text>
      ) : null}
      {lanes.map(lane => (
        <Text key={`job-lane-${lane.id}`} wrap="truncate-end" dimColor={isLaneDone(lane)}>
          {isLaneDone(lane) ? '  ✓ ' : '  ◌ '}
          {lane.id} · {lane.phase}
          {lane.planned !== undefined ? ` ${lane.done ?? 0}/${lane.planned}` : ''}
          {isLaneDone(lane) ? '' : ` · ${elapsed(now - lane.since)}`}
          {lane.label ? ` · ${lane.label}` : ''}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text key="job-more" dimColor>
          {'  '}…and {hidden} more
        </Text>
      ) : null}
      {job.last !== undefined ? (
        <Text key="job-last" dimColor wrap="truncate-end">
          {'  '}
          {job.last}
        </Text>
      ) : null}
    </Box>
  )
}
