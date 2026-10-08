import type { RookLens, RookTab } from '../../types'
import type { El } from './kit'

export const TABS: { id: RookTab; label: string; hotkey: string }[] = [
  { id: 'health', label: 'Health', hotkey: '1' },
  { id: 'runs', label: 'Runs', hotkey: '2' },
  { id: 'scenarios', label: 'Scenarios', hotkey: '3' },
  { id: 'setup', label: 'Setup', hotkey: '4' },
  { id: 'trends', label: 'Trends', hotkey: '5' },
]

/** The first tab leads with release readiness for a QE and with the effect of their change for a developer. */
export const tabLabel = (id: RookTab, label: string, lens: RookLens | undefined): string =>
  id === 'health' && lens !== undefined ? (lens === 'qe' ? 'Release' : 'My change') : label

export const LENS_LABEL: Record<RookLens, string> = { qe: 'QE', dev: 'Developer' }

/** The pane's tab row: the open tab bold, the others buttons, then the lens switch on `l`. */
export function TabBar(props: { el: El; tab: RookTab; lens?: RookLens; onTab: (tab: RookTab) => void; onLens?: () => void }) {
  const { Box, Text, Button } = props.el

  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {TABS.map(t =>
        t.id === props.tab ? (
          <Text key={`tab-${t.id}`} bold underline>
            {t.hotkey}: {tabLabel(t.id, t.label, props.lens)}
          </Text>
        ) : (
          <Button key={`tab-${t.id}`} plain label={tabLabel(t.id, t.label, props.lens)} hotkey={t.hotkey} onPress={() => props.onTab(t.id)} />
        ),
      )}
      {props.lens !== undefined && props.onLens !== undefined && (
        <Button key="lens" plain dimColor label={`view: ${LENS_LABEL[props.lens]}`} hotkey="l" onPress={props.onLens} />
      )}
    </Box>
  )
}
