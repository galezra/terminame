import * as vscode from "vscode";
import { Rule } from "./rules";
import { IdleName } from "./renamer";
import { ProviderId } from "./providers/types";

export interface TerminameConfig {
  enabled: boolean;
  mode: "waitForModel" | "instant";
  timeoutMs: number;
  provider: ProviderId | "rules" | "auto";
  anthropicModel: string;
  rules: Rule[];
  ignore: string[];
  idleName: IdleName;
  aggressiveRename: boolean;
}

export function readConfig(): TerminameConfig {
  const c = vscode.workspace.getConfiguration("terminame");
  return {
    enabled: c.get<boolean>("enabled", true),
    mode: c.get<"waitForModel" | "instant">("mode", "waitForModel"),
    timeoutMs: c.get<number>("timeoutMs", 6000),
    provider: c.get<ProviderId | "rules" | "auto">("provider", "auto"),
    anthropicModel: c.get<string>("anthropic.model", "claude-haiku-4-5"),
    rules: c.get<Rule[]>("rules", []),
    ignore: c.get<string[]>("ignore", []),
    idleName: c.get<IdleName>("idleName", "keep"),
    aggressiveRename: c.get<boolean>("aggressiveRename", false),
  };
}
