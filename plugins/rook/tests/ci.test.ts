import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseCiArgs, previewText, secretsOf, WORKFLOW_PATH, workflowYaml } from '../hooks/ci'
import { isMap, list, parseYaml } from '../hooks/yaml'
import type { YamlMap, YamlValue } from '../hooks/yaml'
import { command, SESSION, worldOf } from './fixtures/world'
import type { World } from './fixtures/world'
import { AGENT_DIR, CWD, HOME, workspace } from './fixtures/workspace'

const SHA = '5be0db96c7616cb592c4b5cd2adb0f68b141ddcd'
const SECRET_VALUE = 'sk-live-do-not-leak-0042'

type Ran = { result?: unknown; deny?: string; text?: string }

const map = (value: YamlValue | undefined): YamlMap => {
  expect(isMap(value)).toBe(true)

  return value as YamlMap
}

const stepsOf = (yaml: string) => list(map(map(map(parseYaml(yaml)).jobs).rook).steps).map(map)

/** A session over the workspace fixture, with `$.fs.write` and `$.fs.exists` kept in the same file map. */
async function start($: Engine, on: Parameters<typeof worldOf>[0], files: Record<string, string>) {
  const rel = (path: string) => (path.startsWith(`${CWD}/`) ? path.slice(CWD.length + 1) : path)
  const writes: string[] = []

  on('fs.write', ($, e) => {
    writes.push(rel(e.path))
    world.files.set(rel(e.path), e.text)

    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: world.files.has(rel(e.path)) }))

  const world: World = worldOf(on, files)

  world.version = { stdout: `${SHA}\n`, code: 0 }
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start(SESSION)

  return { world, writes }
}

/** The workspace, with a value for one of the profile's variables stored where `rook env set` keeps it. */
const withStoredValue = () =>
  workspace({ [`${HOME}/.testmuai/rook/env.json`]: JSON.stringify({ projects: { [CWD]: { DEMO_API_TOKEN: SECRET_VALUE } } }) })

describe('ci · the workflow', () => {
  const plan = { profileId: 'commerce-http', variables: ['COMMERCE_BASE_URL', 'DEMO_API_TOKEN'], version: SHA }

  test('parses as YAML: pull_request trigger, install, sign-in, run, upload, verdicts', () => {
    const yaml = workflowYaml(plan)
    const doc = map(parseYaml(yaml))
    const on = map(doc.on)

    expect(doc.name).toBe('rook')
    expect('pull_request' in on).toBe(true)
    expect(map(map(map(on.workflow_dispatch).inputs).ROOK_ONLY).required).toBe(false)

    const steps = stepsOf(yaml)
    const named = (name: string) => steps.find(step => step.name === name)!

    expect(steps.map(step => step.name ?? step.uses)).toEqual([
      'actions/checkout@v4',
      'actions/setup-node@v4',
      'Install rook',
      'Sign in to rook',
      'Run rook',
      'Find the run folder',
      'Upload the run',
      'Verdicts',
    ])
    expect(map(named('Install rook').env).ROOK_GITHUB_TOKEN).toBe('${{ secrets.ROOK_GITHUB_TOKEN }}')
    expect(map(named('Install rook').env).ROOK_VERSION).toBe(`\${{ vars.ROOK_VERSION || '${SHA}' }}`)
    expect(map(named('Sign in to rook').env).ROOK_AUTH).toBe('${{ secrets.ROOK_AUTH }}')
    expect(String(named('Run rook').run)).toContain("rook run --test --json --yes --profile 'commerce-http' \"${select[@]}\" > rook-run.json")
    expect(String(named('Run rook').run)).toContain('select=(--class functional)')
    expect(String(named('Run rook').run)).toContain('select=(--only "$ROOK_ONLY")')
    expect(named('Upload the run').uses).toBe('actions/upload-artifact@v4')
    expect(String(map(named('Upload the run').with).path)).toContain('${{ steps.folder.outputs.dir }}')
    expect(String(named('Verdicts').run)).toContain('.report.totals.failed')
  })

  test('sets each declared variable from a secret of the same name, and never a value', () => {
    const yaml = workflowYaml(plan)
    const runEnv = map(stepsOf(yaml).find(step => step.name === 'Run rook')!.env)

    expect(runEnv).toEqual({ COMMERCE_BASE_URL: '${{ secrets.COMMERCE_BASE_URL }}', DEMO_API_TOKEN: '${{ secrets.DEMO_API_TOKEN }}' })
    // every `${{ secrets.X }}` names a secret the preview lists, and nothing else is a secret
    const referenced = [...yaml.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1])
    expect([...new Set(referenced)].sort()).toEqual(secretsOf(plan).map(secret => secret.name).sort())
  })

  test('Fail fails the job; Unable to Verify only with the flag', () => {
    const lenient = map(map(map(map(parseYaml(workflowYaml(plan))).jobs).rook).env)
    const strict = map(map(map(map(parseYaml(workflowYaml({ ...plan, failOnUnverifiable: true }))).jobs).rook).env)

    expect(lenient.ROOK_FAIL_ON_UNVERIFIABLE).toBe("${{ vars.ROOK_FAIL_ON_UNVERIFIABLE || 'false' }}")
    expect(strict.ROOK_FAIL_ON_UNVERIFIABLE).toBe("${{ vars.ROOK_FAIL_ON_UNVERIFIABLE || 'true' }}")
  })

  test('a comment explains each secret', () => {
    const yaml = workflowYaml(plan)

    for (const name of ['ROOK_GITHUB_TOKEN', 'ROOK_AUTH']) {
      expect(yaml).toMatch(new RegExp(`# Secret ${name}:`))
    }
    expect(yaml).toContain('# The variables profile commerce-http declares, one repository secret each')
  })

  test('allow rules replace --yes; unsafe ones, GitHub-reserved names and a bad version are left out', () => {
    const yaml = workflowYaml({ ...plan, variables: ['GITHUB_TOKEN', 'OK_VAR'], version: 'rook 0.1.0', allowRules: ['bash(npm test)', "bash(rm '-rf')"] })

    expect(yaml).toContain("rook run --test --json --allow 'bash(npm test)' --profile")
    expect(yaml).not.toContain('rm ')
    expect(yaml).not.toContain('secrets.GITHUB_TOKEN')
    expect(yaml).toContain('OK_VAR: ${{ secrets.OK_VAR }}')
    expect(yaml).toContain('ROOK_VERSION: ${{ vars.ROOK_VERSION }}')
    expect(previewText({ ...plan, variables: ['GITHUB_TOKEN'] }, yaml, false)).toContain('Not usable as secret names (rename them in the profile): GITHUB_TOKEN')
  })

  test('arguments', () => {
    expect(parseCiArgs([])).toEqual({ write: false, force: false, failOnUnverifiable: false })
    expect(parseCiArgs(['write', '--force', '--strict'])).toEqual({ write: true, force: true, failOnUnverifiable: true })
    expect(parseCiArgs(['--force'])).toEqual({ error: '--force goes with write: /rook ci write --force' })
    expect('error' in parseCiArgs(['wrte'])).toBe(true)
  })
})

describe('ci · /rook ci and the ci tool', () => {
  test('/rook ci previews the path, the secret names and the YAML, and writes nothing', async ($, on) => {
    const { world, writes } = await start($, on, withStoredValue())
    const ran = (await $.command.run(command('ci'))) as Ran
    const text = ran.text ?? ''

    expect(text).toContain(`${WORKFLOW_PATH} is not written yet; /rook ci write writes it.`)
    for (const name of ['ROOK_GITHUB_TOKEN', 'ROOK_AUTH', 'COMMERCE_BASE_URL', 'DEMO_API_TOKEN']) {
      expect(text).toContain(`gh secret set ${name}`)
    }
    expect(text).toContain('```yaml\n# rook: run the agent')
    expect(text).toContain(`ROOK_VERSION: \${{ vars.ROOK_VERSION || '${SHA}' }}`)
    expect(text).not.toContain(SECRET_VALUE)
    expect(writes).toEqual([])
    expect(world.files.has(WORKFLOW_PATH)).toBe(false)
  })

  test('/rook ci write writes the workflow; the file holds names and no value', async ($, on) => {
    const { world, writes } = await start($, on, withStoredValue())
    const ran = (await $.command.run(command('ci write'))) as Ran

    expect(writes).toEqual([WORKFLOW_PATH])
    expect(ran.text).toContain(`wrote ${WORKFLOW_PATH}`)
    expect(ran.text).toContain('gh secret set DEMO_API_TOKEN')

    const yaml = world.files.get(WORKFLOW_PATH)!

    expect(yaml).toContain('DEMO_API_TOKEN: ${{ secrets.DEMO_API_TOKEN }}')
    expect(yaml).not.toContain(SECRET_VALUE)
    expect(stepsOf(yaml).length).toBe(8)
  })

  test('refuses to overwrite an existing workflow unless --force', async ($, on) => {
    const { world, writes } = await start($, on, { ...workspace(), [WORKFLOW_PATH]: 'name: mine\n' })

    const preview = (await $.command.run(command('ci'))) as Ran
    expect(preview.text).toContain('exists already; /rook ci write --force replaces it.')

    const refused = (await $.command.run(command('ci write'))) as Ran
    expect(refused.text).toContain('exists already and was left as it is')
    expect(world.files.get(WORKFLOW_PATH)).toBe('name: mine\n')
    expect(writes).toEqual([])

    await $.command.run(command('ci write --force'))
    expect(writes).toEqual([WORKFLOW_PATH])
    expect(world.files.get(WORKFLOW_PATH)).toContain('name: rook')
  })

  test('--strict makes Unable to Verify fail the check', async ($, on) => {
    const { world } = await start($, on, workspace())

    await $.command.run(command('ci write --strict'))
    expect(world.files.get(WORKFLOW_PATH)).toContain("ROOK_FAIL_ON_UNVERIFIABLE: ${{ vars.ROOK_FAIL_ON_UNVERIFIABLE || 'true' }}")
  })

  test('bad arguments and no workspace are refused', async ($, on) => {
    const bad = await start($, on, workspace())
    expect(((await $.command.run(command('ci --force'))) as Ran).text).toContain('--force goes with write')
    expect(bad.writes).toEqual([])
  })

  test('outside a workspace there is nothing to write', async ($, on) => {
    const { writes } = await start($, on, { 'README.md': '# hi' })

    expect(((await $.command.run(command('ci write'))) as Ran).text).toContain('no rook workspace here')
    expect(writes).toEqual([])
  })

  test('the ci tool previews, writes, and refuses to overwrite without force', async ($, on) => {
    const { world, writes } = await start($, on, withStoredValue())

    const preview = (await $.tool.call({ tool: 'mcp__rook__ci' } as never)) as Ran
    expect(String(preview.result)).toContain('ROOK_AUTH')
    expect(writes).toEqual([])

    const written = (await $.tool.call({ tool: 'mcp__rook__ci', write: true } as never)) as Ran
    expect(String(written.result)).toContain(`wrote ${WORKFLOW_PATH}`)
    expect(world.files.get(WORKFLOW_PATH)).not.toContain(SECRET_VALUE)

    const again = (await $.tool.call({ tool: 'mcp__rook__ci', write: true, fail_on_unverifiable: true } as never)) as Ran
    expect(String(again.result)).toContain('exists already')
    expect(world.files.get(WORKFLOW_PATH)).toContain("|| 'false' }}")

    await $.tool.call({ tool: 'mcp__rook__ci', write: true, force: true, fail_on_unverifiable: true } as never)
    expect(world.files.get(WORKFLOW_PATH)).toContain("|| 'true' }}")
    expect(writes).toEqual([WORKFLOW_PATH, WORKFLOW_PATH])
  })

  test('the profile in use is the active one, read from the agent', async ($, on) => {
    const { world } = await start($, on, workspace({ [`${AGENT_DIR}/profiles/active`]: 'other\n', [`${AGENT_DIR}/profiles/other.yaml`]: 'id: other\nenv:\n  - variable: OTHER_KEY\n' }))

    await $.command.run(command('ci write'))
    const yaml = world.files.get(WORKFLOW_PATH)!

    expect(yaml).toContain("--profile 'other'")
    expect(yaml).toContain('OTHER_KEY: ${{ secrets.OTHER_KEY }}')
    expect(yaml).not.toContain('DEMO_API_TOKEN')
  })
})
