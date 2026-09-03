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

  /**
   * Cache key for a request. The folder is part of the key because the same command deserves a
   * different name per project (`pytest` in `billing` vs `api`), and the model is told the folder.
   */
  static cacheKey(req: NameRequest): string {
    return req.cwdBasename ? `${req.command}\n${req.cwdBasename}` : req.command;
  }

  async updateOptions(opts: Partial<NamerOptions>): Promise<void> {
    const forcedChanged = opts.forced !== undefined && opts.forced !== this.opts.forced;
    this.opts = { ...this.opts, ...opts };
    if (forcedChanged) await this.init();
  }

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
    const key = Namer.cacheKey(req);
    const cached = this.cache.get(key);
    if (cached) return { name: cached, source: "cache" };
    if (!this.active) return { name: this.rulesName(req.command), source: "rules" };

    const provider = this.active;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]);
    let raw: string | null = null;
    try {
      raw = await new Promise<string | null>((resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (combined.aborted) { onAbort(); return; }
        combined.addEventListener("abort", onAbort, { once: true });
        provider.name(req, combined)
          .then(resolve, reject)
          .finally(() => combined.removeEventListener("abort", onAbort));
      });
    } catch (e) {
      if (signal.aborted) return null;
      this.opts.log(`provider ${provider.id} error: ${String(e)}`);
    }
    if (signal.aborted) return null;

    const clean = raw ? sanitizeName(raw) : null;
    if (clean) {
      this.failures = 0;
      await this.cache.set(key, clean);
      return { name: clean, source: "model" };
    }

    // An unusable answer (empty, or nothing sanitizeName could keep) counts as a strike just like an
    // error or timeout: three in a row means the provider is broken for us, not that one command was odd.
    this.failures++;
    this.opts.log(`provider ${provider.id} miss (${this.failures}/${this.opts.maxFailures})`);
    if (this.failures >= this.opts.maxFailures) {
      this.opts.log(`provider ${provider.id} disabled for this session`);
      await this.advance();
    }
    return { name: this.rulesName(req.command), source: "rules" };
  }
}
