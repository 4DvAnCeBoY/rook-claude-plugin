import type { Io } from './workspace'

/** Directories never worth walking for an agent's sources. */
const SKIP = new Set(['node_modules', '.git', '.testmuai', 'dist', 'build', '.venv', '__pycache__'])
const MAX_FILES = 2000
const MAX_DEPTH = 6

/**
 * Each tracked file's modification time, keyed by its path relative to the
 * workspace. `agent.yaml` → `source.tracks` names files and directories; a
 * directory is walked (skipping dependency and build folders, capped), so an
 * edit anywhere under it is seen. Lets the re-test band notice edits made
 * through the shell, an editor or another terminal, not only Claude's Edit tool.
 */
export async function sourceStamps(io: Io, tracks: readonly string[]): Promise<Map<string, number>> {
  const stamps = new Map<string, number>()

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || stamps.size >= MAX_FILES) {
      return
    }

    for (const entry of await io.list(dir)) {
      if (stamps.size >= MAX_FILES) {
        return
      }

      const path = dir === '' ? entry.name : `${dir}/${entry.name}`

      if (entry.kind === 'dir') {
        if (!SKIP.has(entry.name)) {
          await walk(path, depth + 1)
        }
      } else if (entry.kind === 'file') {
        stamps.set(path, entry.mtimeMs ?? 0)
      }
    }
  }

  for (const track of new Set(tracks.map(t => t.replace(/^\.\//, '').replace(/\/$/, '')))) {
    if (track === '' || track.startsWith('/') || track.split('/').includes('..')) {
      continue
    }

    // A directory lists its children; a file is found in its parent's listing.
    if ((await io.list(track)).length > 0) {
      await walk(track, 1)
      continue
    }

    const slash = track.lastIndexOf('/')
    const entry = (await io.list(slash < 0 ? '' : track.slice(0, slash))).find(e => e.name === track.slice(slash + 1))

    if (entry?.kind === 'file') {
      stamps.set(track, entry.mtimeMs ?? 0)
    }
  }

  return stamps
}

/** Files that are new or whose modification time moved between two stamp sets. */
export function changedSources(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): string[] {
  return [...after].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path)
}
