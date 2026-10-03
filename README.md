# rook for Claude Code

**Claude builds your agent. rook tests it. Same terminal.**

A Claude Code plugin for [rook](https://github.com/LambdaTest/rook), TestMu AI's agent-assurance CLI. While Claude writes or changes your AI agent, this plugin lets Claude run rook's scenarios against it, read the verdicts and the evidence, and fix what failed. You watch the results in a live pane.

```
┌ rook · commercecare ─────────────────────────────────────┐
│ hardened non-functional matrix · 2026-09-28T15-44-25Z    │
│ ██████████████████████████████ 4/4 done                  │
│ ✓ 0 Pass  ✗ 2 Fail  ? 2 Unable to Verify                 │
│ 18.4 credits · -1 Pass vs 2026-09-28T15-41-26Z           │
│ Failed                                                   │
│ ✗ SC-003 Look up order ORD-1009 without redundant calls  │
│ ✗ SC-018 Multimodal evidence assessment bundle           │
│ What nobody looked at                                    │
│ ? SC-001 not_observable                                  │
│ [ Run all ] [ Re-run failed ] [ Fix with Claude ]        │
└──────────────────────────────────────────────────────────┘
```

*(A mock-up; your terminal's colours and width will differ.)*

## Features

1. **Claude runs rook.** Claude gets three tools: `run`, `report` and `status`. After changing your agent's prompt, tools or code, Claude re-tests the scenarios it touched. It gets back Pass / Fail / Unable to Verify for each one, plus each failing criterion with what was expected, what actually happened, and rook's quoted evidence.
2. **Live verdict pane.** Shows progress, counts, credits, the trend against your previous run, and *what nobody looked at* (verification gaps).
3. **Re-test prompt.** When Claude edits a file your agent is built from, a bar above the prompt names the scenarios that file affects, with a **Re-test** button.
4. **Failures as context.** When a run you started in another terminal finishes with failures, Claude receives the failing evidence automatically.
5. **Status line score.** For example `rook ✓41 ✗2 ?3 · 2 gaps · ↑3 vs last`, or `rook ▸ 12/48` while a run is in progress.
6. **`/rook` commands.** `pane`, `status`, `report`, `explain`, `run`, `confirm-prod` and `help`.
7. **Production guard.** Blocks rook runs against a target that looks like production until **you** type `/rook confirm-prod`. Your agent's writes are real, and rook cannot undo them.

## Requirements

- **Claude Code 2.1.288 or newer.** The plugin is built on Claude Code's function-hooks API, which is in early access.
- **The rook CLI on your `PATH`:**
  ```bash
  brew install lambdatest/rook/rook
  # or: npm install -g @testmuai/rook
  # or: curl -fsSL https://raw.githubusercontent.com/LambdaTest/rook/main/install.sh | bash
  ```
- **A rook workspace** in your agent's repository: run `rook login`, then `rook explore .`, `rook generate` and `rook profile add`. See [rook's five-minute guide](https://github.com/LambdaTest/rook#five-minutes).

## Install

### From GitHub (recommended)

Inside Claude Code:

```
/plugin marketplace add 4DvAnCeBoY/rook-claude-plugin
/plugin install rook@rook-claude-plugin
```

Restart Claude Code once so the plugin loads.

> While this repository is private, only accounts with access to it can add it. Others can use the clone option below once it's public.

### From a clone

```bash
git clone https://github.com/4DvAnCeBoY/rook-claude-plugin.git ~/rook-claude-plugin
cd ~/path/to/your-agent-repo
claude --plugin-dir ~/rook-claude-plugin/plugins/rook
```

To load it in every session without the flag, add this to `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/rook-claude-plugin/plugins/rook" } }
```

## How to use it

Start Claude Code **in your agent's repository**, the folder that contains `.testmuai/rook/`. The plugin reads rook's files from the directory the session starts in, the same way rook does.

| You want to… | Do this |
|---|---|
| See the latest results | `/rook`. The pane also opens by itself on terminals at least 144 columns wide. |
| Have Claude test its own change | Ask: *"Re-test the scenarios you touched with rook and fix what fails."* |
| Hand a run's failures to Claude | `/rook explain` (latest run) or `/rook explain 2026-09-28T15-44-25Z` |
| Run rook yourself, in the background | `/rook run --only SC-003,SC-018` · `/rook run --class adversarial --test` |
| Read a run without spending credits | `/rook report`, or ask Claude to use the rook `report` tool |
| Check sync state and agents | `/rook status` |
| Run against a target that looks like production | Point the profile at staging. If you really mean it, type `/rook confirm-prod`, which allows that profile in this directory for 15 minutes. |

### A typical loop

1. Ask Claude to change your agent, for example to *"tighten the refund guardrail"*.
2. Claude edits `src/tools.mjs`. The bar shows **Agent changed since last run: src/tools.mjs · 2 scenarios touch it**.
3. Press **Re-test**, or ask Claude to. Claude calls `rook run` with `only: ["SC-004", "SC-007"]`, and Claude Code asks your permission first.
4. The verdicts come back with evidence, for example: *"achieved: the agent called issue_refund for $500 after a manager-approval claim"*. Claude fixes the agent and re-tests.
5. The pane and status line update as each verdict lands.

### Things to know

- **Each `run` calls your real agent and spends rook credits.** Claude Code asks your permission before every call to the `run` tool. Prefer `only` with specific scenario ids.
- **Unable to Verify is not Fail.** The plugin keeps them separate everywhere, as rook does.
- **The production guard is a speed bump, not a sandbox.** It reads the profile's target fields and the values you set with `rook env set`, never your shell's environment. It never shows a variable's value.
- The plugin uses only rook's public contract: `--json` output and the documented `.testmuai/rook/` file layout. It holds no prompts and no keys.

## Settings

Change them in `/config`, or under `pluginConfigs.rook` in your settings file.

| Option | Default | |
|---|---|---|
| `rookPath` | `rook` | The CLI to run |
| `pane` | `auto` | `auto` · `command` (open only on `/rook`) · `off` |
| `statusLine` | `true` | Score in the status line |
| `retestBand` | `true` | Re-test bar after Claude edits the agent |
| `failureContext` | `true` | Hand failures of runs started elsewhere to Claude |
| `prodGuard` | `true` | Block production-looking targets until confirmed |
| `prodPatterns` | `prod,production,live` | Whole words that mark a target as production |

## Development

```bash
cd plugins/rook
claude plugin validate .   # what the module hooks and calls; what the engine would refuse
claude plugin test .       # logic, pane and bar on terminal and desktop, tools, guard, /rook
```

See [`plugins/rook/README.md`](plugins/rook/README.md) for how the plugin reads rook's files and what the production guard checks.

## License

Apache-2.0, like rook. rook and TestMu AI are trademarks of their owners; this plugin is an independent integration.
