import type { El } from './kit'

/** The Scenarios tab: filter, select, run selected, detail, flaky checks, generate. Owned by the scenarios-tab feature. */
export function ScenariosTab(props: { el: El }) {
  const { Text } = props.el

  return <Text dimColor>Scenarios arrive here.</Text>
}
