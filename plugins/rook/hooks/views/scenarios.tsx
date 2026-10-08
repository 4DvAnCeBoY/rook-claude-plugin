import type { RookScenarioRow, RookStatus } from '../../types'
import { FILTERS, isFlaky } from '../scenarios'
import type { ScenarioView } from '../scenarios'
import type { El } from './kit'

/** The open scenario: its file, its newest verdict when it has one, and where that verdict lies. */
export type ScenarioDetail = { scenario: ScenarioView; row?: RookScenarioRow; verdictPath?: string }

export type ScenariosTabProps = {
  el: El
  /** The scenarios the filter lets through. */
  rows: ScenarioView[]
  total: number
  filter: string
  selected: string[]
  flaky: Record<string, RookStatus[]>
  /** Each checked scenario's verdict from before its flaky check. */
  flakyPrior?: Record<string, RookStatus>
  detail: ScenarioDetail | undefined
  draft: string
  /** Nothing in flight and the checklist allows a run. */
  canRun: boolean
  /** Credits per scenario at the latest run's rate. */
  rate: number | undefined
  width: number
  onFilter: (filter: string) => void
  onToggle: (id: string) => void
  onOpen: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
  onRunSelected: () => void
  onCurate: (verb: 'exclude' | 'include') => void
  onFix: (id: string) => void
  onRegression: (id: string) => void
  onFlaky: (id: string) => void
  onDraft: (text: string) => void
  onGenerate: (text?: string) => void
}

const MAX_ROWS = 60

/** Each filter's key in the pane: digits past the tabs' 1-5, then j. */
export const FILTER_KEYS: Record<string, string> = { all: '0', failing: '6', unverifiable: '7', never: '8', functional: '9', adversarial: 'j' }

/** The tab's own actions' keys: r runs (as Run all does elsewhere), the rest from the letters no other feature takes. */
export const SCENARIO_KEYS = { selectAll: 'h', clear: 'z', runSelected: 'r', exclude: 'q', include: 'u', generate: 'i' } as const

const mark = (status: RookStatus | undefined): { icon: string; color?: string } =>
  status === 'Pass' ? { icon: '✓', color: 'green' } : status === 'Fail' ? { icon: '✗', color: 'red' } : status === 'Unable to Verify' ? { icon: '?', color: 'yellow' } : { icon: '·' }

const clipped = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`)

/** A flaky check's verdicts with the one from before it, which counts toward the judgement. */
const withPrior = (verdicts: RookStatus[] | undefined, prior: RookStatus | undefined): RookStatus[] | undefined =>
  prior === undefined || verdicts === undefined || verdicts.length === 0 ? verdicts : [prior, ...verdicts]

/** The Scenarios tab: filter, select, run selected, detail, flaky checks, generate. Owned by the scenarios-tab feature. */
export function ScenariosTab(props: ScenariosTabProps) {
  const { Box, Text, Button } = props.el
  const Input = props.el.Input
  const { rows, selected, flaky, detail } = props
  const credits = props.rate === undefined || selected.length === 0 ? '' : ` · ~${Math.round(props.rate * selected.length * 100) / 100} credits`

  const detailView = (d: ScenarioDetail) => {
    const s = d.scenario
    const verdicts = flaky[s.id]

    return (
      <Box key={`scd-${s.id}`} flexDirection="column" paddingLeft={2}>
        {s.description !== undefined && <Text wrap="wrap">{clipped(s.description, 600)}</Text>}
        {s.why !== undefined && (
          <Text dimColor wrap="wrap">
            why: {clipped(s.why, 400)}
          </Text>
        )}
        {s.criteria.length > 0 && <Text bold>Criteria</Text>}
        {s.criteria.slice(0, 10).map((c, at) => (
          <Text key={`scd-${s.id}-c${at}`} wrap="wrap">
            · {clipped(c, 300)}
          </Text>
        ))}
        <Text color={mark(s.status).color} wrap="truncate-end">
          {s.status === undefined ? 'never run' : `latest: ${s.status} · run ${s.runId ?? '?'}`}
        </Text>
        {d.row?.failing.slice(0, 6).map(c => (
          <Box key={`scd-${s.id}-${c.id}`} flexDirection="column">
            <Text wrap="wrap">
              <Text bold>{c.id}</Text> {clipped(c.criterion, 300)}
            </Text>
            <Text wrap="wrap">
              <Text color="green">expected </Text>
              {clipped(c.expected, 400)}
            </Text>
            <Text wrap="wrap">
              <Text color="red">achieved </Text>
              {clipped(c.achieved, 400)}
            </Text>
          </Box>
        ))}
        {d.row !== undefined && d.row.failing.length === 0 && d.row.summary !== '' && <Text wrap="wrap">{clipped(d.row.summary, 400)}</Text>}
        {d.verdictPath !== undefined && (
          <Text dimColor wrap="truncate-end">
            verdict: {d.verdictPath}
          </Text>
        )}
        {verdicts !== undefined && verdicts.length > 0 && (
          <Text color={isFlaky(verdicts) ? 'yellow' : undefined} wrap="wrap">
            flaky check: {props.flakyPrior?.[s.id] === undefined ? '' : `earlier ${props.flakyPrior[s.id]}, then `}
            {verdicts.join(', ')}
            {isFlaky(withPrior(verdicts, props.flakyPrior?.[s.id])) ? ' · flaky' : ''}
          </Text>
        )}
        <Box flexDirection="row" gap={1}>
          {s.status === 'Fail' && <Button key={`fix-sc-${s.id}`} label="Fix this with Claude" variant="primary" onPress={() => props.onFix(s.id)} />}
          {s.status === 'Fail' && <Button key={`regress-${s.id}`} label="Turn into regression test" onPress={() => props.onRegression(s.id)} />}
          {props.canRun && !s.excluded && <Button key={`flaky-${s.id}`} label="Re-run 3×" onPress={() => props.onFlaky(s.id)} />}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {FILTERS.map(f =>
          f.id === props.filter ? (
            <Text key={`filter-${f.id}`} bold underline>
              {FILTER_KEYS[f.id]}: {f.label}
            </Text>
          ) : (
            <Button key={`filter-${f.id}`} plain label={f.label} hotkey={FILTER_KEYS[f.id]} onPress={() => props.onFilter(f.id)} />
          ),
        )}
      </Box>
      <Text dimColor>
        {rows.length} of {props.total} shown · {selected.length} selected
      </Text>
      {props.total === 0 && <Text dimColor>No scenarios yet. Describe what to cover below and press Generate.</Text>}
      {rows.slice(0, MAX_ROWS).flatMap(s => {
        const m = mark(s.status)
        const verdicts = flaky[s.id]
        const tags = [s.featureId, [s.class, s.category].filter(Boolean).join('/') || undefined, s.excluded ? 'excluded' : undefined, isFlaky(withPrior(verdicts, props.flakyPrior?.[s.id])) ? 'flaky' : undefined]
          .filter(Boolean)
          .join(' · ')
        const isOpen = detail?.scenario.id === s.id

        return [
          <Box key={`scr-${s.id}`} flexDirection="row" gap={1}>
            <Button key={`sel-${s.id}`} plain label={`${selected.includes(s.id) ? '☑' : '☐'} ${s.id}`} onPress={() => props.onToggle(s.id)} />
            <Text color={m.color}>{m.icon}</Text>
            <Button
              key={`sc-${s.id}`}
              plain
              label={`${isOpen ? '▾' : '▸'} ${clipped(s.title || s.id, Math.max(20, props.width - 16 - tags.length))}${tags ? ` · ${tags}` : ''}`}
              onPress={() => props.onOpen(s.id)}
            />
          </Box>,
          ...(isOpen && detail !== undefined ? [detailView(detail)] : []),
        ]
      })}
      {rows.length > MAX_ROWS && <Text dimColor>… {rows.length - MAX_ROWS} more: narrow the filter.</Text>}
      <Box flexDirection="row" gap={1}>
        {/* The focus ring starts on Select all, on Run selected once something is ticked. */}
        {rows.length > 0 && (
          <Button key="select-all" label="Select all shown" hotkey={SCENARIO_KEYS.selectAll} {...(selected.length === 0 && { autoFocus: true as const })} onPress={props.onSelectAll} />
        )}
        {selected.length > 0 && <Button key="select-clear" label="Clear" hotkey={SCENARIO_KEYS.clear} onPress={props.onClear} />}
        {props.canRun && selected.length > 0 && (
          <Button
            key="run-selected"
            label={`Run selected (${selected.length})${credits}`}
            variant="primary"
            hotkey={SCENARIO_KEYS.runSelected}
            autoFocus
            onPress={props.onRunSelected}
          />
        )}
        {selected.length > 0 && <Button key="exclude-selected" label="Exclude selected" hotkey={SCENARIO_KEYS.exclude} onPress={() => props.onCurate('exclude')} />}
        {selected.length > 0 && <Button key="include-selected" label="Include selected" hotkey={SCENARIO_KEYS.include} onPress={() => props.onCurate('include')} />}
      </Box>
      <Text bold>Generate</Text>
      <Box flexDirection="row" gap={1}>
        {Input !== undefined && (
          <Input
            key="gen-draft"
            placeholder="what the new scenarios should cover"
            value={props.draft}
            submitLabel="generate"
            onInput={text => props.onDraft(text)}
            onSubmit={text => props.onGenerate(text)}
          />
        )}
        <Button key="generate" label="Generate" hotkey={SCENARIO_KEYS.generate} onPress={() => props.onGenerate()} />
      </Box>
    </Box>
  )
}
