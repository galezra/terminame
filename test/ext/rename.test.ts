import * as assert from "node:assert";
import * as vscode from "vscode";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NO_SHELL_INTEGRATION =
  "SKIPPING: terminal shell integration did not become available within 15s. " +
  "Terminame cannot see commands without it, so this test cannot verify anything in this environment. " +
  "Check `terminal.integrated.shellIntegration.enabled` and that the test shell is zsh/bash/fish/PowerShell.";

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
    try {
      terminal.show();
      const si = await waitFor(() => terminal.shellIntegration, 15000);
      if (!si) {
        console.warn(NO_SHELL_INTEGRATION);
        this.skip();
        return;
      }
      si.executeCommand("sleep 1");
      const name = await waitFor(() => (terminal.name === "Sleep" ? terminal.name : undefined), 10000);
      assert.strictEqual(name, "Sleep");
    } finally {
      terminal.dispose();
    }
  });

  it("does not rename for ignored commands", async function () {
    const terminal = vscode.window.createTerminal("ignored");
    try {
      terminal.show();
      const si = await waitFor(() => terminal.shellIntegration, 15000);
      if (!si) {
        console.warn(NO_SHELL_INTEGRATION);
        this.skip();
        return;
      }
      si.executeCommand("ls");
      await wait(3000);
      assert.strictEqual(terminal.name, "ignored");
    } finally {
      terminal.dispose();
    }
  });
});
