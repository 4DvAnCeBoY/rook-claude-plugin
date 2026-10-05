# rook for Claude Code

**Claude builds your agent. rook tests it. Same terminal.**

A Claude Code mod for [rook](https://github.com/LambdaTest/rook), TestMu AI's agent-assurance CLI. It puts rook's verdicts where your agent is being written. Claude can run the scenarios, read rook's evidence and fix what failed, and you watch it happen in a live pane.

> **New here?** Watch the [walkthrough video](../../docs/media/rook-plugin-walkthrough.mp4) and read [Getting started](../../docs/getting-started.md): one path for a repository with no rook tests, one for a repository that has them.

> Status: early access, like Claude Code's function-hooks API it is built on. Requires Claude Code 2.1.288 or newer and the rook CLI on `PATH` (`brew install lambdatest/rook/rook`).

## What it does

| | |
|---|---|
| **Claude runs rook** | Eleven tools in all. The core five: `run` (execute scenarios, get verdicts back), `report` (read a finished run from disk, no credits), `status`, `scenarios` (every scenario with its latest verdict, so Claude picks `only` without guessing) and `generate` (write scenarios). Failures come back grouped into rook's clusters. With `rca`, each cluster has its cause, fault, files and the proposed diff from `remedies/CL-xx.md`, followed by rook's narrative and next steps. `run` also takes `tags`, `profile`, `concurrency`, `resume`, `continueRun` + `phases`, and a free-text `instruction`. |
| **Setup inside Claude Code** | Three more tools for a repository with no rook setup: `project` (list, `use` or `create` the rook project), `explore` (`rook explore .`: find the agents, write their features; spends credits, takes minutes) and `profile_test` (list profiles, `use` one, or `test` one: a single call to the agent, under the production guard). Adding a profile needs your connection details, so Claude asks you to type `! rook profile add <name> --from connection.md` yourself. |
| **History** | The `runs` tool and `/rook runs [N]` list the agent's runs on disk, newest first (size, Pass / Fail / Unable to Verify, credits, local test runs), so Claude can name an older run for `report` or its `rca` option. Each scenario's latest verdict looks back over the newest 30 runs, and keeps looking up to 300 for scenarios those did not judge. Scenarios or features changed outside the session (`rook generate` in another terminal) are picked up on the next poll. When the selected project has no runs but another project folder here does, the pane says where they are. |
| **Depth** | `report` with `rca: true` runs `rook report <run> --rca` on a finished run: rook explains its clusters without calling the agent again (free when that agent version was explained already, otherwise it costs credits); the pane's **Explain with rca** does the same. `agent` lists the project's agents and switches with `use` (the pane offers the switch when there is more than one). `curate` excludes or includes scenarios; delete is left to the terminal. The pane header and `status` show the credit balance (`rook plan`), and a run's result warns when it will not cover the re-test. |
| **Live verdict pane** | Every scenario's latest verdict across runs, a lane per scenario in flight (phase, elapsed time), the latest run's counts, pass rate, credits and duration, and what it fixed or regressed. Clusters and failed scenarios open to their criteria, evidence and remedy, each with **Fix this with Claude**. Also: *what nobody looked at* in words, rook's next steps, and buttons **Run all**, **Re-run failed**, **Fix with Claude** and **Evidence viewer** (`rook ui --local`). |
| **Spinner progress** | While Claude waits on a run, the turn's spinner shows `rook 3/8 · SC-004 execute · 1m12s`, so progress is visible even where the pane can't dock. |
| **Re-test prompt** | When Claude edits a file the agent is built from (`agent.yaml` → `source.tracks`), a band above the prompt names the scenarios whose features cite that file and estimates the cost at the last run's credits per scenario. **Re-test** asks Claude to run them. |
| **Failures as context** | If you start a run in another terminal, the mod notices when it finishes. If anything failed, Claude gets the clusters and failing criteria without any copy-pasting. |
| **Status line** | `rook ✓41 ✗2 ?3 · 2 gaps · ↑1 fixed ↓1 regressed` when idle. The counts are every scenario's latest verdict, and fixed and regressed are per scenario. While a run is in flight: `rook ▸ 12/48 · SC-013 judging`. |
| **`/rook`** | `pane` · `status` · `scenarios [exclude <ids>]` · `scenarios [include <ids>]` · `agent [use <id>]` · `report [run] [--rca]` · `explain [run] [--rca]` · `run [--only …] [--class …] [--category …] [--tag …] [--profile …] [--name …] [--concurrency N] [--resume <run>] [--run <run> --phases …] [--test] [--rca] [-- instruction]` · `generate [--total N] [--class …] [--category …] [--force] [-- what to cover]` · `ui` · `confirm-prod [profile]` · `help` |
| **`/rook` setup** | `project [list\|use <id>\|create <name>]` · `explore [--force] [-- instruction]` · `profile [list\|use <id>\|test [id] [-- goal]]` |
| **Production guard** | Refuses `rook run` (from Claude's shell or the tool, for the active profile or the one the run names) while the profile's target looks like production, until **you** type `/rook confirm-prod`. That opens a 15-minute window. The agent's writes are real and rook cannot roll them back. |

It keeps rook's vocabulary. **Unable to Verify is not Fail**: it is counted and shown separately, and failure notes to Claude say so.

## Install

From GitHub, inside Claude Code:

```
/plugin marketplace add 4DvAnCeBoY/rook-claude-plugin
/plugin install rook@rook-claude-plugin
```

Or from a clone, for one session: `claude --plugin-dir <clone>/plugins/rook`.

Open Claude Code in your agent's repository. With a rook workspace (`.testmuai/rook/`) the pane opens by itself when the terminal is wide enough to dock it; otherwise type `/rook`. Without one, the mod stays quiet until you type `/rook`, which shows the setup checklist.

## Options

Set them in `/config` or under `pluginConfigs.rook` in settings.

| Option | Default | |
|---|---|---|
| `rookPath` | `rook` | The CLI to run: a name on `PATH` or an absolute path |
| `pane` | `auto` | `auto` opens the pane in a rook workspace; `command` opens it only on `/rook`; `off` never opens it |
| `statusLine` | `true` | Show the score in the status line |
| `retestBand` | `true` | Track edits to the agent and offer a re-test |
| `failureContext` | `true` | Hand failures of runs started elsewhere to Claude |
| `prodGuard` | `true` | Refuse runs against a production-looking target until confirmed |
| `prodPatterns` | `prod,production,live` | Whole words that mark a target as production |
| `allowRules` | *(empty)* | rook's own tool calls during `run` and `generate` are approved with `--yes`; list rules (`;`-separated) to pass `--allow` for each instead, and rook declines the rest |

## How it talks to rook

Only through rook's published contract:

- The CLI's `--json` documents: `rook run --json`, `rook generate --json`, `rook status --json`, `rook scenarios list --json`, `rook scenarios exclude|include --json`, `rook plan --json`, plus `rook ui --local --no-open` for the viewer's address. `rook agent` and `rook report --rca` answer in prose, so the mod reads the agent list from it (or the agent directories) and re-reads the explained run from disk.
- For setup: `rook project --json` (or the plain `rook project` listing of an older rook), `rook project use|create`, `rook explore . --json`, `rook profile`, `rook profile use|test`. explore and profile test print prose even with `--json`, so the mod reads their closing lines. An older rook also answers `generate --json` with a prose line (`7 scenario(s) written, 0 already current, 553.12 credits`); the mod reads that line instead of reporting nothing written.
- The documented `.testmuai/rook/` layout: `run.yaml`, `report.yaml` (written last, so its presence means finished; its `clusters`, `narrative` and `next`), `remedies/<cluster>.md`, and `scenarios/<id>/verdict.yaml`. A scenario folder with no verdict yet is in flight. Its phase comes from `hooks.json`, `request.json` and `response.json`.

The mod holds no prompts and no model keys. It passes rook only validated flags:
- scenario ids in `SC-001` form
- the known classes and phases
- one-word categories and tags
- profile ids
- run ids in rook's form
- concurrency from 1 to 8
- printable names and rules that cannot start with `-`

A free-text instruction goes after `--`. Anything else is refused before `argv` is built.

**Profile tests and state.** `rook profile test` does not give a profile's scripts the state directory a run does, so a profile that keeps its session in `ROOK_STATE_DIR` fails it with "ROOK_STATE_DIR is required". The mod sets a fresh `ROOK_STATE_DIR` / `ROOK_RUN_STATE_DIR` under the system temp directory for each profile test it starts. rook passes its own environment to the scripts and sets these itself during a run, so runs keep their per-scenario directories.

## What the production guard reads, and what it does not

It reads the active profile's `target.endpoint`, `domain`, `command`, `server`, `url` and `base_url`, plus `hook_env`. It also reads the values of the variables the profile declares under `env`, taken from rook's own store (`~/.testmuai/rook/env.json`, written by `rook env set`).

A refusal names the field or variable and the marker word. It **never** includes the value, because a declared variable may be a credential. `localhost` and `127.0.0.1` targets are never flagged.

It does **not** read your shell's environment. A target whose only production marker is a variable exported in your shell will not be caught.

It is a speed bump, not a sandbox, and it does not make a run safe. Point your profiles at staging.

## Development

```
claude plugin validate .   # what the module hooks and calls; what the engine would refuse
claude plugin test .       # logic, pane and band on terminal and desktop, tools, guard, /rook
```

The YAML reader handles the subset rook writes. It was checked against 3,949 real rook files and matched PyYAML on all of them, apart from trailing whitespace inside long descriptions. Its run totals were also checked against `rook report --json` on 52 real runs, with no mismatches.

Apache-2.0, like rook.
