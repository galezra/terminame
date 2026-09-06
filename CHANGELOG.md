# Changelog

## 0.1.0 — 2026-09-06

First release.

- Renames terminal tabs from the running command via shell integration.
- Naming providers, tried in order: editor language model (`vscode.lm`), Claude Code CLI (`claude -p`, uses your existing login), Anthropic SDK (env key or `ant auth login` profile, optional key in SecretStorage), built-in rules table.
- Instant mode by default: rules name immediately, model name when it arrives. 20 s model timeout.
- Per-command, per-folder name cache; user rules and ignore list; idle-name policy; experimental aggressive rename for background tabs.
- Known-limits recipe for Kiro CLI / Amazon Q users on Cursor.
