export type IdleName = "keep" | "folder" | "shell";

export interface RenamerHost<T> {
  activeTerminal(): T | undefined;
  currentName(t: T): string;
  /** Apply a name. Callers guarantee `t` is the active terminal. */
  rename(t: T, name: string): Promise<void>;
  focus(t: T): void;
}

interface State {
  original: string;   // name before we ever touched it (e.g. "zsh")
  applied?: string;   // last name we set
  pending?: string;   // name waiting for the terminal to become active
  userOwned: boolean;
}

export class Renamer<T extends object> {
  private readonly state = new WeakMap<T, State>();

  constructor(private readonly host: RenamerHost<T>, private opts: { aggressive: boolean }) {}

  updateOptions(opts: { aggressive: boolean }): void { this.opts = opts; }

  private stateFor(t: T): State {
    let s = this.state.get(t);
    if (!s) { s = { original: this.host.currentName(t), userOwned: false }; this.state.set(t, s); }
    return s;
  }

  isUserOwned(t: T): boolean { return this.state.get(t)?.userOwned ?? false; }

  private detectUserRename(t: T, s: State): boolean {
    const current = this.host.currentName(t);
    if (s.applied !== undefined && current !== s.applied && current !== s.original) {
      s.userOwned = true;
      s.pending = undefined;
    }
    return s.userOwned;
  }

  async setName(t: T, name: string): Promise<void> {
    const s = this.stateFor(t);
    if (this.detectUserRename(t, s)) return;
    if (this.host.activeTerminal() === t) {
      await this.apply(t, s, name);
      return;
    }
    if (this.opts.aggressive) {
      const previous = this.host.activeTerminal();
      this.host.focus(t);
      try {
        await this.apply(t, s, name);
      } finally {
        if (previous) this.host.focus(previous);
      }
      return;
    }
    s.pending = name;
  }

  private async apply(t: T, s: State, name: string): Promise<void> {
    await this.host.rename(t, name);
    s.applied = name;
    s.pending = undefined;
  }

  async onActiveChanged(t: T | undefined): Promise<void> {
    if (!t) return;
    const s = this.state.get(t);
    if (!s || s.pending === undefined) return;
    if (this.detectUserRename(t, s)) return;
    await this.apply(t, s, s.pending);
  }

  async onCommandEnd(t: T, idle: IdleName, cwdBasename?: string): Promise<void> {
    if (idle === "keep") return;
    const s = this.stateFor(t);
    const target = idle === "folder" ? (cwdBasename ?? s.original) : s.original;
    await this.setName(t, target);
  }

  forget(t: T): void { this.state.delete(t); }

  /** Hand control back to the extension for a terminal the user had renamed, keeping its original name. */
  release(t: T): void {
    const s = this.state.get(t);
    // Clear `applied` too: otherwise detectUserRename compares the terminal's still-unchanged
    // (user-set) name against the stale `applied` value and immediately re-flags it as user-owned.
    if (s) { s.userOwned = false; s.pending = undefined; s.applied = undefined; }
  }
}
