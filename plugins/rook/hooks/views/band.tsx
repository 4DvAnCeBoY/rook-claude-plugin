import type { RookStale } from '../../types'
import { credits, perScenario, staleLine, tickedOf } from '../format'
import type { El } from './kit'

/** Cells the band's fixed parts take: `◆ rook`, `[ Re-test N ]`, `i: Details` (a plain Button with a hotkey), `[ Dismiss ]` and the gaps. */
const FIXED = 47
/** The least of the summary worth keeping beside inline toggles. */
const SUMMARY_MIN = 40
/** Below this, the summary is cut to its counts. */
const NARROW = 72

const box = (isTicked: boolean) => (isTicked ? '☑' : '☐')

/**
 * The re-test band above the prompt: one line collapsed (what changed, what
 * it reaches, the ticked scenarios' cost, Re-test N, Details, Dismiss), the
 * scenarios as toggles inline when the width allows; Details lists each with
 * its title, why it was picked and its cost.
 */
export function RetestBand(props: {
  el: El
  stale: RookStale
  unticked: readonly string[]
  isOpen: boolean
  columns: number
  onToggle: (id: string) => void
  onRetest: () => void
  onDetails: () => void
  onDismiss: () => void
}) {
  const { Box, Text, Button } = props.el
  const { stale, unticked, isOpen, columns } = props
  const ticked = tickedOf(stale, unticked)
  const isTicked = (id: string) => !unticked.includes(id)
  const each = perScenario(stale)
  const total = each === undefined ? '' : ` · ~${credits(each * ticked.length)}`
  const togglesWidth = stale.scenarios.reduce((sum, s) => sum + s.id.length + 3, 0)
  const isInline = !isOpen && stale.scenarios.length > 0 && columns - FIXED - togglesWidth >= SUMMARY_MIN
  const summary = columns < NARROW ? `${ticked.length}/${stale.scenarios.length} scenarios${total}` : staleLine(stale, unticked)

  const toggle = (s: RookStale['scenarios'][number]) => (
    <Button key={`tick-${s.id}`} plain label={`${box(isTicked(s.id))} ${s.id}`} onPress={() => props.onToggle(s.id)} />
  )

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color="yellow">◆ rook</Text>
        <Box flexShrink={1} flexGrow={1}>
          <Text wrap="truncate-end">{summary}</Text>
        </Box>
        {isInline ? stale.scenarios.map(toggle) : null}
        <Button key="retest" label={`Re-test ${ticked.length}`} variant="primary" hotkey="a" dimColor={ticked.length === 0} onPress={props.onRetest} />
        <Button key="details" plain label={isOpen ? 'Hide' : 'Details'} hotkey="i" onPress={props.onDetails} />
        <Button key="dismiss" label="Dismiss" hotkey="z" role="dismiss" onPress={props.onDismiss} />
      </Box>
      {isOpen ? (
        <Box flexDirection="column">
          <Text dimColor wrap="wrap">
            {stale.files.join(', ')}
            {stale.reason === undefined ? '' : ` · ${stale.reason}`}
          </Text>
          {stale.scenarios.map(s => (
            <Box key={`row-${s.id}`} flexDirection="row" gap={1}>
              {toggle(s)}
              <Text wrap="truncate-end" dimColor={!isTicked(s.id)}>
                {s.title === '' ? '' : `${s.title} · `}
                {s.why ?? ''}
                {each === undefined ? '' : ` · ~${credits(each)}`}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
