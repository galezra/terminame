export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

type Entries = Array<[string, string]>;

export class NameCache {
  private readonly key: string;
  private readonly max: number;
  private map: Map<string, string>;

  constructor(private readonly store: KeyValueStore, opts: { key?: string; max?: number } = {}) {
    this.key = opts.key ?? "terminame.names";
    this.max = opts.max ?? 500;
    this.map = new Map(NameCache.readEntries(store, this.key));
  }

  /** Globals survive extension upgrades, so never trust the stored shape: keep only `[string, string]` pairs. */
  private static readEntries(store: KeyValueStore, key: string): Entries {
    const raw = store.get<unknown>(key);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
    );
  }

  get size(): number { return this.map.size; }

  get(command: string): string | undefined { return this.map.get(command); }

  async set(command: string, name: string): Promise<void> {
    this.map.delete(command);
    this.map.set(command, name);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
    await this.store.update(this.key, [...this.map.entries()]);
  }

  async clear(): Promise<void> {
    this.map.clear();
    await this.store.update(this.key, []);
  }
}
