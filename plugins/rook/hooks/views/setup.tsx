import type { RookReadiness } from '../../types'
import type { El } from './kit'

/** The setup checklist, the next step highlighted. Shown alone with no agent, and as the Setup tab. Owned by the setup-tab feature. */
export function SetupTab(props: { el: El; readiness: RookReadiness | undefined; onRecheck: () => void }) {
  const { Box, Text, Button } = props.el
  const { readiness } = props
  const nextId = readiness?.steps.find(step => !step.ok)?.id
  const isCliStep = nextId === 'installed' || nextId === 'signed_in'

  return (
    <Box flexDirection="column">
      <Text bold>rook · setup</Text>
      {readiness === undefined && <Text dimColor>Checking this directory…</Text>}
      {readiness?.steps.map(step => (
        <Box key={`s-${step.id}`}>
          <Text color={step.ok ? 'green' : step.id === nextId ? 'yellow' : undefined} dimColor={!step.ok && step.id !== nextId} bold={step.id === nextId}>
            {step.ok ? '✓' : '✗'} {step.label}
          </Text>
        </Box>
      ))}
      {readiness?.next !== undefined && (
        <Box key="next">
          <Text wrap="wrap">
            <Text bold>Next: </Text>
            {readiness.next}
          </Text>
        </Box>
      )}
      {isCliStep && <Button key="recheck" label="Check again" onPress={props.onRecheck} />}
    </Box>
  )
}
