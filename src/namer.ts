import { NameCache } from "./cache";
import { Rule, ruleName } from "./rules";
import { sanitizeName } from "./sanitize";
import { NameProvider, NameRequest, ProviderId } from "./providers/types";

export type NameSource = "cache" | "model" | "rules";

export interface NamerOptions {
  timeoutMs: number;
  maxFailures: number;
  forced: ProviderId | "rules" | "auto";
  userRules: Rule[];
  log: (msg: string) => void;
}

export class Namer {
  private active: NameProvider | null = null;
  private remaining: NameProvider[] = [];
  private failures = 0;

  constructor(private readonly providers: NameProvider[], private readonly cache: NameCache, private opts: NamerOptions) {}

  get activeId(): ProviderId | "rules" { return this.active?.id ?? "rules"; }

  updateOptions(opts: Partial<NamerOptions>): void { this.opts = { ...this.opts, ...opts }; }

  rulesName(command: string): string { return ruleName(command, this.opts.userRules); }

  async init(): Promise<ProviderId | "rules"> {
    if (this.opts.forced === "rules") { this.active = null; this.remaining = []; return "rules"; }
    this.remaining = this.opts.forced === "auto" ? [...this.providers] : this.providers.filter((p) => p.id === this.opts.forced);
    await this.advance();
    return this.activeId;
  }

  /** Probe the remaining providers in order; set the first available one as active. */
  private async advance(): Promise<void> {
    this.active = null;
    this.failures = 0;
    while (this.remaining.length > 0) {
      const p = this.remaining.shift()!;
      try {
        if (await p.isAvailable()) { this.active = p; this.opts.log(`provider: ${p.id}`); return; }
        this.opts.log(`provider ${p.id} unavailable`);
      } catch (e) {
        this.opts.log(`provider ${p.id} probe failed: ${String(e)}`);
      }
    }
    this.opts.log("provider: rules only");
  }

  async name(req: NameRequest, signal: AbortSignal): Promise<{ name: string; source: NameSource } | null> {
    const cached = this.cache.get(req.command);
    if (cached) return { name: cached, source: "cache" };
    if (!this.active) return { name: this.rulesName(req.command), source: "rules" };

    const provider = this.active;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]);
    let raw: string | null = null;
    try {
      raw = await provider.name(req, combined);
    } catch (e) {
      if (signal.aborted) return null;
      this.opts.log(`provider ${provider.id} error: ${String(e)}`);
    }
    if (signal.aborted) return null;

    const clean = raw ? sanitizeName(raw) : null;
    if (clean) {
      this.failures = 0;
      await this.cache.set(req.command, clean);
      return { name: clean, source: "model" };
    }

    this.failures++;
    this.opts.log(`provider ${provider.id} miss (${this.failures}/${this.opts.maxFailures})`);
    if (this.failures >= this.opts.maxFailures) {
      this.opts.log(`provider ${provider.id} disabled for this session`);
      await this.advance();
    }
    return { name: this.rulesName(req.command), source: "rules" };
  }
}
