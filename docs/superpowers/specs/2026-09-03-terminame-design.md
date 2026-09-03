# Terminame — auto-naming terminal tabs from the running command

Date: 2026-09-03
Status: approved design, pending implementation plan

## Goal

A VS Code / Cursor extension that renames each integrated-terminal tab to a short,
human-readable title derived from the command running in it. `npm run dev` becomes
"Start App", `git rebase -i main` becomes "Rebase", `pytest tests/api` in
`packages/billing` becomes "Billing Tests".

It must work on install with zero configuration, in Cursor as well as stock VS Code,
and never ask the user for an API key. Where a model is reachable through a login the
user already has, it uses that model; otherwise it falls back to a built-in rules table.

## Non-goals (v1)

- Installing or driving Ollama or any other local model runtime.
- Naming based on terminal *output* text; only the command line and cwd are inputs.
- Renaming terminals whose commands the extension did not observe from the start.
- Marketplace publishing, telemetry, localisation.

## User-facing behaviour

1. User runs a command in an integrated terminal.
2. If a model provider is available: the extension waits for the model (default
   mode `waitForModel`) and renames the tab with the sanitised answer. On timeout or
   error it renames with the rules-table name instead.
3. If no provider is available: the tab is renamed from the rules table immediately.
4. Trivial commands (`ls`, `cd`, `clear`, …) never rename.
5. When the command ends the name is kept by default (`idleName: keep`).
6. A tab the user renamed by hand is left alone until it is closed.
7. There are no modal dialogs. Diagnostics go to an output channel. A single status
   bar item appears only when running rules-only, with a tooltip explaining how to get
   a model.

## Naming provider chain

Probed once on activation, in order; the first available provider is used for the
session. `terminame.provider` can force one or select `rules`.

| Rung | Provider | Availability probe | Auth | Model |
|---|---|---|---|---|
| 1 | Editor model (`vscode.lm`) | `selectChatModels()` returns ≥1 model | Copilot sign-in inside VS Code; extension never sees a token. Returns 0 models in Cursor today. | First model returned |
| 2 | Claude Code CLI | `claude` on PATH and `claude -p` probe succeeds | User's existing `/login`; extension only spawns the binary. | `--model haiku` |
| 3 | Anthropic SDK | Zero-arg client constructs and a probe request succeeds | Whatever the official SDK resolves on its own: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an `ant auth login` profile, or the optional key in `terminame.anthropic.apiKey` (stored via SecretStorage). | `terminame.anthropic.model`, default `claude-haiku-4-5` (deliberate deviation from the Opus 5 default: the task is a 3-word title) |
| 4 | Rules table | always | none | n/a |

Explicitly **not** done: reading Claude Code's stored OAuth token (Keychain /
`~/.claude/.credentials.json`) and calling the API with it. That token is issued to
Claude Code; third-party reuse violates Anthropic's terms.

Failure policy: 3 consecutive provider failures in a session disable that provider and
the chain falls through to the next rung; the status bar hint updates once.

## Data flow per command

1. **Observe.** `onDidStartTerminalShellExecution` gives terminal, `commandLine.value`,
   `cwd`.
2. **Normalise.** Strip leading `sudo`, `time`, `env`, `KEY=value` assignments, trailing
   `&`; collapse whitespace. For `&&`/`;` chains use the *last* segment; for `|`
   pipelines use the *first* segment. The chosen segment is the cache key.
3. **Ignore list.** Built-in denylist (`ls cd pwd clear echo cat exit history`, anything
   under 3 chars) plus `terminame.ignore`.
4. **Cache.** `globalState`-backed map `normalisedCommand → name`. Hit → rename now.
5. **Model call.** One in-flight request per terminal; a newer command cancels the older
   request. Timeout `terminame.timeoutMs` (default 6000).
6. **Sanitise.** Trim; strip quotes/trailing punctuation; ≤3 words; ≤24 chars;
   Title Case. Empty result = miss.
7. **Rename + cache.**
8. **Fallback.** Any failure → rules-table name; log to output channel.

### Prompt (fixed system text, cacheable)

> You name terminal tabs. Given a shell command and the folder it runs in, reply with
> only a short title of 1 to 3 words that a developer would recognise at a glance.
> Examples: `npm run dev` → Start App. `git rebase -i main` → Rebase.
> `docker compose up` → Docker Up. `pytest tests/api` → API Tests.
> No punctuation, no explanation.

User turn: the normalised command line and the cwd basename.

## Rules table

Ordered list of `{ match, name }` rows. `match` is a glob-like prefix pattern on the
normalised command. User rows from `terminame.rules` are checked before built-ins.
Unknown command → first word of the command.

Built-in starter set (extend during implementation):

| Match | Name |
|---|---|
| `npm run dev`, `yarn dev`, `pnpm dev`, `npm start`, `vite`, `next dev` | Start App |
| `python manage.py runserver`, `rails s*`, `uvicorn *`, `flask run` | Start App |
| `npm test`, `jest*`, `vitest*`, `pytest*`, `go test*`, `cargo test` | Tests |
| `npm run build`, `tsc*`, `webpack*`, `cargo build`, `go build` | Build |
| `npm i*`, `npm install*`, `yarn`, `pnpm i*`, `pip install*` | Install |
| `git rebase*` / `git merge*` / `git push*` / `git pull*` / `git log*` | Rebase / Merge / Push / Pull / Git Log |
| `docker compose up*` / `docker build*` | Docker Up / Docker Build |
| `ssh <host>` | SSH <host> |
| `tail -f*`, `kubectl logs*` | Logs |
| `claude*` / `cursor-agent*` / `codex*` | Claude / Agent / Codex |

## Rename mechanics

Constraint: `workbench.action.terminal.renameWithArg` acts on the **active** terminal
only; there is no API to rename a background terminal directly.

- **Active terminal:** rename immediately.
- **Background terminal:** store the desired name; apply on `onDidChangeActiveTerminal`
  when that terminal becomes active. Optional `terminame.aggressiveRename` (default
  false) instead focuses the tab, renames, and restores focus (visible flicker).
- **Manual renames:** the extension remembers the last name it applied per terminal.
  If the terminal's current name differs from both that and the shell default, the
  terminal is flagged user-owned and no longer renamed until closed.
- **Rapid commands:** cancel the in-flight request; name only the latest command.
- **Command end:** `terminame.idleName` = `keep` (default) | `folder` (cwd basename) |
  `shell` (original name such as `zsh`).
- **Terminal close:** drop pending names and flags.
- **No shell integration:** if a terminal emits no execution event for its first
  command, show a one-time hint pointing at
  `terminal.integrated.shellIntegration.enabled`.

## Components

```
src/
  extension.ts        activation, wiring, disposables
  shellWatcher.ts     wraps shell-execution events → CommandEvent
  namer.ts            cache → provider chain → sanitise → fallback
  rules.ts            built-in table, user-rule merge, ignore list, normalisation
  cache.ts            globalState-backed memo
  renamer.ts          per-terminal name state, active/background handling
  providers/
    types.ts          interface NameProvider { id; isAvailable(); name(cmd, cwd, signal) }
    vscodeLm.ts
    claudeCli.ts
    anthropicSdk.ts
```

Each unit has one purpose and a narrow interface; `rules.ts`, `namer.ts` (with fake
providers) and the sanitiser are pure enough to unit-test without VS Code.

## Settings (`terminame.*`)

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | |
| `mode` | `"waitForModel"` | or `"instant"` (rules first, refine when model answers) |
| `timeoutMs` | `6000` | |
| `provider` | `"auto"` | `vscodeLm` \| `claudeCli` \| `anthropic` \| `rules` |
| `anthropic.apiKey` | unset | set via command, stored in SecretStorage |
| `anthropic.model` | `"claude-haiku-4-5"` | |
| `rules` | `[]` | `{ match, name }` rows, checked first |
| `ignore` | `[]` | extra never-rename commands |
| `idleName` | `"keep"` | `keep` \| `folder` \| `shell` |
| `aggressiveRename` | `false` | |

Commands: `Terminame: Rename current terminal now`, `Terminame: Clear name cache`,
`Terminame: Show log`, `Terminame: Set Anthropic API key`.

## Error handling

- Never block the terminal or show a modal.
- Output channel "Terminame" for all diagnostics.
- Provider three-strikes rule per session.
- Sanitisation failure is a miss, not an error.

## Testing

- **Unit (Vitest, no VS Code):** normalisation, segment choice for `&&`/`|`, ignore
  list, rules matching incl. user override order, sanitiser, cache key.
- **Namer with fake providers:** chain order, timeout, cancellation, three-strikes,
  fallback to rules.
- **Extension-host smoke (`@vscode/test-electron`):** open terminal, run a command,
  assert tab renamed; run an ignored command, assert no rename. Keep to 2–3 tests.

## Prerequisites / environment notes

- Node ≥ 20 and npm must be on PATH; they are not in the current shell on this machine.
- Target editor is Cursor 3.x (VS Code-based). Set `engines.vscode` to the VS Code
  version Cursor's current build reports so shell-integration APIs
  (`onDidStartTerminalShellExecution`, stable since VS Code 1.93) are available.
- Verify during implementation that `vscode.lm` indeed returns no models in Cursor and
  that the extension degrades cleanly to rung 2.

## Open questions resolved during brainstorming

- LLM source: no free hosted model exists without a key; use logins the user already
  has (Copilot, Claude Code) and rules otherwise.
- Ollama: deferred; if added later it is an auto-detected rung, never auto-installed.
- Rename timing: wait for the model rather than flip from rules → model.
