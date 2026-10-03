# rook for Claude Code

**Claude builds your agent. rook tests it. Same terminal.**

A Claude Code mod for [rook](https://github.com/LambdaTest/rook), TestMu AI's agent-assurance CLI. It puts rook's verdicts where your agent is being written. Claude can run the scenarios, read rook's evidence and fix what failed, and you watch it happen in a live pane.

> Status: early access, like Claude Code's function-hooks API it is built on. Requires Claude Code 2.1.288 or newer and the rook CLI on `PATH` (`brew install lambdatest/rook/rook`).

## What it does

| | |
|---|---|
| **Claude runs rook** | Three tools Claude can call: `run` (execute scenarios, get verdicts back), `report` (read a finished run from disk, no credits) and `status`. After changing the agent's prompt, tools or code, Claude re-tests just the scenarios it touched and fixes failures from rook's quoted evidence. |
| **Live verdict pane** | Progress, **Pass / Fail / Unable to Verify**, credits, pass rate, the trend against the last run, and *what nobody looked at* (verification gaps). Buttons: **Run all**, **Re-run failed**, **Fix with Claude**. |
| **Re-test prompt** | When Claude edits a file the agent is built from (`agent.yaml` → `source.tracks`), a band above the prompt names the scenarios whose features cite that file. **Re-test** asks Claude to run them. |
| **Failures as context** | If you start a run in another terminal, the mod notices when it finishes. If anything failed, Claude gets the failing criteria (expected vs achieved, evidence quote, verdict path) without any copy-pasting. |
| **Status line** | `rook ✓41 ✗2 ?3 · 2 gaps · ↑3 vs last` when idle, `rook ▸ 12/48` while a run is in flight. |
| **`/rook`** | `pane` · `status` · `report [run]` · `explain [run]` · `run [--only SC-001,SC-002] [--class …] [--category …] [--name …] [--test] [--rca]` · `confirm-prod` · `help` |
| **Production guard** | Refuses `rook run` (from Claude's shell or the tool) while the active profile's target looks like production, until **you** type `/rook confirm-prod`. That opens a 15-minute window. The agent's writes are real and rook cannot roll them back. |

It keeps rook's vocabulary. **Unable to Verify is not Fail**: it is counted and shown separately, and failure notes to Claude say so.

## Install

From GitHub, inside Claude Code:

```
/plugin marketplace add 4DvAnCeBoY/rook-claude-plugin
/plugin install rook@rook-claude-plugin
```

Or from a clone, for one session: `claude --plugin-dir <clone>/plugins/rook`.

Open Claude Code in a repository that has a rook workspace (`.testmuai/rook/`, created by `rook explore .`). The pane opens by itself when the terminal is wide enough to dock it. Otherwise, type `/rook`.

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

## How it talks to rook

Only through rook's published contract:

- The CLI's `--json` documents: `rook run --yes --json`, `rook status --json`.
- The documented `.testmuai/rook/` layout: `run.yaml`, `report.yaml` (written last, so its presence means finished), and `scenarios/<id>/verdict.yaml`.

The mod holds no prompts and no model keys. It passes rook only validated flags: scenario ids in `SC-001` form, the three known classes, one-word categories, and a printable run name that cannot start with `-`. Anything else is refused before `argv` is built.

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
