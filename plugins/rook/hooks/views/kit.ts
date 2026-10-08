import type { Elements } from 'claude-code'

/**
 * The elements a pane view draws with, handed down from the render hook's
 * `$.ui.resolve(e)`. Views never take `$`: the engine follows `$` only into
 * functions declared in register.tsx, so every action a view offers arrives
 * as a callback built there.
 */
export type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link' | 'Code' | 'Markdown'> &
  Partial<Pick<Elements['terminal'], 'Input' | 'Select'>>
