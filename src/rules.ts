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
