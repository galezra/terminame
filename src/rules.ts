import { capLength } from "./sanitize";

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
  { match: "rails server*", name: "Start App" },
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

const CHAIN_SEPARATORS = ["&&", "||", ";"];
const PIPE_SEPARATORS = ["|"];
const PREFIX_STRIP = /^(?:(?:sudo|time|env|nohup)\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const WRAPPERS: Record<string, string> = { "(": ")", "{": "}" };

/**
 * Split on the given separators, ignoring any that fall inside single or double quotes, so
 * `grep "a||b" file` stays one segment. Separators are matched in the order given, so pass
 * longer ones first. Parts are trimmed; empty parts are kept (callers filter).
 */
export function splitTopLevel(input: string, separators: string[]): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    const sep = separators.find((s) => input.startsWith(s, i));
    if (sep !== undefined) {
      parts.push(current.trim());
      current = "";
      i += sep.length;
      continue;
    }
    current += ch;
    i++;
  }
  parts.push(current.trim());
  return parts;
}

/** Strip one pair of `(` `)` or `{` `}` wrapping the whole command: `(cd api && pytest)` → `cd api && pytest`. */
function unwrapOnce(input: string): string {
  const s = input.trim();
  const open = s[0];
  const close = WRAPPERS[open];
  if (close === undefined || !s.endsWith(close)) return s;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      // The opening bracket closes here; only a close at the very end wraps the whole command.
      if (depth === 0) return i === s.length - 1 ? s.slice(1, -1).trim() : s;
    }
  }
  return s;
}

export function pickSegment(commandLine: string): string {
  const chain = splitTopLevel(unwrapOnce(commandLine), CHAIN_SEPARATORS).filter((s) => s.length > 0);
  const last = chain[chain.length - 1] ?? "";
  return splitTopLevel(last, PIPE_SEPARATORS)[0] ?? "";
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

/**
 * Compiled-pattern memo. A `null` value marks a pattern `new RegExp` rejected (e.g. the duplicate
 * capture group in a user rule like `scp <host> <host>`), so it is skipped without recompiling.
 */
const compiled = new Map<string, RegExp | null>();

export function matchRules(normalized: string, userRules: Rule[] = []): string | null {
  for (const rule of [...userRules, ...BUILTIN_RULES]) {
    let re = compiled.get(rule.match);
    if (re === undefined) {
      try {
        re = compile(rule.match);
      } catch {
        re = null;
      }
      compiled.set(rule.match, re);
    }
    if (re === null) continue;
    const m = re.exec(normalized);
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
  return capLength(base[0].toUpperCase() + base.slice(1));
}

export function ruleName(normalized: string, userRules: Rule[] = []): string {
  return capLength(matchRules(normalized, userRules) ?? fallbackName(normalized));
}
