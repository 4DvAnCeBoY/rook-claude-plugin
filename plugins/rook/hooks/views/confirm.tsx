import type { RookConfirm } from '../../types'
import type { El } from './kit'

/** A credit-spending action waiting for the person's yes. */
export function ConfirmBar(props: { el: El; confirm: RookConfirm; onConfirm: () => void; onCancel: () => void }) {
  const { Box, Text, Button } = props.el
  const { confirm } = props
  const cost = confirm.credits === undefined ? 'spends credits' : `~${Math.round(confirm.credits * 100) / 100} credits`

  return (
    <Box flexDirection="column">
      <Text color="yellow" wrap="wrap">
        ◆ {confirm.label} · {cost}
        {confirm.action === 'run' ? ' · calls your agent for real' : ''}
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="confirm-yes" label="Confirm" variant="primary" hotkey="y" onPress={props.onConfirm} />
        <Button key="confirm-no" label="Cancel" role="dismiss" onPress={props.onCancel} />
      </Box>
    </Box>
  )
}
