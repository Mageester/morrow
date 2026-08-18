# The Morrow terminal

`morrow` opens an interactive shell in the current project. This document is the
reference for what it does and how it is built. Everything described here works;
where a capability depends on the service or a provider being reachable, that is
stated.

---

## Starting

```bash
morrow                      # open the shell in the current project
morrow "explain this repo"  # one-shot: run a single prompt and exit
morrow --project <id>       # open a specific project
morrow --resume <id>        # open straight into a saved conversation
```

The shell needs an interactive terminal. When stdout is redirected, `TERM=dumb`
is set, `--json` is passed, or `MORROW_TUI=0` is set, Morrow falls back to a
line-based surface that offers **the same commands**, rendered as plain text.

## The screen

Top to bottom:

- **Transcript** — your messages, Morrow's answers, command output, and the tool
  work each turn did. Written once into the terminal's own scrollback, so normal
  scrolling, selection and copy all work.
- **Live region** — the tool currently running, anything queued, and notices.
- **Status line** — project, branch, model, context used.
- **Composer** — where you type.

Nothing above the composer is redrawn once it has settled. That is what keeps a
long session as fast as a fresh one.

---

## Keyboard

### Composing

| Key | Does |
|---|---|
| `Enter` | send |
| `Alt+Enter`, `Shift+Enter` | new line |
| `\` then `Enter` | new line, on terminals that cannot report the above |
| `←` `→` | move by character |
| `Ctrl+←` `Ctrl+→`, `Alt+B` `Alt+F` | move by word |
| `↑` `↓` | move a line; at the first/last line, recall history |
| `Home`, `Ctrl+A` | start of line |
| `End`, `Ctrl+E` | end of line |
| `Backspace`, `Delete` | delete before / after the cursor |
| `Ctrl+W` | delete the word before the cursor |
| `Alt+D` | delete the word after the cursor |
| `Ctrl+U` | delete to start of line |
| `Ctrl+K` | delete to end of line |
| `Ctrl+Y` | paste back what you deleted |

### Commands and files

| Key | Does |
|---|---|
| `/` | open the command palette |
| `@` | reference a file |
| `Tab` | complete the highlighted suggestion |
| `↑` `↓` | move through suggestions |
| `Enter` | run the highlighted command (or complete it, if it takes arguments) |
| `Esc` | dismiss suggestions, keeping what you typed |

### Running work

| Key | Does |
|---|---|
| `Ctrl+C` | stop the running task |
| `Ctrl+C` again, when idle | clear the line; twice on an empty line, exit |
| `Esc` | stop the running task |
| typing while working | queued, and sent when the task ends |

### Screen

| Key | Does |
|---|---|
| `Ctrl+O` | expand or collapse tool detail |
| `Ctrl+L` | clear the screen |
| `Ctrl+G` | keyboard reference |

`/shortcuts` prints this table from the same source the shell binds against, so
it cannot drift.

---

## Pasting

Paste normally. Morrow enables bracketed paste, so a multi-line paste arrives
whole and is never mistaken for a series of Enter presses.

A paste of eight lines or more is held aside and shown as one token:

```
> review this: [#1 pasted 240 lines]
  1 pasted block held — sent in full
```

The full text is sent verbatim on Enter. Deleting the token discards the block.

---

## Commands

Press `/` to browse. Every command below works; commands with no data to show
say so specifically rather than failing.

### Session

| Command | Does |
|---|---|
| `/help [command]` | list commands, or explain one |
| `/new [title]` | start a fresh conversation |
| `/sessions` | list recent conversations |
| `/resume [id]` | reopen one — a picker with no argument |
| `/history [limit]` | this conversation's saved messages |
| `/compact` | summarise history into a continuation note |
| `/export [filename]` | write a sanitised report of the last task |
| `/clear` | clear the terminal |
| `/exit` | leave |

### Model and routing

| Command | Does |
|---|---|
| `/model [id\|auto]` | choose the model — a searchable picker with no argument |
| `/provider [id\|auto]` | show configured providers, or switch |
| `/preset [id]` | choose the routing preset |
| `/reasoning [auto\|off\|low\|medium\|high\|<tokens>]` | how much the model thinks first |
| `/mode [ask\|plan\|build]` | read-only, propose-only, or edit |

The model picker shows each model's provider, context window, pricing and
whether it is actually reachable. Unreachable models stay listed with the reason
attached, because hiding one answers the wrong question.

Switching provider clears a model pinned to the old one. Switching to a route
that cannot honour the active reasoning setting resets it to auto and says so.

### Work

| Command | Does |
|---|---|
| `/status` | where you are, what you're talking to, whether it's healthy |
| `/context` | context window used, and the budget behind it |
| `/cost` | tokens and estimated spend this session |
| `/tasks [limit]` | recent and running tasks |
| `/output [summary\|full\|failures] [task-id]` | a finished task's durable report |
| `/diff` | what Morrow changed in the last task |
| `/undo` | roll those changes back |
| `/retry` | run the last task again |
| `/changes` | working tree status |
| `/search <query>` | full-text search across saved work |
| `/checkpoint [list\|save <name>\|restore <name>\|delete <name>]` | workspace snapshots |
| `/ps [kill <id>]` | background processes |
| `/worktrees [show <id>\|remove <id>]` | isolated agent worktrees |
| `/integrate [list\|check <id>\|apply <id>]` | review and apply a worktree's branch |

### Project

| Command | Does |
|---|---|
| `/cortex [overview\|map\|conventions\|decisions\|risks\|learnings\|commands]` | what Morrow has learned about this repository |
| `/rules [list\|add <text>\|remove <id>]` | explicit rules, which outrank anything inferred |
| `/memory [on\|off\|list\|add <text>\|search <query>\|forget <id>]` | project memory |
| `/skills [query]` | installed skills |
| `/agents` | project agents |
| `/mission [status\|criteria\|evidence\|failures\|checkpoints\|tree\|result]` | the active verified mission |
| `/skill:<id> [what to apply it to]` | run a skill |

### Safety and control

| Command | Does |
|---|---|
| `/tools` | tools the agent can call, and what each may touch |
| `/permissions` | what Morrow may read, write and run |
| `/yolo [on\|off\|status\|policy]` | auto-approve in-workspace edits and commands |
| `/stop` | cancel the running task |
| `/panic` | cancel everything and disable auto-approval |
| `/continue` | resume the last interrupted task |
| `/audit [limit]` | recorded actions and their provenance |

### Help

| Command | Does |
|---|---|
| `/shortcuts` | keyboard reference |
| `/capabilities` | what this build can actually do right now |
| `/doctor` | service, route and environment check |

An unknown command is reported with the nearest matches. It is never forwarded
to the model.

---

## Sessions

Conversations are stored in Morrow's database, not in a terminal-side file.
Closing the terminal, crashing, or rebooting loses the screen and nothing else:
`/sessions` lists what is saved and `/resume` reopens it.

`/new` starts a fresh conversation in the same project. Both switch where
subsequent messages go, and `/status` reflects the change immediately.

Command history (the `↑` key) is stored per user in `~/.morrow/history`.

---

## Interrupting and steering

`Ctrl+C` while work is running cancels the task. Anything already applied stays
applied — `/undo` rolls back file changes. The session, the conversation and the
transcript are untouched, and you can carry straight on.

Typing while a task runs does not interrupt it. The message is held, shown as
queued, and sent as the next message when the current one finishes.

---

## Context

The status line shows context used as a percentage, and only when Morrow has a
measured window to divide by — an unknown window shows nothing rather than a
figure nothing has verified. `/context` shows the full picture, including the
output reserve and the compaction target. `/compact` writes a deterministic
continuation summary without making a model request.

---

## Permissions

In Build mode, commands and patches require approval. The prompt states the
action, its target, and the choices; the keyboard answers it and nothing else
can consume the keystroke while it is waiting.

`/yolo on` auto-approves ordinary in-workspace work. It always blocks workspace
escape, credential reads, privilege escalation, destructive disk actions and
history rewrites. `/yolo policy` states the full boundary; every auto-approved
action is still recorded in `/audit`.

---

## Troubleshooting

**The shell opens as plain lines instead of the full surface.** Something in
`shouldUseInteractive` said no: output is redirected, `TERM=dumb`, `--json`, or
`MORROW_TUI=0`. All commands still work.

**Glyphs render as boxes.** Set `MORROW_ASCII=1` for ASCII fallbacks.

**No colour.** `NO_COLOR=1` and `--no-color` are both honoured.

**A command says a capability is unavailable.** The service is reachable but
that endpoint is not, usually because the feature needs a provider or a project
resource that is not configured. `/doctor` reports which.

**Nothing responds.** `/doctor` checks the service endpoint and the route.
`morrow status` and `morrow logs` from a shell report on the service itself.

---

## How it is built

```
orchestrator (SSE)
  → mapTaskEvent          normalise to TerminalEvent
  → reduce                pure reducer → TerminalState
  → Ink                   render
```

Four rules hold this together:

1. **One execution path.** The shell sends through `SessionBackend` and consumes
   the events that come back. Commands change settings and read state; none of
   them runs an agent loop.
2. **Producers never format.** Anything reaching the screen is a `TerminalEvent`
   folded through the reducer.
3. **Commands return data, not lines.** A handler returns a `Report` — headings,
   fields, tables, diffs — and the surface renders it. The same command
   therefore works in the shell and in the plain-line fallback.
4. **One registry.** `terminal/commands/` is the only place a command exists.
   The palette, `/help`, completion, `morrow --help` and the dispatcher all read
   it.

Key modules:

| Module | Owns |
|---|---|
| `terminal/events.ts` | the event model |
| `terminal/state.ts` | the reducer |
| `terminal/report.ts` | structured command output |
| `terminal/commands/` | the command registry and every handler |
| `terminal/session-types.ts` | the backend contract |
| `terminal/ink/editor.ts` | the composer, as a pure state machine |
| `terminal/ink/app.tsx` | the shell |
| `terminal/ink/shell.tsx` | the runtime loop |
