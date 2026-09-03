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

  const rawRules = c.get<unknown>("rules", []);
  const rules: Rule[] = Array.isArray(rawRules)
    ? rawRules.filter((r): r is Rule => typeof r === "object" && r !== null && typeof (r as Rule).match === "string" && typeof (r as Rule).name === "string")
    : [];
  const rawIgnore = c.get<unknown>("ignore", []);
  const ignore = Array.isArray(rawIgnore) ? rawIgnore.filter((s): s is string => typeof s === "string") : [];

  return {
    enabled: c.get<boolean>("enabled", true),
    mode: c.get<"waitForModel" | "instant">("mode", "waitForModel"),
    timeoutMs: c.get<number>("timeoutMs", 6000),
    provider: c.get<ProviderId | "rules" | "auto">("provider", "auto"),
    anthropicModel: c.get<string>("anthropic.model", "claude-haiku-4-5"),
    rules,
    ignore,
    idleName: c.get<IdleName>("idleName", "keep"),
    aggressiveRename: c.get<boolean>("aggressiveRename", false),
  };
}
