import type { RookRepoFound } from '../../types'
import { nextStep } from '../repo'
import type { StartAction, StartStep } from '../repo'
import type { El } from './kit'

/** The one-line key guide at the foot of a focused pane. The engine does the moving; this only says how. */
export const KEYS_HINT = '↹/↑↓ move · Enter press · 1-5 tabs · l view · Esc back to the prompt'

export function KeysHint(props: { el: El }) {
  const { Box, Text } = props.el

  return (
    <Box key="keys-hint">
      <Text dimColor wrap="truncate-end">
        {KEYS_HINT}
      </Text>
    </Box>
  )
}

const KINDS: Record<RookRepoFound['kind'], string> = { agent: 'agent', requirements: 'requirements', connection: 'connection', ci: 'CI' }

/** What a scan of a repository with no rook setup found that rook can start from. */
export function FoundList(props: { el: El; found: readonly RookRepoFound[] }) {
  const { Box, Text } = props.el

  return (
    <Box key="found" flexDirection="column">
      <Text bold>Found in this repo</Text>
      {props.found.length === 0 && <Text dimColor>no agent code, requirements, connection doc or CI found at the top level or in src/.</Text>}
      {props.found.map(item => (
        <Box key={`found-${item.path}`} paddingLeft={2}>
          <Text wrap="truncate-end">
            <Text color="cyan">{KINDS[item.kind]}</Text> {item.path} <Text dimColor>· {item.what}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/**
 * The next step of the guided start and the button that takes it: the first
 * button the pane's focus ring lands on. `steps` lists the rest above it when
 * `isListed` (the first-run lead lists them; the no-agent pane's checklist
 * already does). Credit-spending actions say so; the confirm bar asks.
 */
export function NextStep(props: {
  el: El
  steps: readonly StartStep[]
  /** List every step, ticked or not, above the next one. */
  isListed?: boolean
  /** Leave out the Next line: the checklist above already says it. */
  isButtonsOnly?: boolean
  title?: string
  canAct: boolean
  onAction: (action: StartAction) => void
}) {
  const { Box, Text, Button } = props.el
  const next = nextStep(props.steps)

  if (next === undefined) {
    return null
  }

  return (
    <Box key="start" flexDirection="column">
      {props.title !== undefined && <Text bold>{props.title}</Text>}
      {props.isListed === true &&
        props.steps.map(step => (
          <Box key={`start-s-${step.id}`}>
            <Text color={step.ok ? 'green' : step === next ? 'yellow' : undefined} dimColor={!step.ok && step !== next} bold={step === next}>
              {step.ok ? '✓' : '✗'} {step.label}
            </Text>
          </Box>
        ))}
      {props.isButtonsOnly !== true && (
        <Box key="start-next">
          <Text wrap="wrap">
            <Text bold>Next: </Text>
            {next.label}
            {next.command !== undefined && <Text color="cyan"> · {next.command}</Text>}
          </Text>
        </Box>
      )}
      {props.canAct && (next.action !== undefined || next.other !== undefined) && (
        <Box flexDirection="row" gap={1}>
          {/* The checklist above draws its own Check again. */}
          {next.action !== undefined && !(next.action.kind === 'recheck' && props.isButtonsOnly === true) && (
            <Button
              key="start-go"
              label={`${next.action.label}${next.action.spends ? ' (spends credits)' : ''}`}
              variant="primary"
              hotkey="j"
              autoFocus
              onPress={() => props.onAction(next.action!)}
            />
          )}
          {next.other !== undefined && <Button key="start-other" label={next.other.label} hotkey="u" onPress={() => props.onAction(next.other!)} />}
        </Box>
      )}
    </Box>
  )
}

/**
 * The pane in a folder rook is not set up in yet (no agent to show): what the
 * repository holds, the checklist (the Setup tab's, handed in), and the
 * button for the next step.
 */
export function FreshStart(props: {
  el: El
  hasWorkspace: boolean
  checklist: unknown
  found: readonly RookRepoFound[] | undefined
  steps: readonly StartStep[]
  canAct: boolean
  onAction: (action: StartAction) => void
}) {
  const { Box, Text } = props.el

  return (
    <Box key="fresh" flexDirection="column">
      {!props.hasWorkspace && (
        <Text bold color="yellow">
          rook isn't set up in this folder
        </Text>
      )}
      {props.checklist as never}
      {props.found !== undefined && <FoundList el={props.el} found={props.found} />}
      <NextStep el={props.el} steps={props.steps} isButtonsOnly canAct={props.canAct} onAction={props.onAction} />
    </Box>
  )
}
