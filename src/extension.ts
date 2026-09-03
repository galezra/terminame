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
      getApiKey: () => Promise.resolve(context.secrets.get(API_KEY_SECRET)),
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
      await namer.updateOptions({ timeoutMs: config.timeoutMs, userRules: config.rules, forced: config.provider });
      renamer.updateOptions({ aggressive: config.aggressiveRename });
      if (previous.anthropicModel !== config.anthropicModel) {
        await namer.init();
      }
      refreshStatus();
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
