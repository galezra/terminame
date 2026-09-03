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

  const guarded = (label: string, p: Promise<unknown>): void => {
    p.catch((e) => log.appendLine(`${label} failed: ${String(e)}`));
  };

  const host: RenamerHost<vscode.Terminal> = {
    activeTerminal: () => vscode.window.activeTerminal,
    currentName: (t) => t.name,
    rename: async (t, name) => {
      try {
        await vscode.commands.executeCommand("workbench.action.terminal.renameWithArg", { name });
      } catch (e) {
        log.appendLine(`rename of "${t.name}" failed: ${String(e)}`);
        throw e;
      }
    },
    focus: (t) => t.show(true),
  };
  const renamer = new Renamer<vscode.Terminal>(host, { aggressive: config.aggressiveRename });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = "terminame.showLog";
  context.subscriptions.push(status);
  const refreshStatus = () => {
    // Only nag when auto-detection landed on rules; `provider: "rules"` is a deliberate choice.
    if (namer.activeId === "rules" && config.provider !== "rules") {
      status.text = "$(terminal) Terminame: rules";
      status.tooltip = "Terminame is naming tabs with built-in rules. Install Claude Code (and run /login) or sign in to Copilot for smarter names.";
      status.show();
    } else {
      status.hide();
    }
  };

  const inflight = new WeakMap<vscode.Terminal, AbortController>();
  const seenExecution = new WeakSet<vscode.Terminal>();
  const hintTimers = new Map<vscode.Terminal, NodeJS.Timeout>();

  async function handleStart(terminal: vscode.Terminal, commandLine: string, cwdBasename?: string): Promise<void> {
    seenExecution.add(terminal);
    if (!config.enabled || renamer.isUserOwned(terminal)) return;
    const command = normalizeCommand(commandLine);
    if (isIgnored(command, config.ignore)) return;

    inflight.get(terminal)?.abort();
    const ac = new AbortController();
    inflight.set(terminal, ac);

    if (config.mode === "instant" && namer.activeId !== "rules" && cache.get(Namer.cacheKey({ command, cwdBasename })) === undefined) {
      await renamer.setName(terminal, namer.rulesName(command));
    }
    const result = await namer.name({ command, cwdBasename }, ac.signal);
    if (!result || ac.signal.aborted) return;
    if (inflight.get(terminal) !== ac) return;
    log.appendLine(`"${command}" → "${result.name}" (${result.source})`);
    await renamer.setName(terminal, result.name);
    refreshStatus();
  }

  context.subscriptions.push(
    watchShell({
      onStart: (e) => { guarded("handleStart", handleStart(e.terminal, e.commandLine, e.cwdBasename)); },
      onEnd: (e) => {
        if (!config.enabled) return;
        // An ignored command never renamed anything, so it must not trigger the idle name either.
        if (isIgnored(normalizeCommand(e.commandLine), config.ignore)) return;
        if (!renamer.hasApplied(e.terminal)) return;
        if (config.idleName !== "keep") {
          // Drop any in-flight model call: a late answer must not overwrite the idle name.
          const ac = inflight.get(e.terminal);
          if (ac) { ac.abort(); inflight.delete(e.terminal); }
        }
        guarded("onCommandEnd", renamer.onCommandEnd(e.terminal, config.idleName, e.cwdBasename));
      },
    }),
    vscode.window.onDidChangeActiveTerminal((t) => {
      if (!config.enabled) return;
      guarded("onActiveChanged", renamer.onActiveChanged(t));
    }),
    vscode.window.onDidCloseTerminal((t) => {
      inflight.get(t)?.abort();
      inflight.delete(t);
      renamer.forget(t);
      const timer = hintTimers.get(t);
      if (timer) { clearTimeout(timer); hintTimers.delete(t); }
    }),
    vscode.window.onDidOpenTerminal((t) => {
      // Extension-owned pty terminals never get shell integration by design; only real shells earn the hint.
      if ("pty" in t.creationOptions) return;
      // Shell-integration hint: if the first command never produces an execution event, tell the user once.
      const timer = setTimeout(() => {
        hintTimers.delete(t);
        if (t.shellIntegration || seenExecution.has(t) || context.globalState.get(HINT_SHOWN_KEY)) return;
        guarded("hint globalState.update", Promise.resolve(context.globalState.update(HINT_SHOWN_KEY, true)));
        void vscode.window.showInformationMessage(
          "Terminame needs terminal shell integration to see commands. Check that `terminal.integrated.shellIntegration.enabled` is on.",
        );
      }, 15000);
      hintTimers.set(t, timer);
    }),
    { dispose: () => { for (const h of hintTimers.values()) clearTimeout(h); hintTimers.clear(); } },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("terminame")) return;
      guarded("configChange", (async () => {
        const previous: TerminameConfig = config;
        config = readConfig();
        await namer.updateOptions({ timeoutMs: config.timeoutMs, userRules: config.rules, forced: config.provider });
        renamer.updateOptions({ aggressive: config.aggressiveRename });
        if (previous.anthropicModel !== config.anthropicModel) {
          await namer.init();
        }
        refreshStatus();
      })());
    }),
    vscode.commands.registerCommand("terminame.renameNow", async () => {
      const t = vscode.window.activeTerminal;
      if (!t) return;
      const picked = await vscode.window.showInputBox({ prompt: "Command to name this terminal after", value: "" });
      if (picked === undefined) return;
      renamer.release(t);
      guarded("handleStart", handleStart(t, picked));
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
