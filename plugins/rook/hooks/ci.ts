/**
 * `/rook ci`: the local loop as a pull-request check.
 *
 * Pure: a plan in, a GitHub Actions workflow and its preview out. What rook
 * build 5be0db96 does headless, and what the workflow leans on:
 *
 * - No token variable and no `rook login --token`. Sign-in lives in
 *   `$ROOK_HOME/profiles/<profile>/<env>/` (credentials, client.json,
 *   identity.json), and `ROOK_HOME` exists for "a CI job with its own
 *   credentials" (README). So the job unpacks a signed-in `profiles/` tree
 *   from one secret.
 * - A runner variable (`CI`, `GITHUB_ACTIONS`) makes every command headless:
 *   nobody can be asked, so tool calls are approved up front (`--yes` or
 *   `--allow`), as the plugin does.
 * - `rook run --json` exits 1 only when its document says `ok: false` (rook
 *   could not test the agent). Fail verdicts exit 0 in this build, so the job
 *   reads `.report.totals` rather than the exit code.
 * - Install is the public npm package `@testmuai/rook`, pinned to the local
 *   version when it is a semver, else `latest`; `ROOK_VERSION` overrides.
 * - A profile's declared variables are read from the process environment, so
 *   each one is a repository secret set on the run step.
 *
 * Only names ever go into the workflow; a value never does.
 */

export const WORKFLOW_PATH = '.github/workflows/rook.yml'

const NPM_PACKAGE = '@testmuai/rook'
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
const PROFILE_ID = /^[\w.][\w.-]{0,63}$/
const SAFE_RULE = /^[\w.@*:/()\s,=-]{1,200}$/

/** The secrets the workflow itself needs, before the profile's own. */
export const BASE_SECRETS = [
  {
    name: 'ROOK_AUTH',
    purpose: "rook's sign-in for the job, a base64 tarball of a signed-in ROOK_HOME's profiles/ folder",
    how: 'ROOK_HOME=~/.rook-ci rook login && tar -czf - -C ~/.rook-ci profiles | base64 | gh secret set ROOK_AUTH',
  },
] as const

export type CiPlan = {
  /** The profile the job calls through; absent when the agent has no active one. */
  profileId?: string
  /** The variables that profile declares, names only. */
  variables: readonly string[]
  /** The installed rook's version, pinned when it is an npm semver so CI runs what the person tested with. */
  version?: string
  /** `allowRules` from /config: when set, they replace `--yes`. */
  allowRules?: readonly string[]
  /** Fail the job on Unable to Verify too, not only on Fail. */
  failOnUnverifiable?: boolean
}

export type CiRequest = { write: boolean; force: boolean; failOnUnverifiable: boolean }

export type Secret = { name: string; purpose: string; how: string }

/** `/rook ci [write] [--force] [--strict]`. */
export function parseCiArgs(args: readonly string[]): CiRequest | { error: string } {
  const request: CiRequest = { write: false, force: false, failOnUnverifiable: false }

  for (const word of args) {
    if (word === 'write') {
      request.write = true
    } else if (word === '--force') {
      request.force = true
    } else if (word === '--strict') {
      request.failOnUnverifiable = true
    } else if (word !== 'preview') {
      return { error: `/rook ci [write] [--force] [--strict]: "${word.slice(0, 40)}" is not one of them` }
    }
  }

  return request.force && !request.write ? { error: '--force goes with write: /rook ci write --force' } : request
}

/** The profile's variables that can be repository secrets, and the ones that cannot. */
export function variablesOf(plan: CiPlan): { usable: string[]; unusable: string[] } {
  const reserved = new Set<string>(BASE_SECRETS.map(secret => secret.name))
  const names = [...new Set(plan.variables)]
  const usable = names.filter(name => SECRET_NAME.test(name) && !/^GITHUB_/i.test(name) && !reserved.has(name))

  return { usable, unusable: names.filter(name => !usable.includes(name)) }
}

/** Every secret the person must add: rook's own, then the profile's. */
export function secretsOf(plan: CiPlan): Secret[] {
  return [
    ...BASE_SECRETS,
    ...variablesOf(plan).usable.map(name => ({
      name,
      purpose: `declared by profile ${plan.profileId ?? '(active)'}: the agent's scripts read it`,
      how: `gh secret set ${name}`,
    })),
  ]
}

/** `--yes`, or the person's `--allow` rules, single-quoted for the shell. */
function approvalOf(plan: CiPlan): string {
  const rules = (plan.allowRules ?? []).filter(rule => SAFE_RULE.test(rule) && !rule.includes("'"))

  return rules.length === 0 ? '--yes' : rules.map(rule => `--allow '${rule}'`).join(' ')
}

/** The workflow, in the YAML subset `hooks/yaml.ts` reads back. */
export function workflowYaml(plan: CiPlan): string {
  const { usable } = variablesOf(plan)
  const profile = plan.profileId !== undefined && PROFILE_ID.test(plan.profileId) ? plan.profileId : undefined
  const version = plan.version !== undefined && SEMVER.test(plan.version) ? plan.version : undefined
  const runLine = ['rook run --test --json', approvalOf(plan), ...(profile === undefined ? [] : [`--profile '${profile}'`]), '"${select[@]}" > rook-run.json'].join(' ')

  const lines = [
    '# rook: run the agent\'s scenarios on every pull request and fail the check on a Fail verdict.',
    '# Written by /rook ci. Unable to Verify is reported but does not fail the job unless',
    '# ROOK_FAIL_ON_UNVERIFIABLE is true (a repository variable overrides the default below).',
    '#',
    '# The job runs what the repository holds: commit .testmuai/rook/ (settings.json, the',
    '# project, the agent, its scenarios and profiles). Runs spend rook credits and call the',
    '# real agent, so point the profile at staging.',
    '#',
    '# Secrets are not passed to pull requests from forks: on those the job stops at sign-in.',
    'name: rook',
    'on:',
    '  pull_request:',
    '  workflow_dispatch:',
    '    inputs:',
    '      ROOK_ONLY:',
    '        description: Scenario ids to run, e.g. SC-001,SC-002. Empty runs the functional class.',
    '        required: false',
    "        default: ''",
    'permissions:',
    '  contents: read',
    'concurrency:',
    '  group: rook-${{ github.event.pull_request.number || github.ref }}',
    '  cancel-in-progress: true',
    'jobs:',
    '  rook:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 60',
    '    env:',
    '      # Which scenarios run: the dispatch input, else the ROOK_ONLY repository variable,',
    '      # else every functional scenario.',
    '      ROOK_ONLY: ${{ inputs.ROOK_ONLY || vars.ROOK_ONLY }}',
    `      ROOK_FAIL_ON_UNVERIFIABLE: \${{ vars.ROOK_FAIL_ON_UNVERIFIABLE || '${plan.failOnUnverifiable === true ? 'true' : 'false'}' }}`,
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '22'",
    '      - name: Install rook',
    '        env:',
    `          # The rook version to install from npm: ${version === undefined ? 'the latest' : 'the one /rook ci saw'}, unless the ROOK_VERSION variable says otherwise.`,
    `          ROOK_VERSION: \${{ vars.ROOK_VERSION || '${version ?? 'latest'}' }}`,
    '        run: |',
    `          npm install -g "${NPM_PACKAGE}@$ROOK_VERSION"`,
    '          rook --version',
    '      - name: Sign in to rook',
    '        env:',
    "          # Secret ROOK_AUTH: rook's sign-in, a base64 tarball of a ROOK_HOME's profiles/ folder.",
    '          # Make it from a home kept for CI, so your own terminal never refreshes its token:',
    '          #   ROOK_HOME=~/.rook-ci rook login',
    '          #   tar -czf - -C ~/.rook-ci profiles | base64 | gh secret set ROOK_AUTH',
    '          ROOK_AUTH: ${{ secrets.ROOK_AUTH }}',
    '        run: |',
    '          mkdir -p "$HOME/.testmuai/rook"',
    '          printf \'%s\' "$ROOK_AUTH" | base64 -d | tar -xz -C "$HOME/.testmuai/rook"',
    '          rook auth status',
    '      - name: Run rook',
    '        id: run',
    ...(usable.length === 0
      ? []
      : [
          '        env:',
          `          # The variables profile ${profile ?? '(active)'} declares, one repository secret each`,
          '          # (gh secret set NAME). rook refuses to start when one is missing.',
          ...usable.map(name => `          ${name}: \${{ secrets.${name} }}`),
        ]),
    '        run: |',
    '          if [ -n "$ROOK_ONLY" ]; then',
    '            if ! printf \'%s\' "$ROOK_ONLY" | grep -Eq \'^SC-[0-9]+(,SC-[0-9]+)*$\'; then',
    '              echo "::error::ROOK_ONLY must be scenario ids, e.g. SC-001,SC-002"',
    '              exit 1',
    '            fi',
    '            select=(--only "$ROOK_ONLY")',
    '          else',
    '            select=(--class functional)',
    '          fi',
    '          set +e',
    `          ${runLine}`,
    '          echo "exit=$?" >> "$GITHUB_OUTPUT"',
    '          exit 0',
    '      - name: Find the run folder',
    '        id: folder',
    '        if: always()',
    '        run: |',
    "          run_id=$(jq -r '.run_id // empty' rook-run.json 2>/dev/null)",
    '          if [ -n "$run_id" ]; then',
    '            dir=$(find .testmuai/rook -type d -path "*/runs/$run_id" -print -quit)',
    '            echo "dir=$dir" >> "$GITHUB_OUTPUT"',
    '          fi',
    '      - name: Upload the run',
    '        if: always()',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: rook-run',
    '          if-no-files-found: warn',
    '          path: |',
    '            rook-run.json',
    '            ${{ steps.folder.outputs.dir }}',
    '      - name: Verdicts',
    '        if: always()',
    '        env:',
    '          ROOK_EXIT: ${{ steps.run.outputs.exit }}',
    '        run: |',
    '          if [ ! -s rook-run.json ]; then',
    '            echo "::error::rook printed no document (exit $ROOK_EXIT)"',
    '            exit 1',
    '          fi',
    "          if [ \"$(jq -r '.ok' rook-run.json)\" != \"true\" ]; then",
    "            echo \"::error::rook could not test the agent: $(jq -r '.error // .reason // \"no reason given\"' rook-run.json)\"",
    '            exit 1',
    '          fi',
    "          passed=$(jq -r '.report.totals.passed // 0' rook-run.json)",
    "          failed=$(jq -r '.report.totals.failed // 0' rook-run.json)",
    "          unverifiable=$(jq -r '.report.totals.unverifiable // 0' rook-run.json)",
    '          echo "rook: $passed Pass, $failed Fail, $unverifiable Unable to Verify" >> "$GITHUB_STEP_SUMMARY"',
    "          if [ \"$(jq -r '.halted' rook-run.json)\" = \"true\" ]; then",
    "            echo \"::warning::the run stopped early: $(jq -r '.reason // \"no reason given\"' rook-run.json)\"",
    '          fi',
    '          if [ "$failed" -gt 0 ]; then',
    '            echo "::error::$failed scenario(s) failed. The run folder is in the rook-run artifact."',
    '            exit 1',
    '          fi',
    '          if [ "$unverifiable" -gt 0 ]; then',
    '            if [ "$ROOK_FAIL_ON_UNVERIFIABLE" = "true" ]; then',
    '              echo "::error::$unverifiable scenario(s) could not be verified"',
    '              exit 1',
    '            fi',
    '            echo "::warning::$unverifiable scenario(s) could not be verified: reported, not failed"',
    '          fi',
  ]

  return `${lines.join('\n')}\n`
}

/** What `/rook ci` shows before anything is written. */
export function previewText(plan: CiPlan, yaml: string, exists: boolean): string {
  const secrets = secretsOf(plan)
  const width = Math.max(...secrets.map(secret => secret.name.length))
  const { unusable } = variablesOf(plan)

  return [
    `rook ci: ${WORKFLOW_PATH} ${exists ? 'exists already; /rook ci write --force replaces it.' : 'is not written yet; /rook ci write writes it.'}`,
    '',
    'Secrets to add (repository Settings → Secrets and variables → Actions), names only:',
    ...secrets.map(secret => `  ${secret.name.padEnd(width)}  ${secret.purpose}\n  ${' '.repeat(width)}  ${secret.how}`),
    ...(plan.profileId === undefined ? ['', 'The agent has no active profile, so the job cannot reach it yet: add one (! rook profile add …) and run /rook ci again.'] : []),
    ...(unusable.length === 0 ? [] : ['', `Not usable as secret names (rename them in the profile): ${unusable.join(', ')}`]),
    '',
    'Commit .testmuai/rook/ (settings, project, agent, scenarios, profiles): the job runs what the repository holds.',
    `Fail verdicts fail the check; Unable to Verify ${plan.failOnUnverifiable === true ? 'fails it too (--strict)' : 'is reported only (--strict, or the ROOK_FAIL_ON_UNVERIFIABLE variable, fails it too)'}.`,
    '',
    '```yaml',
    yaml.trimEnd(),
    '```',
  ].join('\n')
}

/** What `/rook ci write` says once the file is on disk. */
export function writtenText(plan: CiPlan): string {
  return [
    `rook ci: wrote ${WORKFLOW_PATH}. Add these repository secrets before the first pull request:`,
    ...secretsOf(plan).map(secret => `  ${secret.how}`),
    'Then commit the workflow with .testmuai/rook/.',
  ].join('\n')
}
