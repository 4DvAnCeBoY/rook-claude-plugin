import type { CardFacts, CardProgress } from '../card'
import type { El } from './kit'

/** A finished run in the transcript, in place of the tool's plain result text. Owned by the card feature. */
export function VerdictCard(props: { el: El; card: CardFacts; onOpen: () => void; onFix: () => void }) {
  const { Box, Text, Button } = props.el
  const { card } = props

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={card.hasFailures ? 'red' : 'green'} paddingX={1}>
      <Text bold wrap="truncate-end">
        rook run {card.runId}
        {card.name ? <Text dimColor> · {card.name}</Text> : ''}
      </Text>
      <Text wrap="wrap">
        <Text color="green">✓ {card.pass} Pass</Text>
        {'  '}
        <Text color="red">✗ {card.fail} Fail</Text>
        {'  '}
        <Text color="yellow">? {card.unverifiable} Unable to Verify</Text>
        <Text dimColor> · {card.judged}</Text>
      </Text>
      {card.metrics !== '' && (
        <Text dimColor wrap="truncate-end">
          {card.metrics}
        </Text>
      )}
      {card.items.map(item => (
        <Box key={`card-${item.id}`}>
          <Text wrap="truncate-end">
            <Text color={item.isCluster ? 'magenta' : 'red'}>{item.id}</Text> {item.title}
          </Text>
        </Box>
      ))}
      {card.more > 0 && <Text dimColor>…and {card.more} more</Text>}
      <Box flexDirection="row" gap={1}>
        <Button key="card-open" label="Open in pane" hotkey="o" onPress={props.onOpen} />
        {card.hasFailures && <Button key="card-fix" label="Fix with Claude" variant="primary" hotkey="x" onPress={props.onFix} />}
      </Box>
    </Box>
  )
}

/** The run tool's row while the run is in flight: judged so far and the lanes still going. */
export function RunProgressRow(props: { el: El; progress: CardProgress }) {
  const { Box, Text } = props.el
  const { progress } = props

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold>rook run</Text>
        <Text color="cyan">
          {' '}
          ▸ {progress.done}/{progress.planned} judged
        </Text>
        {progress.failing > 0 ? <Text color="red"> · {progress.failing} failing</Text> : ''}
      </Text>
      {progress.lanes.length > 0 && (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {progress.lanes.join(' · ')}
          {progress.more > 0 ? ` +${progress.more}` : ''}
        </Text>
      )}
    </Box>
  )
}
