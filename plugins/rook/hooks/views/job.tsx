import type { RookJob } from '../../types'
import type { El } from './kit'

/** A generate or explore in flight: one line, then a lane per step. Owned by the progress feature. */
export function JobLanes(props: { el: El; job: RookJob; now: number }) {
  const { Box, Text } = props.el
  const { job, now } = props
  const elapsed = Math.max(0, Math.round((now - job.startedAt) / 1000))

  return (
    <Box flexDirection="column">
      <Text color="cyan" wrap="truncate-end">
        ▸ {job.kind} · {job.label} · {Math.floor(elapsed / 60)}m{String(elapsed % 60).padStart(2, '0')}s
      </Text>
    </Box>
  )
}
