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
    const r = await this.run(this.bin, ["-p", prompt, "--model", "haiku", "--output-format", "text", "--strict-mcp-config"], { cwd: homedir(), signal, env: this.env() });
    return r.code === 0 ? r.stdout : null;
  }
}
