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
