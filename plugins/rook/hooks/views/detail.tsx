import type { RookEvidence, RookOwner, RookStatus } from '../../types'
import { ago, costLine, GLYPH, strip, waterfall } from '../detail'
import type { DetailAction, DetailActionId, DetailSection } from '../detail'
import { excerpt } from '../format'
import { OWNER_COLOR, OWNER_LABEL } from '../owner'
import type { El } from './kit'

export type DetailProps = {
  el: El
  id: string
  runId: string
  /** Null while it is read, and when the run left no verdict for it. */
  evidence: RookEvidence | null
  /** The scenario file's title, while the evidence is read. */
  title?: string
  owner?: { owner: RookOwner; why: string }
  sections: DetailSection[]
  /** The scenario's verdicts up to this run, oldest first. */
  history: { runId: string; status: RookStatus }[]
  isRegressed: boolean
  isFlaky: boolean
  /** Class, category, feature. */
  tags: string[]
  changed: { path: string; mtimeMs: number }[]
  /** The same scenario's cost in the run before, when its verdict is at hand. */
  costBefore?: { runId: string; turns?: number; tokens?: { input: number; output: number }; latencyMs?: number }
  actions: DetailAction[]
  now: number
  width: number
  onAction: (id: DetailActionId) => void
  onBack: () => void
}

const CHANGED_MAX = 6
const TURNS_MAX = 24
const TURN_CHARS = 360

const mark = (status: RookStatus): { icon: string; color: string } =>
  status === 'Pass' ? { icon: GLYPH.Pass, color: 'green' } : status === 'Fail' ? { icon: GLYPH.Fail, color: 'red' } : { icon: GLYPH['Unable to Verify'], color: 'yellow' }

const roleLabel = (role: string) => (role === 'user' ? 'rook (as the user)' : role)

/** One scenario of one run: why it is whose, then the evidence in the lens's order, then what to do. Owned by the drill-down feature. */
export function ScenarioDrillDown(props: DetailProps) {
  const { Box, Text, Button } = props.el
  const { evidence: e, owner, id } = props
  const status = e?.status
  const m = status === undefined ? undefined : mark(status)
  const title = e?.title || props.title || ''

  const header = (
    <Box key="dd-head" flexDirection="column">
      <Text bold wrap="wrap">
        {m !== undefined && <Text color={m.color}>{m.icon} </Text>}
        {id} {title}
      </Text>
      <Text wrap="wrap">
        {owner !== undefined && (
          <Text color={OWNER_COLOR[owner.owner] as never} bold>
            [{OWNER_LABEL[owner.owner]}]
          </Text>
        )}
        {props.isRegressed && <Text color="red"> regressed</Text>}
        {props.isFlaky && <Text color="yellow"> flaky</Text>}
        <Text dimColor>
          {props.tags.length > 0 ? ` · ${props.tags.join(' · ')}` : ''} · run {props.runId}
          {props.history.length > 0 ? ' · ' : ''}
        </Text>
        {props.history.map((verdict, at) => (
          <Text key={`dd-h${at}`} color={mark(verdict.status).color}>
            {GLYPH[verdict.status]}
          </Text>
        ))}
      </Text>
    </Box>
  )

  const back = <Button key="detail-back" label="Back" hotkey="b" role="dismiss" onPress={props.onBack} />

  if (e === null) {
    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>reading its evidence…</Text>
        {back}
      </Box>
    )
  }

  const heading = (key: string, text: string) => (
    <Text key={key} bold>
      {text}
    </Text>
  )

  const sections: Record<DetailSection, () => unknown> = {
    why: () =>
      owner === undefined ? null : (
        <Box key="dd-why" flexDirection="column" borderStyle="round" borderColor={OWNER_COLOR[owner.owner] as never} paddingX={1}>
          <Text wrap="wrap" color={OWNER_COLOR[owner.owner] as never}>
            {owner.why}
          </Text>
          {e.summary !== '' && (
            <Text wrap="wrap" dimColor>
              {excerpt(e.summary, 500)}
            </Text>
          )}
        </Box>
      ),

    changed: () => (
      <Box key="dd-changed" flexDirection="column">
        {heading('dd-changed-h', 'Changed since it last passed')}
        {props.changed.length === 0 ? (
          <Text dimColor>No tracked file changed since it last passed (or it has not passed in the runs on disk).</Text>
        ) : (
          props.changed.slice(0, CHANGED_MAX).map(f => (
            <Text key={`dd-ch-${f.path}`} wrap="truncate-end">
              · {f.path} <Text dimColor>{ago(props.now - f.mtimeMs)} ago</Text>
            </Text>
          ))
        )}
        {props.changed.length > CHANGED_MAX && <Text dimColor>… {props.changed.length - CHANGED_MAX} more</Text>}
      </Box>
    ),

    criteria: () => (
      <Box key="dd-criteria" flexDirection="column">
        {heading('dd-criteria-h', `Criteria (${e.criteria.filter(c => c.status === 'Pass').length}/${e.criteria.length} passed)`)}
        {e.criteria.length === 0 && <Text dimColor>The verdict lists no criteria.</Text>}
        {e.criteria.map(c => {
          const cm = mark(c.status)
          const isWeak = c.status === 'Pass' && c.confidence === 'Low'

          return (
            <Box key={`dd-c-${c.id}`} flexDirection="column">
              <Text wrap="wrap">
                <Text color={cm.color}>{cm.icon}</Text> <Text bold>{c.id}</Text>
                {c.confidence !== undefined && <Text dimColor> {c.confidence}</Text>}
                {isWeak && <Text color="yellow"> weak</Text>} {excerpt(c.criterion, 300)}
              </Text>
              {c.status !== 'Pass' && c.expected !== '' && (
                <Text wrap="wrap">
                  {'  '}
                  <Text color="green">expected </Text>
                  {excerpt(c.expected, 400)}
                </Text>
              )}
              {c.status !== 'Pass' && c.achieved !== '' && (
                <Text wrap="wrap">
                  {'  '}
                  <Text color="red">achieved </Text>
                  {excerpt(c.achieved, 400)}
                </Text>
              )}
              {c.status !== 'Pass' && c.evidence !== '' && (
                <Text wrap="wrap" dimColor>
                  {'  '}evidence {excerpt(c.evidence, 400)}
                </Text>
              )}
            </Box>
          )
        })}
        {e.gaps.length > 0 && (
          <Text wrap="wrap" color="yellow">
            could not see: {e.gaps.join('; ')}
          </Text>
        )}
        {e.forbiddenHits.length > 0 && (
          <Text wrap="wrap" color="red">
            forbidden: {e.forbiddenHits.join(', ')}
          </Text>
        )}
      </Box>
    ),

    history: () => (
      <Box key="dd-history" flexDirection="column">
        {heading('dd-history-h', 'History')}
        {props.history.length === 0 ? (
          <Text dimColor>No other runs judged it.</Text>
        ) : (
          <Text wrap="wrap">
            {strip(props.history)}{' '}
            <Text dimColor>
              oldest → this run, {props.history.length} run{props.history.length === 1 ? '' : 's'}
              {props.isRegressed ? ' · passed the run before' : ''}
              {props.isFlaky ? ' · flips between pass and fail' : ''}
            </Text>
          </Text>
        )}
      </Box>
    ),

    conversation: () => (
      <Box key="dd-conv" flexDirection="column">
        {heading('dd-conv-h', 'Conversation')}
        {e.transcript.length === 0 && <Text dimColor>No conversation was recorded.</Text>}
        {e.transcript.slice(0, TURNS_MAX).map((t, at) => (
          <Text key={`dd-t${at}`} wrap="wrap" color={t.isCited ? 'red' : undefined}>
            {t.isCited ? '◆ ' : ''}
            <Text bold dimColor={t.role === 'user'}>
              {roleLabel(t.role)}:
            </Text>{' '}
            {excerpt(t.content, TURN_CHARS)}
          </Text>
        ))}
        {e.transcript.length > TURNS_MAX && <Text dimColor>… {e.transcript.length - TURNS_MAX} more turns in response.json</Text>}
        <Text wrap="wrap" dimColor>
          tool calls: {e.toolCalls.length === 0 ? 'none recorded' : e.toolCalls.map(c => c.name).join(', ')}
        </Text>
      </Box>
    ),

    phases: () => {
      const rows = waterfall(e.phases, Math.max(4, props.width - 24))

      return (
        <Box key="dd-phases" flexDirection="column">
          {heading('dd-phases-h', 'Hooks')}
          {rows.length === 0 && <Text dimColor>hooks.json recorded no hooks.</Text>}
          {rows.map(r => (
            <Box key={`dd-p-${r.name}`} flexDirection="column">
              <Text wrap="truncate-end" color={r.isFailed ? 'red' : undefined} dimColor={!r.ran}>
                {r.isFailed ? '◆ ' : '  '}
                {r.name.padEnd(8)} {r.bar} {r.ms}
              </Text>
              {r.isFailed && r.error !== undefined && (
                <Text wrap="wrap" color="red">
                  {'    '}
                  {excerpt(r.error, 400)}
                </Text>
              )}
              {r.calls.length > 0 && (
                <Text wrap="wrap" dimColor>
                  {'    '}saw {r.calls.join(', ')}
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )
    },

    cost: () => {
      const now = costLine(e)
      const before = props.costBefore === undefined ? '' : costLine(props.costBefore)

      return (
        <Box key="dd-cost" flexDirection="column">
          {heading('dd-cost-h', 'Cost')}
          <Text wrap="wrap">
            {now || 'not recorded'}
            {before !== '' && <Text dimColor> · run before: {before}</Text>}
          </Text>
        </Box>
      )
    },
  }

  return (
    <Box flexDirection="column">
      {header}
      {props.sections.map(s => sections[s]() as never)}
      <Box key="dd-actions" flexDirection="row" gap={1} flexWrap="wrap">
        {props.actions.map(a => (
          <Button key={`dd-${a.id}`} label={a.label} hotkey={a.hotkey} {...(a.isPrimary === true && { variant: 'primary' as const })} onPress={() => props.onAction(a.id)} />
        ))}
        {back}
      </Box>
    </Box>
  )
}
