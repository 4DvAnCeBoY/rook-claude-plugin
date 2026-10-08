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

/** The pane's tab row: each tab a [ button ], the open one marked ▸ in the accent colour, then the view switch on `l`, and how to drive it. */
export function TabBar(props: { el: El; tab: RookTab; lens?: RookLens; onTab: (tab: RookTab) => void; onLens?: () => void }) {
  const { Box, Text, Button } = props.el

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {TABS.map(t =>
          t.id === props.tab ? (
            <Text key={`tab-${t.id}`} bold color="cyan">
              [ ▸ {tabLabel(t.id, t.label, props.lens)} ]
            </Text>
          ) : (
            <Button key={`tab-${t.id}`} label={tabLabel(t.id, t.label, props.lens)} hotkey={t.hotkey} onPress={() => props.onTab(t.id)} />
          ),
        )}
      </Box>
      <Box key="tabs-hint-row" flexDirection="row" gap={1} flexWrap="wrap">
        <Text key="tabs-hint" dimColor>
          Tab move · Enter press · 1-5 tabs · Esc prompt ·
        </Text>
        {props.lens !== undefined && props.onLens !== undefined && (
          <Button key="lens" plain dimColor label={`l view: ${LENS_LABEL[props.lens]}`} hotkey="l" onPress={props.onLens} />
        )}
      </Box>
    </Box>
  )
}
