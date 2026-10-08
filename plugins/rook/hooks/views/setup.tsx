import type { RookReadiness } from '../../types'
import { needsSync, PROFILE_STEPS, SYNC_NOTE, treeWords } from '../setup'
import type { ProfileView, SyncState, Wizard } from '../setup'
import type { El } from './kit'

/** Everything the Setup tab shows past the checklist, once there is an agent. Built in the render hook. */
export type SetupPanel = {
  profiles: ProfileView[]
  wizard: Wizard | undefined
  budgetLine: string
  sync: SyncState | null
  /** Nothing in flight that a profile switch or a sync would disturb. */
  canAct: boolean
}

/** The Setup tab's buttons, as closures built in the render hook. */
export type SetupActions = {
  onUse: (id: string) => void
  onTest: (id: string) => void
  onSync: () => void
  onCheckSync: () => void
  onRefresh: () => void
}

/** The setup checklist, the next step highlighted. Shown alone with no agent, and as the Setup tab. Owned by the setup-tab feature. */
export function SetupTab(props: { el: El; readiness: RookReadiness | undefined; onRecheck: () => void; panel?: SetupPanel; actions?: SetupActions }) {
  const { Box, Text, Button } = props.el
  const { readiness } = props
  const panel = props.panel !== undefined && props.actions !== undefined ? { ...props.panel, ...props.actions } : undefined
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
      {panel !== undefined && <Profiles el={props.el} panel={panel} />}
      {panel?.wizard !== undefined && <ProfileWizard el={props.el} wizard={panel.wizard} />}
      {panel !== undefined && <Sync el={props.el} panel={panel} />}
      {panel !== undefined && (
        <Box key="budget" flexDirection="column">
          <Text bold>Budget</Text>
          <Box key="budget-line">
            <Text wrap="wrap">{panel.budgetLine}</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** The active agent's profiles: target, verified, variables set or unset. Never a value. */
function Profiles(props: { el: El; panel: SetupPanel & SetupActions }) {
  const { Box, Text, Button } = props.el
  const { panel } = props

  return (
    <Box key="profiles" flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold>Profiles</Text>
        <Button key="refresh-setup" plain label="refresh" onPress={panel.onRefresh} />
      </Box>
      {panel.profiles.length === 0 && <Text dimColor>none on disk for this agent.</Text>}
      {panel.profiles.map(profile => (
        <Box key={`p-${profile.id}`} flexDirection="column">
          <Box key={`pl-${profile.id}`}>
          <Text wrap="truncate-end">
            <Text color={profile.isActive ? 'green' : undefined} bold={profile.isActive}>
              {profile.isActive ? '● ' : '○ '}
              {profile.id}
            </Text>
            {profile.isActive ? <Text dimColor> active</Text> : ''}
            <Text color={profile.isVerified ? 'green' : 'yellow'}> · {profile.isVerified ? 'verified' : 'not verified'}</Text>
            <Text dimColor> · {profile.target}</Text>
          </Text>
          </Box>
          {profile.steps.length > 0 && (
            <Box key={`ps-${profile.id}`} paddingLeft={2}>
              <Text dimColor wrap="truncate-end">
                steps: {profile.steps.join(', ')}
              </Text>
            </Box>
          )}
          {profile.variables.length > 0 && (
            <Box key={`pv-${profile.id}`} flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={2}>
              {profile.variables.map(variable => (
                <Box key={`v-${profile.id}-${variable.name}`}>
                  <Text color={variable.isSet ? 'green' : 'yellow'}>
                    {variable.isSet ? '✓' : '✗'} {variable.name} {variable.isSet ? 'set' : 'unset'}
                  </Text>
                </Box>
              ))}
            </Box>
          )}
          {profile.variables.some(variable => !variable.isSet) && (
            <Box key={`pe-${profile.id}`} paddingLeft={2}>
              <Text wrap="wrap">
                type: {`! rook env set '{${profile.variables.filter(variable => !variable.isSet).map(variable => `"${variable.name}":"…"`).join(',')}}'`}
              </Text>
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            {!profile.isActive && panel.canAct && <Button key={`use-${profile.id}`} label="Use" onPress={() => panel.onUse(profile.id)} />}
            {panel.canAct && <Button key={`test-${profile.id}`} label="Test" onPress={() => panel.onTest(profile.id)} />}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** What rook needs to reach the agent, and the exact lines to type. */
function ProfileWizard(props: { el: El; wizard: Wizard }) {
  const { Box, Text } = props.el
  const { wizard } = props
  const defined = new Set(wizard.defined ?? [])

  return (
    <Box key="wizard" flexDirection="column">
      <Text bold color="yellow">
        Reaching the agent: {wizard.reason}
      </Text>
      <Text dimColor wrap="wrap">
        A profile is scripts rook runs at five steps of every scenario:
      </Text>
      {PROFILE_STEPS.map(step => (
        <Box key={`ws-${step.id}`} paddingLeft={2}>
          <Text wrap="truncate-end" dimColor={wizard.defined !== undefined && !defined.has(step.id)}>
            {wizard.defined === undefined ? '·' : defined.has(step.id) ? '✓' : '–'} {step.id}: {step.what}
          </Text>
        </Box>
      ))}
      {wizard.connectionFile !== undefined && (
        <Box key="w-file">
          <Text>found {wizard.connectionFile} in the repository root</Text>
        </Box>
      )}
      <Text bold>Type at the prompt:</Text>
      {wizard.commands.map((command, at) => (
        <Box key={`w-cmd-${at}`} flexDirection="column" paddingLeft={2}>
          <Box key={`w-text-${at}`}>
            <Text color="cyan" wrap="wrap">
              {command.text}
            </Text>
          </Box>
          <Box key={`w-why-${at}`} paddingLeft={2}>
            <Text dimColor wrap="wrap">
              {command.why}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** Where this machine stands against upstream, and the button that records it. */
function Sync(props: { el: El; panel: SetupPanel & SetupActions }) {
  const { Box, Text, Button } = props.el
  const { sync, canAct } = props.panel
  const isBehind = sync?.agents.some(agent => needsSync(agent.tree)) ?? false

  return (
    <Box key="sync" flexDirection="column">
      <Text bold>Sync</Text>
      <Text dimColor wrap="wrap">
        {SYNC_NOTE}
      </Text>
      {sync === null && <Text dimColor>sync state not checked yet.</Text>}
      {sync?.offline === true && <Text color="yellow">could not reach upstream: whether it moved is unknown.</Text>}
      {sync?.agents.map(agent => (
        <Box key={`sy-${agent.id}`} flexDirection="column">
          <Text wrap="truncate-end" color={needsSync(agent.tree) ? 'yellow' : agent.tree === 'clean' ? 'green' : undefined}>
            {agent.id}
            {agent.version === undefined ? ' never synced' : ` v${agent.version}`} · {treeWords(agent.tree)}
          </Text>
          {agent.changes.slice(0, 4).map((line, at) => (
            <Box key={`sy-${agent.id}-${at}`} paddingLeft={2}>
              <Text dimColor wrap="truncate-end">
                {line}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
      {sync?.said !== undefined && (
        <Box key="sync-said">
          <Text dimColor wrap="wrap">
            {sync.said}
          </Text>
        </Box>
      )}
      {sync?.error !== undefined && (
        <Box key="sync-error">
          <Text color="red" wrap="wrap">
            {sync.error}
          </Text>
        </Box>
      )}
      {sync?.isSyncing === true ? (
        <Text color="cyan">▸ syncing upstream…</Text>
      ) : (
        <Box flexDirection="row" gap={1}>
          {canAct && <Button key="sync-upstream" label="Sync upstream" variant={isBehind ? 'primary' : undefined} onPress={props.panel.onSync} />}
          <Button key="check-sync" label="Check sync state" onPress={props.panel.onCheckSync} />
        </Box>
      )}
    </Box>
  )
}
