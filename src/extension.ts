import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Terminame");
  context.subscriptions.push(log);
  log.appendLine("Terminame activated");
}

export function deactivate(): void {}
