# dsh-terminal

Vanilla DeepSeek Harness in the terminal — a Web-GUI-parity Cordis surface over `dsh-base`.

**Nothing extra, nothing less.** Same agents, tools, sessions, approval, settings, and installed plugins as `dsh web`. Web-only UI contributions are ignored; backend contributions always work.

Three modes, chosen at boot:

| Mode | When | What |
|------|------|------|
| Full-screen TUI | stdio on a TTY | transcript + composer + panels + modal dialogs (Ink) |
| Line REPL | pipes, CI, `--line` | same DSH bindings, line-oriented, history, Ctrl-C cancels the turn |
| One-shot | `--print "<task>"` | answer one task, print the final text, exit with a status code |

## Install

Requires Node `^22.19 || >=24` and the `dsh` CLI.

From this checkout:

```sh
# once: install and build
npm install
npm run build -w dsh-terminal

# create a profile that stacks dsh-base + this surface
dsh plugin --profile terminal add ./packages/dsh-terminal

# run (full-screen on a TTY)
dsh --profile terminal
```

Flags (same idea as headless/web):

```sh
dsh --profile terminal --help
dsh --profile terminal --model deepseek-reasoner
dsh --profile terminal --resume session-…
dsh --profile terminal --line              # force the line REPL
dsh --profile terminal --print "run tests"  # one-shot, stdout + exit code
```

Add more plugins into the same profile (they load as ordinary DSH Cordis plugins):

```sh
dsh plugin --profile terminal add <npm-pkg | github:owner/repo | ./path | ./pkg.tgz>
```

## GUI → TUI parity

| Web GUI | Terminal |
|---------|----------|
| Chat + streaming | live text / reasoning / tool cards, scrollback history |
| Sessions | `/sessions` browser (live + persisted), `/resume <id>`, `/new` |
| Models | `/model` provider → model discovery picker, switch without forking, `--model` / `--provider` |
| Effort | `/effort` per-model reasoning levels, resolved from the adapter |
| Tools | `/tools` (from `dsh-base` + plugins), `ask_user_question` included |
| Approval | allow / reject modal on `ctx.approval` (incl. sandbox escalation) |
| Agent questions | option-list + free-text form via `ctx.userQuestions` |
| Plugin commands | dispatched from `/`, never sent to the model (`/commands`) |
| Plugins | `/plugins` + `dsh plugin add` |
| Settings | `/settings` → same `$DSH_HOME/settings.yaml` namespaces web edits |
| Permissions | `/permissions` (same presets as core) |
| Jobs | `/jobs` background-job snapshots |
| Diagnostics | `/doctor` |

## Keys (full-screen)

`enter` send · typing while running steers · `ctrl-c` stops the turn (clears / quits when idle) · `ctrl-d` quits · `/` commands with Tab completion · `↑↓` palette / history · native scrollback · `esc` back · `f1` help.

The layout lives inside a 100-column cap (narrow terminals use their full width) and re-converges after terminal resizes.

## Slash commands

Builtins (same set in the TUI and the line REPL):

`/help` `/new` `/sessions` `/resume` `/fork` `/model` `/effort` `/title` `/tools` `/commands` `/skills` `/agents` `/terminals` `/presets` `/plugins` `/settings` `/permissions` `/jobs` `/todos` `/usage` `/stop` `/doctor` `/clear` `/quit`

Plugin commands (e.g. `/compact` `/plan` `/goal` `/feedback` `/permission`) dispatch directly — type `/` to see everything installed.

The status line reads `model · effort · ~/cwd · ctx · MODE`, e.g.
`deepseek-official/deepseek-chat · high · ~/proj · 8.2k · 13% · [WRITE]` (the ctx
segment shows `8.2k tok` until the model's context window resolves).

## Plugin consumption (UI vs backend)

Backend always. UI only when portable.

| Contribution | Terminal |
|--------------|----------|
| `ctx.tools`, `ctx.commands`, `ctx.jobs`, `ctx.llm`, fs/sandbox/shell | **works** |
| Settings keys, system prompt, session titles, hooks | **works** |
| Web Client Chat node (`ConversationNodeDefinition` + renderer) | ignored |
| Web settings card | card ignored; config key still editable when known |

There is **no TUI-only plugin API**. Install into the DSH profile; the surface is a window onto DSH.

Composition notes:

- The terminal profile is **rosterless** (like headless): model-facing rows sit in the global layer and the surface composes one agent process-wide. Web composes each session from an agent preset instead. Resuming a preset-composed web session here runs the base tool set; the surface says so instead of failing.
- The bundle adds the `ask_user_question` tool row (a preset row on web) so the agent can ask from the terminal. It is answered by this surface's `userQuestions` provider.
- The surface targets the installed dsh release and tolerates its neighbors: live streaming listens to both `agent/assistant-stream` (newer) and top-level `assistant/chunk` events (older), first source wins; history reads prefer the `events` snapshot with an indexed fallback.

## Architecture

```
dsh --profile terminal
  └── dsh-terminal (Cordis bundle)
        ├── cordis.patch.yml      base rows + code-runtime + ask-user + startup + runner
        ├── dsh-terminal/startup  cmdline flags → terminalStartup
        └── dsh-terminal          runner → TUI | REPL | --print
              ├── core/dsh.ts         UI-agnostic service facade (feature-detected)
              ├── core/transcript.ts  durable-log projection + live overlay (shared)
              ├── core/messages.ts    deep-frozen message factories (no llm import)
              ├── core/lineinput.ts   single-reader TTY/pipe input (REPL)
              ├── repl.ts             line surface
              ├── print.ts            one-shot surface
              └── tui/                engine (behavior) + app/widgets (Ink render)
```

Stacks on `@deepseek-ai/dsh-base` like `dsh-web-app`. Not a second host, not dsh-TUI's Channel protocol.

## Development

```sh
npm run typecheck -w dsh-terminal
npm run build -w dsh-terminal
```

Local `tsc` uses ambient types in `types/dsh-modules.d.ts` plus structural
service shapes in `src/core/types.ts` (no `@deepseek-ai/*` runtime imports —
everything arrives through the Cordis context). Runtime truth is the installed
profile packages; `.ref/deepseek-harness` is a newer reference checkout, so
verify API shapes against the installed release before relying on them.

## License

MIT
