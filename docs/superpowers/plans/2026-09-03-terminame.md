# Terminame Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cursor/VS Code extension that renames each integrated-terminal tab from the command running in it, using a model the user is already logged into when one exists and a built-in rules table otherwise.

**Architecture:** Shell-integration events feed a `Namer` that checks a persistent cache, then a chain of `NameProvider`s (editor model → Claude Code CLI → Anthropic SDK), then a rules table. A `Renamer` applies names through the built-in rename command, queuing names for background terminals until they become active. All naming logic is `vscode`-free and unit-tested with Vitest; only `extension.ts`, `shellWatcher.ts`, `vscodeLm.ts` and the renamer host touch the `vscode` API.

**Tech Stack:** TypeScript 5, esbuild bundle, Vitest for unit tests, `@vscode/test-cli` + Mocha for extension-host smoke tests, `@anthropic-ai/sdk`, VS Code API `^1.93.0`.

**Spec:** `docs/superpowers/specs/2026-09-03-terminame-design.md`

## Global Constraints

- Node ≥ 20 and npm on PATH (they were missing in the authoring shell; Task 1 Step 0 checks).
- `engines.vscode` = `^1.93.0` (shell-execution events stable since 1.93). Target editor is Cursor 3.x.
- Default mode `waitForModel`; default `idleName` `keep`; default `timeoutMs` `6000`; default `aggressiveRename` `false`.
- SDK rung model default `claude-haiku-4-5`; Claude CLI rung uses `--model haiku`.
- Never read Claude Code's stored OAuth token. The CLI rung only spawns the `claude` binary.
- No modal dialogs from the extension. Diagnostics go to the "Terminame" output channel.
- Pure modules (`rules.ts`, `sanitize.ts`, `cache.ts`, `namer.ts`, `renamer.ts`, `providers/types.ts`, `providers/claudeCli.ts`, `providers/anthropicSdk.ts`) must not import `vscode`.
- Rename command: `workbench.action.terminal.renameWithArg` with args `{ name: string }`; it acts on the **active** terminal only.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File Structure

```
package.json                 manifest: commands, configuration, scripts
tsconfig.json                strict TS, CommonJS output for tests, esbuild for bundle
esbuild.mjs                  bundles src/extension.ts → dist/extension.js
vitest.config.ts             unit tests under test/unit
.vscode-test.mjs             extension-host tests under out/test/ext
.vscodeignore / .gitignore
src/extension.ts             activation, wiring, settings, commands, status bar
src/config.ts                typed reader for terminame.* settings
src/shellWatcher.ts          shell-execution events → CommandEvent
src/rules.ts                 normalise, pick segment, ignore list, rules table, fallback
src/sanitize.ts              model answer → tab-safe name
src/cache.ts                 NameCache over a Memento-shaped store
src/namer.ts                 cache → provider chain → sanitise → rules fallback
src/renamer.ts               per-terminal name state; active/background/user-owned
src/providers/types.ts       NameProvider interface, prompt text
src/providers/vscodeLm.ts    rung 1
src/providers/claudeCli.ts   rung 2 (spawns `claude -p`)
src/providers/anthropicSdk.ts rung 3
test/unit/*.test.ts          Vitest
test/ext/*.test.ts           Mocha, runs inside VS Code
test/fixtures/workspace/.vscode/settings.json   provider=rules for deterministic smoke test
```

---

### Task 1: Project scaffold that activates in Cursor

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`, `src/extension.ts`

**Interfaces:**
- Produces: `npm run build` → `dist/extension.js`; `npm test` runs Vitest; `npm run typecheck` runs `tsc --noEmit`.

- [ ] **Step 0: Verify toolchain**

Run: `node --version && npm --version`
Expected: `v20.x` or newer. If `command not found`, STOP and tell the user to install Node (e.g. `brew install node@20` or nvm) — do not install it yourself.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "terminame",
  "displayName": "Terminame",
  "description": "Auto-names terminal tabs from the command running in them",
  "version": "0.1.0",
  "publisher": "gal-ezra",
  "license": "MIT",
  "engines": { "vscode": "^1.93.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      { "command": "terminame.renameNow", "title": "Terminame: Rename current terminal now" },
      { "command": "terminame.clearCache", "title": "Terminame: Clear name cache" },
      { "command": "terminame.showLog", "title": "Terminame: Show log" },
      { "command": "terminame.setAnthropicApiKey", "title": "Terminame: Set Anthropic API key" }
    ],
    "configuration": {
      "title": "Terminame",
      "properties": {
        "terminame.enabled": { "type": "boolean", "default": true, "description": "Master switch." },
        "terminame.mode": { "type": "string", "enum": ["waitForModel", "instant"], "default": "waitForModel", "description": "waitForModel: rename once the model answers. instant: rename from rules first, then refine." },
        "terminame.timeoutMs": { "type": "number", "default": 6000, "minimum": 500, "description": "Model call timeout in milliseconds." },
        "terminame.provider": { "type": "string", "enum": ["auto", "vscodeLm", "claudeCli", "anthropic", "rules"], "default": "auto", "description": "Force a naming provider, or auto-detect." },
        "terminame.anthropic.model": { "type": "string", "default": "claude-haiku-4-5", "description": "Model for the Anthropic SDK provider." },
        "terminame.rules": {
          "type": "array", "default": [],
          "items": { "type": "object", "required": ["match", "name"], "properties": { "match": { "type": "string" }, "name": { "type": "string" } } },
          "description": "User rules checked before built-ins. `match` is a prefix pattern; `*` matches anything, `<word>` captures one word and can be reused in `name`."
        },
        "terminame.ignore": { "type": "array", "items": { "type": "string" }, "default": [], "description": "Extra first-words that never trigger a rename." },
        "terminame.idleName": { "type": "string", "enum": ["keep", "folder", "shell"], "default": "keep", "description": "Tab name after the command ends." },
        "terminame.aggressiveRename": { "type": "boolean", "default": false, "description": "Briefly focus background terminals to rename them immediately (causes a flicker)." }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "compile-tests": "tsc -p tsconfig.test.json",
    "test": "vitest run",
    "test:ext": "npm run build && npm run compile-tests && vscode-test",
    "package": "vsce package --no-dependencies"
  }
}
```

- [ ] **Step 2: Install dependencies (lets npm pick current versions)**

```bash
npm install -D typescript @types/node@20 @types/vscode@1.93 esbuild vitest @vscode/test-cli @vscode/test-electron mocha @types/mocha @vscode/vsce
npm install @anthropic-ai/sdk
```

- [ ] **Step 3: Create tsconfig.json and tsconfig.test.json**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "lib": ["ES2022"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vscode", "mocha"]
  },
  "include": ["src", "test"]
}
```

`tsconfig.test.json` (compiles extension-host tests to `out/`):
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "out", "rootDir": "." },
  "include": ["src", "test/ext"]
}
```

- [ ] **Step 4: Create esbuild.mjs**

```js
import { build, context } from "esbuild";

const opts = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(opts);
}
```

- [ ] **Step 5: Create vitest.config.ts, .gitignore, .vscodeignore**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/unit/**/*.test.ts"] } });
```

`.gitignore`:
```
node_modules/
dist/
out/
*.vsix
.vscode-test/
```

`.vscodeignore`:
```
**
!dist/**
!package.json
!README.md
!LICENSE
```

- [ ] **Step 6: Minimal extension.ts**

```ts
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Terminame");
  context.subscriptions.push(log);
  log.appendLine("Terminame activated");
}

export function deactivate(): void {}
```

- [ ] **Step 7: Build and typecheck**

Run: `npm run build && npm run typecheck`
Expected: `dist/extension.js` exists, no TS errors.

- [ ] **Step 8: Smoke-run in Cursor**

Run: `cursor --extensionDevelopmentPath=$PWD` (or `code` if that is the Cursor binary on PATH). In the new window open Output → Terminame. Expected: "Terminame activated".

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold terminame extension

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Rules module — normalise, segment, ignore, match, fallback

**Files:**
- Create: `src/rules.ts`, `test/unit/rules.test.ts`

**Interfaces:**
- Produces:
  - `interface Rule { match: string; name: string }`
  - `normalizeCommand(commandLine: string): string`
  - `pickSegment(commandLine: string): string`
  - `isIgnored(normalized: string, extraIgnore?: string[]): boolean`
  - `matchRules(normalized: string, userRules?: Rule[]): string | null`
  - `fallbackName(normalized: string): string`
  - `ruleName(normalized: string, userRules?: Rule[]): string`
  - `BUILTIN_RULES: Rule[]`, `BUILTIN_IGNORE: string[]`

- [ ] **Step 1: Write failing tests**

`test/unit/rules.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { normalizeCommand, pickSegment, isIgnored, matchRules, fallbackName, ruleName } from "../../src/rules";

describe("pickSegment", () => {
  it("uses the last segment of && / ; / || chains", () => {
    expect(pickSegment("npm install && npm run dev")).toBe("npm run dev");
    expect(pickSegment("cd api; pytest")).toBe("pytest");
    expect(pickSegment("make || echo failed")).toBe("echo failed");
  });
  it("uses the first segment of a pipeline", () => {
    expect(pickSegment("cat app.log | grep ERROR")).toBe("cat app.log");
  });
  it("chain wins over pipe", () => {
    expect(pickSegment("npm run build && tail -f out.log | grep x")).toBe("tail -f out.log");
  });
});

describe("normalizeCommand", () => {
  it("strips sudo/time/env and KEY=value prefixes", () => {
    expect(normalizeCommand("sudo npm run dev")).toBe("npm run dev");
    expect(normalizeCommand("NODE_ENV=dev PORT=3000 npm run dev")).toBe("npm run dev");
    expect(normalizeCommand("time pytest -q")).toBe("pytest -q");
  });
  it("drops trailing & and collapses whitespace", () => {
    expect(normalizeCommand("  npm   run dev &")).toBe("npm run dev");
  });
  it("applies segment selection", () => {
    expect(normalizeCommand("FOO=1 npm i && npm run dev")).toBe("npm run dev");
  });
});

describe("isIgnored", () => {
  it("ignores trivial commands and very short ones", () => {
    expect(isIgnored("ls -la")).toBe(true);
    expect(isIgnored("cd ..")).toBe(true);
    expect(isIgnored("clear")).toBe(true);
    expect(isIgnored("vi")).toBe(true);
    expect(isIgnored("")).toBe(true);
  });
  it("does not ignore real commands", () => {
    expect(isIgnored("npm run dev")).toBe(false);
  });
  it("honours extra ignore words", () => {
    expect(isIgnored("make lint", ["make"])).toBe(true);
  });
});

describe("matchRules", () => {
  it("matches built-in prefixes and wildcards", () => {
    expect(matchRules("npm run dev")).toBe("Start App");
    expect(matchRules("pnpm dev --host")).toBe("Start App");
    expect(matchRules("vitest --watch")).toBe("Tests");
    expect(matchRules("git rebase -i main")).toBe("Rebase");
    expect(matchRules("docker compose up -d")).toBe("Docker Up");
    expect(matchRules("npm install")).toBe("Install");
    expect(matchRules("npm i lodash")).toBe("Install");
    expect(matchRules("yarn")).toBe("Install");
  });
  it("does not match on partial words", () => {
    expect(matchRules("npm run development-report")).toBeNull();
    expect(matchRules("gitk")).toBeNull();
  });
  it("captures <word> placeholders", () => {
    expect(matchRules("ssh prod-1")).toBe("SSH prod-1");
  });
  it("checks user rules first", () => {
    expect(matchRules("npm run dev", [{ match: "npm run dev", name: "Dev Server" }])).toBe("Dev Server");
    expect(matchRules("make deploy", [{ match: "make deploy*", name: "Deploy" }])).toBe("Deploy");
  });
});

describe("fallbackName", () => {
  it("title-cases the first word and strips paths", () => {
    expect(fallbackName("terraform plan")).toBe("Terraform");
    expect(fallbackName("./scripts/deploy.sh staging")).toBe("Deploy.sh");
  });
});

describe("ruleName", () => {
  it("prefers a rule, else falls back", () => {
    expect(ruleName("npm test")).toBe("Tests");
    expect(ruleName("terraform plan")).toBe("Terraform");
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

Run: `npx vitest run test/unit/rules.test.ts`
Expected: FAIL — cannot resolve `../../src/rules`.

- [ ] **Step 3: Implement src/rules.ts**

```ts
export interface Rule {
  match: string;
  name: string;
}

export const BUILTIN_IGNORE = ["ls", "ll", "la", "cd", "pwd", "clear", "echo", "cat", "exit", "history", "which", "man"];

export const BUILTIN_RULES: Rule[] = [
  { match: "npm run dev*", name: "Start App" },
  { match: "npm start*", name: "Start App" },
  { match: "yarn dev*", name: "Start App" },
  { match: "yarn start*", name: "Start App" },
  { match: "pnpm dev*", name: "Start App" },
  { match: "pnpm start*", name: "Start App" },
  { match: "vite*", name: "Start App" },
  { match: "next dev*", name: "Start App" },
  { match: "python manage.py runserver*", name: "Start App" },
  { match: "rails s*", name: "Start App" },
  { match: "uvicorn*", name: "Start App" },
  { match: "flask run*", name: "Start App" },
  { match: "npm test*", name: "Tests" },
  { match: "npm run test*", name: "Tests" },
  { match: "yarn test*", name: "Tests" },
  { match: "pnpm test*", name: "Tests" },
  { match: "jest*", name: "Tests" },
  { match: "vitest*", name: "Tests" },
  { match: "pytest*", name: "Tests" },
  { match: "go test*", name: "Tests" },
  { match: "cargo test*", name: "Tests" },
  { match: "npm run build*", name: "Build" },
  { match: "yarn build*", name: "Build" },
  { match: "pnpm build*", name: "Build" },
  { match: "tsc*", name: "Build" },
  { match: "webpack*", name: "Build" },
  { match: "cargo build*", name: "Build" },
  { match: "go build*", name: "Build" },
  { match: "npm i*", name: "Install" },
  { match: "npm install*", name: "Install" },
  { match: "npm ci*", name: "Install" },
  { match: "yarn", name: "Install" },
  { match: "yarn install*", name: "Install" },
  { match: "pnpm i*", name: "Install" },
  { match: "pnpm install*", name: "Install" },
  { match: "pip install*", name: "Install" },
  { match: "git rebase*", name: "Rebase" },
  { match: "git merge*", name: "Merge" },
  { match: "git push*", name: "Push" },
  { match: "git pull*", name: "Pull" },
  { match: "git log*", name: "Git Log" },
  { match: "git status*", name: "Git Status" },
  { match: "docker compose up*", name: "Docker Up" },
  { match: "docker-compose up*", name: "Docker Up" },
  { match: "docker build*", name: "Docker Build" },
  { match: "ssh <host>*", name: "SSH <host>" },
  { match: "tail -f*", name: "Logs" },
  { match: "kubectl logs*", name: "Logs" },
  { match: "claude*", name: "Claude" },
  { match: "cursor-agent*", name: "Agent" },
  { match: "codex*", name: "Codex" },
];

const CHAIN_SPLIT = /\s*(?:&&|\|\||;)\s*/;
const PIPE_SPLIT = /\s*\|(?!\|)\s*/;
const PREFIX_STRIP = /^(?:(?:sudo|time|env|nohup)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

export function pickSegment(commandLine: string): string {
  const chain = commandLine.split(CHAIN_SPLIT).filter((s) => s.length > 0);
  const last = chain[chain.length - 1] ?? "";
  return last.split(PIPE_SPLIT)[0] ?? "";
}

export function normalizeCommand(commandLine: string): string {
  let s = commandLine.trim().replace(/\s*&\s*$/, "");
  s = pickSegment(s);
  s = s.replace(PREFIX_STRIP, "");
  return s.replace(/\s+/g, " ").trim();
}

export function isIgnored(normalized: string, extraIgnore: string[] = []): boolean {
  if (normalized.length < 3) return true;
  const first = normalized.split(" ")[0];
  return BUILTIN_IGNORE.includes(first) || extraIgnore.includes(first);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile "npm run dev*" / "ssh <host>*" into an anchored regex.
 * A trailing `*` means "optionally followed by more words" (a word boundary is required, so
 * `npm run dev*` matches `npm run dev --host` but not `npm run development`).
 * `<word>` captures one whitespace-free token into a named group.
 */
function compile(match: string): RegExp {
  const parts = match.split(/(\*|<[a-zA-Z]+>)/).filter(Boolean);
  const body = parts
    .map((p) => {
      if (p === "*") return "(?:\\s.*)?";
      const ph = /^<([a-zA-Z]+)>$/.exec(p);
      if (ph) return `(?<${ph[1]}>\\S+)`;
      return escapeRegex(p);
    })
    .join("");
  return new RegExp(`^${body}$`);
}

export function matchRules(normalized: string, userRules: Rule[] = []): string | null {
  for (const rule of [...userRules, ...BUILTIN_RULES]) {
    const m = compile(rule.match).exec(normalized);
    if (!m) continue;
    let name = rule.name;
    for (const [k, v] of Object.entries(m.groups ?? {})) {
      name = name.replace(`<${k}>`, v);
    }
    return name;
  }
  return null;
}

export function fallbackName(normalized: string): string {
  const first = normalized.split(" ")[0] ?? "";
  const base = first.split("/").pop() ?? first;
  if (!base) return "Terminal";
  return base[0].toUpperCase() + base.slice(1);
}

export function ruleName(normalized: string, userRules: Rule[] = []): string {
  return matchRules(normalized, userRules) ?? fallbackName(normalized);
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run test/unit/rules.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rules.ts test/unit/rules.test.ts
git commit -m "feat: rules table, normalisation and fallback naming

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Sanitizer for model answers

**Files:**
- Create: `src/sanitize.ts`, `test/unit/sanitize.test.ts`

**Interfaces:**
- Produces: `sanitizeName(raw: string): string | null` — null means "unusable, treat as a miss".

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { sanitizeName } from "../../src/sanitize";

describe("sanitizeName", () => {
  it("trims quotes, punctuation and takes the first line", () => {
    expect(sanitizeName('"Start App."\nBecause it runs the dev server')).toBe("Start App");
    expect(sanitizeName("**Rebase**")).toBe("Rebase");
  });
  it("caps at 3 words and 24 chars", () => {
    expect(sanitizeName("Start The Development Server Now")).toBe("Start The Development");
    expect(sanitizeName("Supercalifragilisticexpialidocious Build")).toBe("Supercalifragilisticexpi");
  });
  it("title-cases lowercase words but keeps acronyms", () => {
    expect(sanitizeName("api tests")).toBe("Api Tests");
    expect(sanitizeName("SSH prod")).toBe("SSH Prod");
  });
  it("returns null for empty or whitespace", () => {
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName('""')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run test/unit/sanitize.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
const MAX_WORDS = 3;
const MAX_CHARS = 24;

export function sanitizeName(raw: string): string | null {
  let s = (raw.split("\n")[0] ?? "").trim();
  s = s.replace(/^["'`*#\-\s]+/, "").replace(/["'`*.!?:;,\s]+$/, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const words = s.split(" ").slice(0, MAX_WORDS).map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w));
  s = words.join(" ");
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS).trimEnd();
  return s || null;
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/unit/sanitize.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/sanitize.ts test/unit/sanitize.test.ts
git commit -m "feat: sanitize model answers into tab names

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Persistent name cache

**Files:**
- Create: `src/cache.ts`, `test/unit/cache.test.ts`

**Interfaces:**
- Produces:
  - `interface KeyValueStore { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> }` — shape-compatible with `vscode.Memento`.
  - `class NameCache { constructor(store: KeyValueStore, opts?: { key?: string; max?: number }); get(command: string): string | undefined; set(command: string, name: string): Promise<void>; clear(): Promise<void>; size: number }`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { NameCache, KeyValueStore } from "../../src/cache";

function memStore(): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: <T>(k: string) => data[k] as T | undefined,
    update: async (k: string, v: unknown) => { data[k] = v; },
  };
}

describe("NameCache", () => {
  it("round-trips and persists to the store", async () => {
    const store = memStore();
    const c = new NameCache(store);
    await c.set("npm run dev", "Start App");
    expect(c.get("npm run dev")).toBe("Start App");
    expect(new NameCache(store).get("npm run dev")).toBe("Start App");
  });
  it("evicts oldest entries beyond max", async () => {
    const c = new NameCache(memStore(), { max: 2 });
    await c.set("a", "A"); await c.set("b", "B"); await c.set("c", "C");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe("C");
    expect(c.size).toBe(2);
  });
  it("clears", async () => {
    const c = new NameCache(memStore());
    await c.set("a", "A"); await c.clear();
    expect(c.get("a")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure** — `npx vitest run test/unit/cache.test.ts`

- [ ] **Step 3: Implement**

```ts
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

type Entries = Array<[string, string]>;

export class NameCache {
  private readonly key: string;
  private readonly max: number;
  private map: Map<string, string>;

  constructor(private readonly store: KeyValueStore, opts: { key?: string; max?: number } = {}) {
    this.key = opts.key ?? "terminame.names";
    this.max = opts.max ?? 500;
    this.map = new Map(store.get<Entries>(this.key) ?? []);
  }

  get size(): number { return this.map.size; }

  get(command: string): string | undefined { return this.map.get(command); }

  async set(command: string, name: string): Promise<void> {
    this.map.delete(command);
    this.map.set(command, name);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
    await this.store.update(this.key, [...this.map.entries()]);
  }

  async clear(): Promise<void> {
    this.map.clear();
    await this.store.update(this.key, []);
  }
}
```

- [ ] **Step 4: Run, expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/cache.ts test/unit/cache.test.ts
git commit -m "feat: persistent name cache

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Provider interface, prompt, and the Namer chain

**Files:**
- Create: `src/providers/types.ts`, `src/namer.ts`, `test/unit/namer.test.ts`

**Interfaces:**
- Consumes: `NameCache` (Task 4), `sanitizeName` (Task 3), `ruleName` (Task 2).
- Produces:
  - `type ProviderId = "vscodeLm" | "claudeCli" | "anthropic"`
  - `interface NameRequest { command: string; cwdBasename?: string }`
  - `interface NameProvider { readonly id: ProviderId; isAvailable(): Promise<boolean>; name(req: NameRequest, signal: AbortSignal): Promise<string | null> }`
  - `SYSTEM_PROMPT: string`, `userPrompt(req: NameRequest): string`
  - `interface NamerOptions { timeoutMs: number; maxFailures: number; forced: ProviderId | "rules" | "auto"; userRules: Rule[]; log: (msg: string) => void }`
  - `type NameSource = "cache" | "model" | "rules"`
  - `class Namer { constructor(providers: NameProvider[], cache: NameCache, opts: NamerOptions); init(): Promise<ProviderId | "rules">; readonly activeId: ProviderId | "rules"; rulesName(command: string): string; name(req: NameRequest, signal: AbortSignal): Promise<{ name: string; source: NameSource } | null> }` — returns null only when `signal` aborted.

- [ ] **Step 1: Create src/providers/types.ts**

```ts
export type ProviderId = "vscodeLm" | "claudeCli" | "anthropic";

export interface NameRequest {
  command: string;
  cwdBasename?: string;
}

export interface NameProvider {
  readonly id: ProviderId;
  isAvailable(): Promise<boolean>;
  /** Return the raw model answer, or null if the provider could not answer. Must reject/return promptly when `signal` aborts. */
  name(req: NameRequest, signal: AbortSignal): Promise<string | null>;
}

export const SYSTEM_PROMPT =
  "You name terminal tabs. Given a shell command and the folder it runs in, reply with only a short title of 1 to 3 words that a developer would recognise at a glance. " +
  "Examples: `npm run dev` → Start App. `git rebase -i main` → Rebase. `docker compose up` → Docker Up. `pytest tests/api` → API Tests. " +
  "No punctuation, no explanation.";

export function userPrompt(req: NameRequest): string {
  const folder = req.cwdBasename ? `\nFolder: ${req.cwdBasename}` : "";
  return `Command: ${req.command}${folder}`;
}
```

- [ ] **Step 2: Failing tests for Namer**

`test/unit/namer.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { Namer, NamerOptions } from "../../src/namer";
import { NameCache, KeyValueStore } from "../../src/cache";
import { NameProvider, ProviderId } from "../../src/providers/types";

function store(): KeyValueStore {
  const d: Record<string, unknown> = {};
  return { get: <T>(k: string) => d[k] as T | undefined, update: async (k, v) => { d[k] = v; } };
}

function fake(id: ProviderId, opts: { available?: boolean; answer?: string | null | Error; delayMs?: number } = {}): NameProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    isAvailable: async () => opts.available ?? true,
    name: (_req: unknown, signal: AbortSignal) =>
      new Promise<string | null>((resolve, reject) => {
        p.calls++;
        const t = setTimeout(() => {
          if (opts.answer instanceof Error) reject(opts.answer);
          else resolve(opts.answer ?? "Model Name");
        }, opts.delayMs ?? 0);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
      }),
  };
  return p;
}

const base = (over: Partial<NamerOptions> = {}): NamerOptions => ({
  timeoutMs: 50, maxFailures: 3, forced: "auto", userRules: [], log: () => {}, ...over,
});

describe("Namer.init", () => {
  it("picks the first available provider in order", async () => {
    const n = new Namer([fake("vscodeLm", { available: false }), fake("claudeCli"), fake("anthropic")], new NameCache(store()), base());
    expect(await n.init()).toBe("claudeCli");
  });
  it("returns rules when none available", async () => {
    const n = new Namer([fake("vscodeLm", { available: false })], new NameCache(store()), base());
    expect(await n.init()).toBe("rules");
  });
  it("honours a forced provider and forced rules", async () => {
    expect(await new Namer([fake("vscodeLm"), fake("anthropic")], new NameCache(store()), base({ forced: "anthropic" })).init()).toBe("anthropic");
    expect(await new Namer([fake("vscodeLm")], new NameCache(store()), base({ forced: "rules" })).init()).toBe("rules");
  });
});

describe("Namer.name", () => {
  it("uses cache first", async () => {
    const p = fake("claudeCli");
    const cache = new NameCache(store());
    await cache.set("npm run dev", "Cached");
    const n = new Namer([p], cache, base()); await n.init();
    expect(await n.name({ command: "npm run dev" }, new AbortController().signal)).toEqual({ name: "Cached", source: "cache" });
    expect(p.calls).toBe(0);
  });
  it("uses the model, sanitises, and caches", async () => {
    const p = fake("claudeCli", { answer: '"dev server."' });
    const cache = new NameCache(store());
    const n = new Namer([p], cache, base()); await n.init();
    expect(await n.name({ command: "npm run dev" }, new AbortController().signal)).toEqual({ name: "Dev Server", source: "model" });
    expect(cache.get("npm run dev")).toBe("Dev Server");
  });
  it("falls back to rules on timeout without caching", async () => {
    const p = fake("claudeCli", { delayMs: 500 });
    const cache = new NameCache(store());
    const n = new Namer([p], cache, base({ timeoutMs: 20 })); await n.init();
    expect(await n.name({ command: "npm run dev" }, new AbortController().signal)).toEqual({ name: "Start App", source: "rules" });
    expect(cache.get("npm run dev")).toBeUndefined();
  });
  it("returns null when the caller aborts", async () => {
    const p = fake("claudeCli", { delayMs: 500 });
    const n = new Namer([p], new NameCache(store()), base({ timeoutMs: 1000 })); await n.init();
    const ac = new AbortController();
    const pending = n.name({ command: "npm run dev" }, ac.signal);
    ac.abort();
    expect(await pending).toBeNull();
  });
  it("disables a provider after maxFailures and advances to the next", async () => {
    const bad = fake("vscodeLm", { answer: new Error("boom") });
    const good = fake("claudeCli", { answer: "Good" });
    const n = new Namer([bad, good], new NameCache(store()), base({ maxFailures: 2 })); await n.init();
    const sig = () => new AbortController().signal;
    expect((await n.name({ command: "terraform plan" }, sig()))!.source).toBe("rules");
    expect((await n.name({ command: "terraform apply" }, sig()))!.source).toBe("rules");
    expect(n.activeId).toBe("claudeCli");
    expect(await n.name({ command: "terraform destroy" }, sig())).toEqual({ name: "Good", source: "model" });
  });
  it("uses rules when no provider", async () => {
    const n = new Namer([], new NameCache(store()), base()); await n.init();
    expect(await n.name({ command: "terraform plan" }, new AbortController().signal)).toEqual({ name: "Terraform", source: "rules" });
  });
});
```

- [ ] **Step 3: Run, expect failure** — `npx vitest run test/unit/namer.test.ts`

- [ ] **Step 4: Implement src/namer.ts**

```ts
import { NameCache } from "./cache";
import { Rule, ruleName } from "./rules";
import { sanitizeName } from "./sanitize";
import { NameProvider, NameRequest, ProviderId } from "./providers/types";

export type NameSource = "cache" | "model" | "rules";

export interface NamerOptions {
  timeoutMs: number;
  maxFailures: number;
  forced: ProviderId | "rules" | "auto";
  userRules: Rule[];
  log: (msg: string) => void;
}

export class Namer {
  private active: NameProvider | null = null;
  private remaining: NameProvider[] = [];
  private failures = 0;

  constructor(private readonly providers: NameProvider[], private readonly cache: NameCache, private opts: NamerOptions) {}

  get activeId(): ProviderId | "rules" { return this.active?.id ?? "rules"; }

  updateOptions(opts: Partial<NamerOptions>): void { this.opts = { ...this.opts, ...opts }; }

  rulesName(command: string): string { return ruleName(command, this.opts.userRules); }

  async init(): Promise<ProviderId | "rules"> {
    if (this.opts.forced === "rules") { this.active = null; this.remaining = []; return "rules"; }
    this.remaining = this.opts.forced === "auto" ? [...this.providers] : this.providers.filter((p) => p.id === this.opts.forced);
    await this.advance();
    return this.activeId;
  }

  /** Probe the remaining providers in order; set the first available one as active. */
  private async advance(): Promise<void> {
    this.active = null;
    this.failures = 0;
    while (this.remaining.length > 0) {
      const p = this.remaining.shift()!;
      try {
        if (await p.isAvailable()) { this.active = p; this.opts.log(`provider: ${p.id}`); return; }
        this.opts.log(`provider ${p.id} unavailable`);
      } catch (e) {
        this.opts.log(`provider ${p.id} probe failed: ${String(e)}`);
      }
    }
    this.opts.log("provider: rules only");
  }

  async name(req: NameRequest, signal: AbortSignal): Promise<{ name: string; source: NameSource } | null> {
    const cached = this.cache.get(req.command);
    if (cached) return { name: cached, source: "cache" };
    if (!this.active) return { name: this.rulesName(req.command), source: "rules" };

    const provider = this.active;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]);
    let raw: string | null = null;
    try {
      raw = await provider.name(req, combined);
    } catch (e) {
      if (signal.aborted) return null;
      this.opts.log(`provider ${provider.id} error: ${String(e)}`);
    }
    if (signal.aborted) return null;

    const clean = raw ? sanitizeName(raw) : null;
    if (clean) {
      this.failures = 0;
      await this.cache.set(req.command, clean);
      return { name: clean, source: "model" };
    }

    this.failures++;
    this.opts.log(`provider ${provider.id} miss (${this.failures}/${this.opts.maxFailures})`);
    if (this.failures >= this.opts.maxFailures) {
      this.opts.log(`provider ${provider.id} disabled for this session`);
      await this.advance();
    }
    return { name: this.rulesName(req.command), source: "rules" };
  }
}
```

- [ ] **Step 5: Run, expect pass** — `npx vitest run test/unit/namer.test.ts`. Note: `AbortSignal.any` needs Node ≥ 20.3; if Vitest runs on an older Node the timeout test fails with "any is not a function" — upgrade Node, do not polyfill.

- [ ] **Step 6: Commit**

```bash
git add src/providers/types.ts src/namer.ts test/unit/namer.test.ts
git commit -m "feat: provider interface and namer fallback chain

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Claude Code CLI provider

**Files:**
- Create: `src/providers/claudeCli.ts`, `test/unit/claudeCli.test.ts`

**Interfaces:**
- Consumes: `NameProvider`, `NameRequest`, `SYSTEM_PROMPT`, `userPrompt` (Task 5).
- Produces:
  - `type Runner = (file: string, args: string[], opts: { cwd: string; signal: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; code: number | null }>`
  - `findBinary(name: string, extraDirs?: string[]): Promise<string | null>`
  - `class ClaudeCliProvider implements NameProvider { constructor(run?: Runner, find?: typeof findBinary) }`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { ClaudeCliProvider, Runner } from "../../src/providers/claudeCli";

function runner(result: { stdout: string; code: number | null }, capture: { args?: string[]; cwd?: string } = {}): Runner {
  return async (_file, args, opts) => { capture.args = args; capture.cwd = opts.cwd; return result; };
}

describe("ClaudeCliProvider", () => {
  it("is unavailable when the binary is not found", async () => {
    const p = new ClaudeCliProvider(runner({ stdout: "", code: 0 }), async () => null);
    expect(await p.isAvailable()).toBe(false);
  });
  it("is available when found and --version succeeds", async () => {
    const p = new ClaudeCliProvider(runner({ stdout: "1.0.0", code: 0 }), async () => "/usr/local/bin/claude");
    expect(await p.isAvailable()).toBe(true);
  });
  it("calls claude -p with haiku and text output, from the home dir", async () => {
    const cap: { args?: string[]; cwd?: string } = {};
    const p = new ClaudeCliProvider(runner({ stdout: "Start App\n", code: 0 }, cap), async () => "/usr/local/bin/claude");
    await p.isAvailable();
    const out = await p.name({ command: "npm run dev", cwdBasename: "web" }, new AbortController().signal);
    expect(out).toBe("Start App\n");
    expect(cap.args).toEqual(expect.arrayContaining(["-p", "--model", "haiku", "--output-format", "text"]));
    expect(cap.args!.join(" ")).toContain("Command: npm run dev");
    expect(cap.cwd).not.toContain("web");
  });
  it("returns null on non-zero exit", async () => {
    const p = new ClaudeCliProvider(runner({ stdout: "", code: 1 }), async () => "/usr/local/bin/claude");
    await p.isAvailable();
    expect(await p.name({ command: "x y z" }, new AbortController().signal)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure** — `npx vitest run test/unit/claudeCli.test.ts`

- [ ] **Step 3: Implement**

```ts
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { NameProvider, NameRequest, SYSTEM_PROMPT, userPrompt } from "./types";

export type Runner = (
  file: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; code: number | null }>;

export const defaultRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd: opts.cwd, signal: opts.signal, env: opts.env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ABORT_ERR") return reject(err);
      if (err && typeof (err as { code?: unknown }).code === "number") return resolve({ stdout: String(stdout), code: (err as { code: number }).code });
      if (err) return reject(err);
      resolve({ stdout: String(stdout), code: 0 });
    });
  });

/** GUI-launched extension hosts often have a short PATH; also look where Claude Code and Homebrew install. */
export async function findBinary(name: string, extraDirs: string[] = []): Promise<string | null> {
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...extraDirs,
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

export class ClaudeCliProvider implements NameProvider {
  readonly id = "claudeCli" as const;
  private bin: string | null = null;

  constructor(private readonly run: Runner = defaultRunner, private readonly find: typeof findBinary = findBinary) {}

  private env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.CLAUDECODE; // allow running even if the host itself was launched from Claude Code
    return env;
  }

  async isAvailable(): Promise<boolean> {
    this.bin = await this.find("claude");
    if (!this.bin) return false;
    try {
      const r = await this.run(this.bin, ["--version"], { cwd: homedir(), signal: AbortSignal.timeout(5000), env: this.env() });
      return r.code === 0;
    } catch { return false; }
  }

  async name(req: NameRequest, signal: AbortSignal): Promise<string | null> {
    if (!this.bin) return null;
    const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt(req)}`;
    const r = await this.run(this.bin, ["-p", prompt, "--model", "haiku", "--output-format", "text"], { cwd: homedir(), signal, env: this.env() });
    return r.code === 0 ? r.stdout : null;
  }
}
```

`cwd: homedir()` is deliberate: running from the project folder would make Claude Code load that project's `CLAUDE.md`, slowing the call and spending quota.

- [ ] **Step 4: Run, expect pass**

- [ ] **Step 5: Manual check (only if `claude` is installed here)**

```bash
claude -p "You name terminal tabs. Reply with 1-3 words only. Command: npm run dev" --model haiku --output-format text
```
Expected: a short title such as `Start App`. This confirms the flags are valid for the installed CLI version. If `--output-format` is rejected, drop it (text is the default for `-p`).

- [ ] **Step 6: Commit**

```bash
git add src/providers/claudeCli.ts test/unit/claudeCli.test.ts
git commit -m "feat: Claude Code CLI naming provider

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Anthropic SDK provider

**Files:**
- Create: `src/providers/anthropicSdk.ts`, `test/unit/anthropicSdk.test.ts`

**Interfaces:**
- Consumes: Task 5 types.
- Produces: `class AnthropicSdkProvider implements NameProvider { constructor(deps: { getApiKey: () => Promise<string | undefined>; getModel: () => string; createClient?: (apiKey?: string) => AnthropicLike }) }` where `AnthropicLike` is the subset `{ models: { retrieve(id: string, opts?: { signal?: AbortSignal }): Promise<unknown> }; messages: { create(params: MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Message> } }` typed from `@anthropic-ai/sdk`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { AnthropicSdkProvider, AnthropicLike } from "../../src/providers/anthropicSdk";

function fakeClient(opts: { retrieveOk?: boolean; text?: string } = {}): AnthropicLike & { lastParams?: unknown } {
  const c: AnthropicLike & { lastParams?: unknown } = {
    models: { retrieve: async () => { if (opts.retrieveOk === false) throw new Error("401"); return {}; } },
    messages: {
      create: async (params) => {
        c.lastParams = params;
        return { content: [{ type: "text", text: opts.text ?? "Start App" }], stop_reason: "end_turn" } as never;
      },
    },
  };
  return c;
}

describe("AnthropicSdkProvider", () => {
  it("is unavailable when the client cannot be constructed", async () => {
    const p = new AnthropicSdkProvider({ getApiKey: async () => undefined, getModel: () => "claude-haiku-4-5", createClient: () => { throw new Error("no key"); } });
    expect(await p.isAvailable()).toBe(false);
  });
  it("is unavailable when the probe request fails", async () => {
    const p = new AnthropicSdkProvider({ getApiKey: async () => "k", getModel: () => "claude-haiku-4-5", createClient: () => fakeClient({ retrieveOk: false }) });
    expect(await p.isAvailable()).toBe(false);
  });
  it("sends system + user prompt to the configured model and returns text", async () => {
    const client = fakeClient({ text: "Dev Server" });
    const p = new AnthropicSdkProvider({ getApiKey: async () => "k", getModel: () => "claude-haiku-4-5", createClient: () => client });
    expect(await p.isAvailable()).toBe(true);
    const out = await p.name({ command: "npm run dev", cwdBasename: "web" }, new AbortController().signal);
    expect(out).toBe("Dev Server");
    const params = client.lastParams as { model: string; system: string; messages: Array<{ content: string }> };
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.system).toContain("You name terminal tabs");
    expect(params.messages[0].content).toContain("Folder: web");
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { NameProvider, NameRequest, SYSTEM_PROMPT, userPrompt } from "./types";

export interface AnthropicLike {
  models: { retrieve(id: string, opts?: { signal?: AbortSignal }): Promise<unknown> };
  messages: { create(params: MessageCreateParamsNonStreaming, opts?: { signal?: AbortSignal }): Promise<Message> };
}

export interface AnthropicSdkDeps {
  /** Optional key from SecretStorage. When undefined the SDK resolves env vars or an `ant auth login` profile itself. */
  getApiKey: () => Promise<string | undefined>;
  getModel: () => string;
  createClient?: (apiKey?: string) => AnthropicLike;
}

const defaultCreateClient = (apiKey?: string): AnthropicLike =>
  (apiKey ? new Anthropic({ apiKey }) : new Anthropic()) as unknown as AnthropicLike;

export class AnthropicSdkProvider implements NameProvider {
  readonly id = "anthropic" as const;
  private client: AnthropicLike | null = null;

  constructor(private readonly deps: AnthropicSdkDeps) {}

  async isAvailable(): Promise<boolean> {
    try {
      const client = (this.deps.createClient ?? defaultCreateClient)(await this.deps.getApiKey());
      await client.models.retrieve(this.deps.getModel(), { signal: AbortSignal.timeout(5000) });
      this.client = client;
      return true;
    } catch {
      this.client = null;
      return false;
    }
  }

  async name(req: NameRequest, signal: AbortSignal): Promise<string | null> {
    if (!this.client) return null;
    const res = await this.client.messages.create(
      {
        model: this.deps.getModel(),
        max_tokens: 32,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt(req) }],
      },
      { signal },
    );
    if (res.stop_reason === "refusal") return null;
    const text = res.content.find((b) => b.type === "text");
    return text && text.type === "text" ? text.text : null;
  }
}
```

If `@anthropic-ai/sdk/resources/messages` does not resolve in the installed SDK version, import the types as `Anthropic.Message` / `Anthropic.MessageCreateParamsNonStreaming` from the default export namespace instead.

- [ ] **Step 4: Run, expect pass**; also `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/anthropicSdk.ts test/unit/anthropicSdk.test.ts
git commit -m "feat: Anthropic SDK naming provider

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Editor language-model provider (vscode.lm)

**Files:**
- Create: `src/providers/vscodeLm.ts`

**Interfaces:**
- Consumes: Task 5 types.
- Produces: `class VscodeLmProvider implements NameProvider`.

No unit test: this file is a thin adapter over `vscode.lm`; it is exercised by the Task 11 manual check.

- [ ] **Step 1: Implement**

```ts
import * as vscode from "vscode";
import { NameProvider, NameRequest, SYSTEM_PROMPT, userPrompt } from "./types";

export class VscodeLmProvider implements NameProvider {
  readonly id = "vscodeLm" as const;
  private model: vscode.LanguageModelChat | undefined;

  async isAvailable(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels();
      this.model = models[0];
      return this.model !== undefined;
    } catch {
      return false;
    }
  }

  async name(req: NameRequest, signal: AbortSignal): Promise<string | null> {
    if (!this.model) return null;
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.model.sendRequest(
        [vscode.LanguageModelChatMessage.User(`${SYSTEM_PROMPT}\n\n${userPrompt(req)}`)],
        {},
        cts.token,
      );
      let out = "";
      for await (const chunk of response.text) out += chunk;
      return out;
    } catch (e) {
      // NoPermissions (user declined the one-time consent) or NotFound — treat as a miss; Namer's three-strikes handles the rest.
      if (e instanceof vscode.LanguageModelError) return null;
      throw e;
    } finally {
      signal.removeEventListener("abort", onAbort);
      cts.dispose();
    }
  }
}
```

Note: the first `sendRequest` from a new extension triggers VS Code's own one-time consent dialog. That dialog is the platform's, not ours, and is allowed.

- [ ] **Step 2: Typecheck** — `npm run typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/providers/vscodeLm.ts
git commit -m "feat: vscode.lm naming provider

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Renamer — active/background/user-owned state

**Files:**
- Create: `src/renamer.ts`, `test/unit/renamer.test.ts`

**Interfaces:**
- Produces:
  - `type IdleName = "keep" | "folder" | "shell"`
  - `interface RenamerHost<T> { activeTerminal(): T | undefined; currentName(t: T): string; rename(t: T, name: string): Promise<void>; focus(t: T): void }` — `rename` may assume `t` is active.
  - `class Renamer<T extends object> { constructor(host: RenamerHost<T>, opts: { aggressive: boolean }); setName(t: T, name: string): Promise<void>; onActiveChanged(t: T | undefined): Promise<void>; onCommandEnd(t: T, idle: IdleName, cwdBasename?: string): Promise<void>; forget(t: T): void; isUserOwned(t: T): boolean }`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest";
import { Renamer, RenamerHost } from "../../src/renamer";

type Term = { id: string };

function host(active: { t?: Term }): RenamerHost<Term> & { names: Map<string, string>; renames: string[]; focused: string[] } {
  const names = new Map<string, string>();
  const h = {
    names, renames: [] as string[], focused: [] as string[],
    activeTerminal: () => active.t,
    currentName: (t: Term) => names.get(t.id) ?? "zsh",
    rename: async (t: Term, n: string) => { names.set(t.id, n); h.renames.push(`${t.id}=${n}`); },
    focus: (t: Term) => { h.focused.push(t.id); active.t = t; },
  };
  return h;
}

describe("Renamer", () => {
  const a: Term = { id: "a" }, b: Term = { id: "b" };

  it("renames the active terminal immediately", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    expect(h.names.get("a")).toBe("Start App");
  });
  it("queues for a background terminal and applies when it becomes active", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(b, "Tests");
    expect(h.names.get("b")).toBeUndefined();
    await r.onActiveChanged(b);
    expect(h.names.get("b")).toBe("Tests");
  });
  it("aggressive mode focuses, renames, and restores focus", async () => {
    const act = { t: a }; const h = host(act); const r = new Renamer(h, { aggressive: true });
    await r.setName(b, "Tests");
    expect(h.names.get("b")).toBe("Tests");
    expect(h.focused).toEqual(["b", "a"]);
  });
  it("stops renaming a terminal the user renamed by hand", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    h.names.set("a", "my server");           // user rename
    await r.setName(a, "Tests");
    expect(h.names.get("a")).toBe("my server");
    expect(r.isUserOwned(a)).toBe(true);
  });
  it("does not treat its own previous name or the shell default as user-owned", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    await r.setName(a, "Tests");
    expect(h.names.get("a")).toBe("Tests");
    expect(r.isUserOwned(a)).toBe(false);
  });
  it("onCommandEnd honours idleName", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(a, "Start App");
    await r.onCommandEnd(a, "keep", "web"); expect(h.names.get("a")).toBe("Start App");
    await r.onCommandEnd(a, "folder", "web"); expect(h.names.get("a")).toBe("web");
    await r.onCommandEnd(a, "shell"); expect(h.names.get("a")).toBe("zsh");
  });
  it("forget drops pending names", async () => {
    const h = host({ t: a }); const r = new Renamer(h, { aggressive: false });
    await r.setName(b, "Tests"); r.forget(b); await r.onActiveChanged(b);
    expect(h.names.get("b")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

- [ ] **Step 3: Implement**

```ts
export type IdleName = "keep" | "folder" | "shell";

export interface RenamerHost<T> {
  activeTerminal(): T | undefined;
  currentName(t: T): string;
  /** Apply a name. Callers guarantee `t` is the active terminal. */
  rename(t: T, name: string): Promise<void>;
  focus(t: T): void;
}

interface State {
  original: string;   // name before we ever touched it (e.g. "zsh")
  applied?: string;   // last name we set
  pending?: string;   // name waiting for the terminal to become active
  userOwned: boolean;
}

export class Renamer<T extends object> {
  private readonly state = new WeakMap<T, State>();

  constructor(private readonly host: RenamerHost<T>, private opts: { aggressive: boolean }) {}

  updateOptions(opts: { aggressive: boolean }): void { this.opts = opts; }

  private stateFor(t: T): State {
    let s = this.state.get(t);
    if (!s) { s = { original: this.host.currentName(t), userOwned: false }; this.state.set(t, s); }
    return s;
  }

  isUserOwned(t: T): boolean { return this.state.get(t)?.userOwned ?? false; }

  private detectUserRename(t: T, s: State): boolean {
    const current = this.host.currentName(t);
    if (s.applied !== undefined && current !== s.applied && current !== s.original) {
      s.userOwned = true;
      s.pending = undefined;
    }
    return s.userOwned;
  }

  async setName(t: T, name: string): Promise<void> {
    const s = this.stateFor(t);
    if (this.detectUserRename(t, s)) return;
    if (this.host.activeTerminal() === t) {
      await this.apply(t, s, name);
      return;
    }
    if (this.opts.aggressive) {
      const previous = this.host.activeTerminal();
      this.host.focus(t);
      await this.apply(t, s, name);
      if (previous) this.host.focus(previous);
      return;
    }
    s.pending = name;
  }

  private async apply(t: T, s: State, name: string): Promise<void> {
    await this.host.rename(t, name);
    s.applied = name;
    s.pending = undefined;
  }

  async onActiveChanged(t: T | undefined): Promise<void> {
    if (!t) return;
    const s = this.state.get(t);
    if (!s || s.pending === undefined) return;
    if (this.detectUserRename(t, s)) return;
    await this.apply(t, s, s.pending);
  }

  async onCommandEnd(t: T, idle: IdleName, cwdBasename?: string): Promise<void> {
    if (idle === "keep") return;
    const s = this.stateFor(t);
    const target = idle === "folder" ? (cwdBasename ?? s.original) : s.original;
    await this.setName(t, target);
  }

  forget(t: T): void { this.state.delete(t); }
}
```

- [ ] **Step 4: Run, expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/renamer.ts test/unit/renamer.test.ts
git commit -m "feat: renamer with background queue and user-rename detection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Config reader, shell watcher, and extension wiring

**Files:**
- Create: `src/config.ts`, `src/shellWatcher.ts`
- Modify: `src/extension.ts` (replace the Task 1 stub entirely)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `interface TerminameConfig { enabled: boolean; mode: "waitForModel" | "instant"; timeoutMs: number; provider: ProviderId | "rules" | "auto"; anthropicModel: string; rules: Rule[]; ignore: string[]; idleName: IdleName; aggressiveRename: boolean }`, `readConfig(): TerminameConfig`
  - `interface CommandEvent { terminal: vscode.Terminal; commandLine: string; cwdBasename?: string }`, `watchShell(handlers: { onStart(e: CommandEvent): void; onEnd(e: CommandEvent & { exitCode?: number }): void }): vscode.Disposable`

- [ ] **Step 1: src/config.ts**

```ts
import * as vscode from "vscode";
import { Rule } from "./rules";
import { IdleName } from "./renamer";
import { ProviderId } from "./providers/types";

export interface TerminameConfig {
  enabled: boolean;
  mode: "waitForModel" | "instant";
  timeoutMs: number;
  provider: ProviderId | "rules" | "auto";
  anthropicModel: string;
  rules: Rule[];
  ignore: string[];
  idleName: IdleName;
  aggressiveRename: boolean;
}

export function readConfig(): TerminameConfig {
  const c = vscode.workspace.getConfiguration("terminame");
  return {
    enabled: c.get<boolean>("enabled", true),
    mode: c.get<"waitForModel" | "instant">("mode", "waitForModel"),
    timeoutMs: c.get<number>("timeoutMs", 6000),
    provider: c.get<ProviderId | "rules" | "auto">("provider", "auto"),
    anthropicModel: c.get<string>("anthropic.model", "claude-haiku-4-5"),
    rules: c.get<Rule[]>("rules", []),
    ignore: c.get<string[]>("ignore", []),
    idleName: c.get<IdleName>("idleName", "keep"),
    aggressiveRename: c.get<boolean>("aggressiveRename", false),
  };
}
```

- [ ] **Step 2: src/shellWatcher.ts**

```ts
import * as vscode from "vscode";
import { basename } from "node:path";

export interface CommandEvent {
  terminal: vscode.Terminal;
  commandLine: string;
  cwdBasename?: string;
}

export interface ShellHandlers {
  onStart(e: CommandEvent): void;
  onEnd(e: CommandEvent & { exitCode?: number }): void;
}

function toEvent(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): CommandEvent {
  return {
    terminal,
    commandLine: execution.commandLine.value,
    cwdBasename: execution.cwd ? basename(execution.cwd.fsPath) : undefined,
  };
}

export function watchShell(handlers: ShellHandlers): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.window.onDidStartTerminalShellExecution((e) => handlers.onStart(toEvent(e.terminal, e.execution))),
    vscode.window.onDidEndTerminalShellExecution((e) => handlers.onEnd({ ...toEvent(e.terminal, e.execution), exitCode: e.exitCode })),
  );
}
```

- [ ] **Step 3: Replace src/extension.ts**

```ts
import * as vscode from "vscode";
import { readConfig, TerminameConfig } from "./config";
import { NameCache } from "./cache";
import { Namer } from "./namer";
import { Renamer, RenamerHost } from "./renamer";
import { isIgnored, normalizeCommand } from "./rules";
import { watchShell } from "./shellWatcher";
import { VscodeLmProvider } from "./providers/vscodeLm";
import { ClaudeCliProvider } from "./providers/claudeCli";
import { AnthropicSdkProvider } from "./providers/anthropicSdk";

const API_KEY_SECRET = "terminame.anthropic.apiKey";
const HINT_SHOWN_KEY = "terminame.hint.shellIntegrationShown";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel("Terminame");
  context.subscriptions.push(log);
  let config = readConfig();

  const cache = new NameCache(context.globalState);
  const providers = [
    new VscodeLmProvider(),
    new ClaudeCliProvider(),
    new AnthropicSdkProvider({
      getApiKey: () => context.secrets.get(API_KEY_SECRET),
      getModel: () => config.anthropicModel,
    }),
  ];
  const namer = new Namer(providers, cache, {
    timeoutMs: config.timeoutMs,
    maxFailures: 3,
    forced: config.provider,
    userRules: config.rules,
    log: (m) => log.appendLine(`[${new Date().toISOString()}] ${m}`),
  });

  const host: RenamerHost<vscode.Terminal> = {
    activeTerminal: () => vscode.window.activeTerminal,
    currentName: (t) => t.name,
    rename: async (_t, name) => { await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name }); },
    focus: (t) => t.show(true),
  };
  const renamer = new Renamer<vscode.Terminal>(host, { aggressive: config.aggressiveRename });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = "terminame.showLog";
  context.subscriptions.push(status);
  const refreshStatus = () => {
    if (namer.activeId === "rules") {
      status.text = "$(terminal) Terminame: rules";
      status.tooltip = "Terminame is naming tabs with built-in rules. Install Claude Code (and run /login) or sign in to Copilot for smarter names.";
      status.show();
    } else {
      status.hide();
    }
  };

  const inflight = new WeakMap<vscode.Terminal, AbortController>();
  const seenExecution = new WeakSet<vscode.Terminal>();

  async function handleStart(terminal: vscode.Terminal, commandLine: string, cwdBasename?: string): Promise<void> {
    seenExecution.add(terminal);
    if (!config.enabled || renamer.isUserOwned(terminal)) return;
    const command = normalizeCommand(commandLine);
    if (isIgnored(command, config.ignore)) return;

    inflight.get(terminal)?.abort();
    const ac = new AbortController();
    inflight.set(terminal, ac);

    if (config.mode === "instant" && namer.activeId !== "rules") {
      await renamer.setName(terminal, namer.rulesName(command));
    }
    const result = await namer.name({ command, cwdBasename }, ac.signal);
    if (!result || ac.signal.aborted) return;
    log.appendLine(`"${command}" → "${result.name}" (${result.source})`);
    await renamer.setName(terminal, result.name);
    refreshStatus();
  }

  context.subscriptions.push(
    watchShell({
      onStart: (e) => { void handleStart(e.terminal, e.commandLine, e.cwdBasename); },
      onEnd: (e) => { void renamer.onCommandEnd(e.terminal, config.idleName, e.cwdBasename); },
    }),
    vscode.window.onDidChangeActiveTerminal((t) => { void renamer.onActiveChanged(t); }),
    vscode.window.onDidCloseTerminal((t) => { inflight.get(t)?.abort(); inflight.delete(t); renamer.forget(t); }),
    vscode.window.onDidOpenTerminal((t) => {
      // Shell-integration hint: if the first command never produces an execution event, tell the user once.
      setTimeout(() => {
        if (t.shellIntegration || seenExecution.has(t) || context.globalState.get(HINT_SHOWN_KEY)) return;
        void context.globalState.update(HINT_SHOWN_KEY, true);
        void vscode.window.showInformationMessage(
          "Terminame needs terminal shell integration to see commands. Check that `terminal.integrated.shellIntegration.enabled` is on.",
        );
      }, 15000);
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration("terminame")) return;
      const previous: TerminameConfig = config;
      config = readConfig();
      namer.updateOptions({ timeoutMs: config.timeoutMs, userRules: config.rules, forced: config.provider });
      renamer.updateOptions({ aggressive: config.aggressiveRename });
      if (previous.provider !== config.provider || previous.anthropicModel !== config.anthropicModel) {
        await namer.init();
        refreshStatus();
      }
    }),
    vscode.commands.registerCommand("terminame.renameNow", async () => {
      const t = vscode.window.activeTerminal;
      if (!t) return;
      const picked = await vscode.window.showInputBox({ prompt: "Command to name this terminal after", value: "" });
      if (picked === undefined) return;
      renamer.forget(t);
      await handleStart(t, picked);
    }),
    vscode.commands.registerCommand("terminame.clearCache", async () => { await cache.clear(); log.appendLine("cache cleared"); }),
    vscode.commands.registerCommand("terminame.showLog", () => log.show()),
    vscode.commands.registerCommand("terminame.setAnthropicApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "Anthropic API key (stored in SecretStorage)", password: true });
      if (key === undefined) return;
      if (key === "") await context.secrets.delete(API_KEY_SECRET); else await context.secrets.store(API_KEY_SECRET, key);
      await namer.init();
      refreshStatus();
    }),
  );

  await namer.init();
  refreshStatus();
  log.appendLine(`Terminame activated (provider: ${namer.activeId}, mode: ${config.mode})`);
}

export function deactivate(): void {}
```

The information message in the shell-integration hint is a non-blocking toast, not a modal, so it is within the spec's "no modal dialogs" rule.

- [ ] **Step 4: Build, typecheck, unit tests**

Run: `npm run build && npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Manual check in Cursor**

Run `cursor --extensionDevelopmentPath=$PWD`. In the dev window:
1. Open a terminal, run `sleep 3`. Expected within ~6s: tab renamed (model name, or "Sleep" if rules-only). Output channel shows `"sleep 3" → "…" (model|rules)` and the chosen provider on activation.
2. Run `ls`. Expected: no rename.
3. Open a second terminal, switch back to the first, run `npm run dev`-like command in the *second* via `terminal.sendText` is not possible from the UI — instead: in terminal 2 run `sleep 8`, immediately click terminal 1. After the model answers, click terminal 2. Expected: it renames on becoming active.
4. Right-click a tab → Rename → "mine". Run another command there. Expected: name stays "mine".
5. Set `terminame.provider` to `rules` in settings. Expected: status bar item appears, names come from rules instantly.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/shellWatcher.ts src/extension.ts
git commit -m "feat: wire shell watcher, namer and renamer into the extension

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Extension-host smoke tests

**Files:**
- Create: `.vscode-test.mjs`, `test/ext/rename.test.ts`, `test/fixtures/workspace/.vscode/settings.json`

**Interfaces:**
- Consumes: the built extension (`dist/extension.js`), compiled tests in `out/test/ext`.

- [ ] **Step 1: Fixture settings (deterministic: rules only, instant)**

`test/fixtures/workspace/.vscode/settings.json`:
```json
{
  "terminame.provider": "rules",
  "terminame.mode": "instant",
  "terminal.integrated.shellIntegration.enabled": true
}
```

- [ ] **Step 2: .vscode-test.mjs**

```js
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "out/test/ext/**/*.test.js",
  workspaceFolder: "test/fixtures/workspace",
  mocha: { ui: "bdd", timeout: 60000 },
});
```

- [ ] **Step 3: Test**

`test/ext/rename.test.ts`:
```ts
import * as assert from "node:assert";
import * as vscode from "vscode";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await wait(200);
  }
  return undefined;
}

describe("terminame", function () {
  it("renames the active terminal from the rules table", async function () {
    const terminal = vscode.window.createTerminal("smoke");
    terminal.show();
    const si = await waitFor(() => terminal.shellIntegration, 15000);
    if (!si) { this.skip(); return; } // shell integration unavailable in this environment
    si.executeCommand("sleep 1");
    const name = await waitFor(() => (terminal.name === "Sleep" ? terminal.name : undefined), 10000);
    assert.strictEqual(name, "Sleep");
    terminal.dispose();
  });

  it("does not rename for ignored commands", async function () {
    const terminal = vscode.window.createTerminal("ignored");
    terminal.show();
    const si = await waitFor(() => terminal.shellIntegration, 15000);
    if (!si) { this.skip(); return; }
    si.executeCommand("ls");
    await wait(3000);
    assert.strictEqual(terminal.name, "ignored");
    terminal.dispose();
  });
});
```

- [ ] **Step 4: Run**

Run: `npm run test:ext`
Expected: 2 passing, or 2 pending if shell integration never attaches inside the test harness. Record which outcome you saw in the commit message.

If the rename visibly happens in the test window but `terminal.name` never changes, this VS Code build does not surface title changes through the API. In that case make the first test call `this.skip()` with a comment explaining why, and add the limitation to the README in Task 12.

- [ ] **Step 5: Commit**

```bash
git add .vscode-test.mjs test/ext test/fixtures
git commit -m "test: extension-host smoke tests for rename and ignore

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: README, packaging, local install in Cursor

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: `package.json` (add `repository` if a remote exists; otherwise leave)

- [ ] **Step 1: README.md**

```markdown
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
```

- [ ] **Step 2: LICENSE** — MIT text with `Copyright (c) 2026 Gal Ezra`.

- [ ] **Step 3: Package and install**

```bash
npm run build && npm run package
cursor --install-extension terminame-0.1.0.vsix
```
Expected: a `.vsix` file, install succeeds. Reload Cursor, open a terminal, run a command, confirm the tab renames.

- [ ] **Step 4: Commit**

```bash
git add README.md LICENSE package.json
git commit -m "docs: README and packaging

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Provider chain and probing → Tasks 5–8, 10. Rules table, normalisation, ignore list, `<host>` capture, user rules first → Task 2. Cache in `globalState` → Task 4. Sanitiser limits → Task 3. Timeout, cancellation, three-strikes → Task 5. Active/background rename, aggressive option, user-owned detection, idle name, close cleanup → Task 9 + 10. Shell-integration hint → Task 10. Settings surface and four commands → Tasks 1 and 10. SecretStorage for the key → Task 10. No modal dialogs → only toasts/input boxes used. Testing layers → Tasks 2–7, 9 (unit), 11 (extension host). Node prerequisite → Task 1 Step 0. Non-goals untouched.

**Type consistency.** `NameProvider.name(req, signal)` used identically in Tasks 5–8. `Renamer.setName/onActiveChanged/onCommandEnd/forget/isUserOwned` as consumed in Task 10. `NameCache.get/set/clear` consistent. `readConfig()` field names match `package.json` keys.

**Placeholders.** None; every code step is complete. Two spots flag environment-dependent outcomes (AbortSignal.any on old Node, shell integration in the test harness) with the concrete action to take.
