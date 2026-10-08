import type { RookTab } from '../../types'
import type { El } from './kit'

export const TABS: { id: RookTab; label: string; hotkey: string }[] = [
  { id: 'health', label: 'Health', hotkey: '1' },
  { id: 'runs', label: 'Runs', hotkey: '2' },
  { id: 'scenarios', label: 'Scenarios', hotkey: '3' },
  { id: 'setup', label: 'Setup', hotkey: '4' },
]

/** The pane's tab row: the open tab bold, the others buttons. */
export function TabBar(props: { el: El; tab: RookTab; onTab: (tab: RookTab) => void }) {
  const { Box, Text, Button } = props.el

  return (
    <Box flexDirection="row" gap={1}>
      {TABS.map(t =>
        t.id === props.tab ? (
          <Text key={`tab-${t.id}`} bold underline>
            {t.hotkey}: {t.label}
          </Text>
        ) : (
          <Button key={`tab-${t.id}`} plain label={t.label} hotkey={t.hotkey} onPress={() => props.onTab(t.id)} />
        ),
      )}
    </Box>
  )
}
