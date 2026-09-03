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

Answers are cached per command, so each distinct command costs one model call.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `terminame.enabled` | `true` | Master switch |
| `terminame.mode` | `waitForModel` | `instant` renames from rules first, then refines |
| `terminame.timeoutMs` | `6000` | Model timeout |
| `terminame.provider` | `auto` | Force `vscodeLm`, `claudeCli`, `anthropic`, or `rules` |
| `terminame.anthropic.model` | `claude-haiku-4-5` | Model for the SDK provider |
| `terminame.rules` | `[]` | Your own `{ "match": "make deploy*", "name": "Deploy" }` rows, checked first. `*` matches anything; `<host>` captures one word |
| `terminame.ignore` | `[]` | Extra commands that never rename |
| `terminame.idleName` | `keep` | `folder` or `shell` to revert when the command ends |
| `terminame.aggressiveRename` | `false` | Focus background tabs to rename them right away |

## Known limits

- VS Code can only rename the **active** terminal, so a background tab is renamed the moment you click it.
- Requires terminal shell integration (on by default for zsh, bash, fish, PowerShell).
- If you rename a tab yourself, Terminame leaves it alone until it is closed.
- If you rename a tab by hand *before* Terminame has ever named it, and that tab is not the active one, Terminame's first queued rename may overwrite yours once. After Terminame has named a tab, your manual renames are respected.

## Development

Requires Node 20+.

    npm install
    npm run build        # bundle to dist/
    npm test             # unit tests (Vitest)
    npm run test:ext     # extension-host smoke tests (downloads a VS Code build on first run)
    npm run package      # build a .vsix
