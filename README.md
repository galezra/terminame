# Terminame

Names your terminal tabs after what is running in them. `npm run dev` becomes **Start App**,
`git rebase -i main` becomes **Rebase**, `pytest tests/api` in `packages/billing` becomes **Billing Tests**.

Works on install with zero configuration, in Cursor and VS Code.

## How names are chosen

1. **Editor model** — if your editor exposes one (VS Code with Copilot). Not available in Cursor.
2. **Claude Code CLI** — if `claude` is installed and you have run `/login`. Terminame only runs the
   binary; it never reads your credentials.
3. **Anthropic SDK** — if the SDK can find credentials on its own (`ANTHROPIC_API_KEY`, an
   `ant auth login` profile) or you set a key via *Terminame: Set Anthropic API key*.
4. **Built-in rules** — always available, instant, offline.

Answers are cached per command **and folder**, so each distinct command in a given folder costs one model call.

A status-bar item (`$(terminal) Terminame: rules`) appears when auto-detection found no model and
Terminame is naming tabs from rules alone. Click it to open the log. It stays hidden when you set
`terminame.provider` to `rules` yourself, and when a model provider is in use.

## Commands

| Command | What it does |
|---|---|
| *Terminame: Rename current terminal now* | Prompts for a command and names the active terminal after it. Also takes back a tab you had renamed by hand |
| *Terminame: Clear name cache* | Empties the cached command → name map |
| *Terminame: Show log* | Opens the Terminame output channel |
| *Terminame: Set Anthropic API key* | Stores a key in SecretStorage for the Anthropic SDK provider (submit an empty value to delete it) |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `terminame.enabled` | `true` | Master switch |
| `terminame.mode` | `instant` | Rules name at once, then the model name when it answers. `waitForModel` waits for the model |
| `terminame.timeoutMs` | `20000` | Model timeout |
| `terminame.provider` | `auto` | Force `vscodeLm`, `claudeCli`, `anthropic`, or `rules` |
| `terminame.anthropic.model` | `claude-haiku-4-5` | Model for the SDK provider |
| `terminame.rules` | `[]` | Your own `{ "match": "make deploy*", "name": "Deploy" }` rows, checked first. `*` matches anything; `<host>` captures one word |
| `terminame.ignore` | `[]` | Extra commands that never rename. Matched against the **first word only** (`make`, not `make lint`) |
| `terminame.idleName` | `keep` | `folder` or `shell` to revert when the command ends |
| `terminame.aggressiveRename` | `false` | **Experimental.** Focus background tabs to rename them right away (causes a flicker; not verified against the live VS Code API) |

## Known limits

- VS Code can only rename the **active** terminal, so a background tab is renamed the moment you click it.
- Requires terminal shell integration (on by default for zsh, bash, fish, PowerShell).
- **Kiro CLI / Amazon Q users:** Kiro's terminal autocomplete starts a fresh zsh that skips the editor's injected shell-integration file, so Cursor shows "Shell integration: Injection failed to activate" and Terminame never sees your commands. Keep Kiro and install shell integration manually by adding this to the end of `~/.zshrc`:

  ```zsh
  if [[ "$TERM_PROGRAM" == "vscode" && -z "$VSCODE_SHELL_INTEGRATION" ]] && command -v cursor >/dev/null 2>&1; then
    unset VSCODE_INJECTION
    . "$(cursor --locate-shell-integration-path zsh)"
  fi
  ```

  Then open a new terminal. Existing terminals keep the old shell until closed.
- If you rename a tab yourself, Terminame leaves it alone until it is closed.
- If you rename a tab by hand *before* Terminame has ever named it, and that tab is not the active one, Terminame's first queued rename may overwrite yours once. After Terminame has named a tab, your manual renames are respected.
- `terminame.aggressiveRename` is experimental: it has not been verified against the live VS Code API and can steal focus mid-typing.
- **Windows:** the Claude Code CLI lookup does not append `.exe`, so `claude.exe` is not found and that
  provider is skipped. Terminame falls back to the editor model, the Anthropic SDK, or rules.

## Development

Requires Node 20+.

    npm install
    npm run build        # bundle to dist/
    npm test             # unit tests (Vitest)
    npm run test:ext     # extension-host smoke tests (downloads a VS Code build on first run)
    npm run package      # build a .vsix
