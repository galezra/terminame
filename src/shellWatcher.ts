import * as vscode from "vscode";
import { basename } from "node:path";

export interface CommandEvent {
  terminal: vscode.Terminal;
  commandLine: string;
  cwdBasename?: string;
  /** vscode.TerminalShellExecutionCommandLineConfidence: 0 low, 1 medium, 2 high */
  confidence: number;
}

export interface ShellHandlers {
  onStart(e: CommandEvent): void;
  onEnd(e: CommandEvent & { exitCode?: number }): void;
}

function toEvent(terminal: vscode.Terminal, execution: vscode.TerminalShellExecution): CommandEvent {
  return {
    terminal,
    commandLine: execution.commandLine.value,
    confidence: execution.commandLine.confidence,
    cwdBasename: execution.cwd ? basename(execution.cwd.fsPath) : undefined,
  };
}

export function watchShell(handlers: ShellHandlers): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.window.onDidStartTerminalShellExecution((e) => handlers.onStart(toEvent(e.terminal, e.execution))),
    vscode.window.onDidEndTerminalShellExecution((e) => handlers.onEnd({ ...toEvent(e.terminal, e.execution), exitCode: e.exitCode })),
  );
}
