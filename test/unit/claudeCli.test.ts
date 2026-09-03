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
  it("calls claude -p with haiku, text output, no MCP and a single turn, from the home dir", async () => {
    const cap: { args?: string[]; cwd?: string } = {};
    const p = new ClaudeCliProvider(runner({ stdout: "Start App\n", code: 0 }, cap), async () => "/usr/local/bin/claude");
    await p.isAvailable();
    const out = await p.name({ command: "npm run dev", cwdBasename: "web" }, new AbortController().signal);
    expect(out).toBe("Start App\n");
    expect(cap.args).toEqual(
      expect.arrayContaining(["-p", "--model", "haiku", "--output-format", "text", "--strict-mcp-config", "--max-turns", "1"]),
    );
    expect(cap.args!.join(" ")).toContain("Command: npm run dev");
    expect(cap.cwd).not.toContain("web");
  });
  it("returns null on non-zero exit", async () => {
    const p = new ClaudeCliProvider(runner({ stdout: "", code: 1 }), async () => "/usr/local/bin/claude");
    await p.isAvailable();
    expect(await p.name({ command: "x y z" }, new AbortController().signal)).toBeNull();
  });
});
