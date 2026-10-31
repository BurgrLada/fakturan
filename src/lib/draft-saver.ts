export type SaveReply<R> =
  | { kind: "saved"; result: R }
  | { kind: "stale" }
  | { kind: "expired" }
  | { kind: "rejected"; error: string };

export type SaveStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "offline" }
  | { kind: "stale" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

type Entry<P> = { key: string; payload: P };

type Options<P, R> = {
  send: (payload: P) => Promise<SaveReply<R>>;
  onSaved: (result: R) => void;
  onStatus: (status: SaveStatus) => void;
  baseline?: string;
};

const IDLE_MS = 1500;
const RETRY_MS = 5000;

export class DraftSaver<P, R> {
  private wanted: Entry<P> | null = null;
  // Sent without a known outcome. It goes out again before anything newer, because only an
  // identical retry is told apart from a conflict by the server.
  private unconfirmed: Entry<P> | null = null;
  private confirmedKey: string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private locked = false;
  private failed = false;
  private readonly options: Options<P, R>;

  constructor(options: Options<P, R>) {
    this.options = options;
    this.confirmedKey = options.baseline ?? null;
  }

  change(key: string, payload: P): void {
    if (this.locked) return;
    const settled = this.unconfirmed ? this.unconfirmed.key : this.confirmedKey;
    if (key === this.wanted?.key) return;
    if (key === settled) {
      if (!this.wanted && !this.failed) return;
      this.wanted = null;
      this.failed = false;
      this.clearTimer();
      if (!this.unconfirmed) this.options.onStatus({ kind: "saved" });
      return;
    }
    this.wanted = { key, payload };
    this.options.onStatus({ kind: "pending" });
    this.wait(IDLE_MS);
  }

  isDirty(): boolean {
    return this.wanted !== null || this.unconfirmed !== null;
  }

  isLocked(): boolean {
    return this.locked;
  }

  hasFailed(): boolean {
    return this.failed;
  }

  async flush(): Promise<boolean> {
    this.clearTimer();
    while (this.running) await this.running;
    if (this.isDirty()) await this.start();
    return !this.locked && !this.failed && !this.isDirty();
  }

  // For a delete: whatever is queued is dropped, because a later write would act on a gone document.
  async halt(): Promise<void> {
    this.locked = true;
    this.wanted = null;
    this.clearTimer();
    while (this.running) await this.running;
    this.unconfirmed = null;
  }

  resume(): void {
    this.locked = false;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private wait(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start();
    }, ms);
  }

  private start(): Promise<void> {
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (!this.locked) {
      const next = this.unconfirmed ?? this.wanted;
      if (!next || (this.timer !== null && !this.unconfirmed)) return;
      if (next === this.wanted) this.wanted = null;
      this.unconfirmed = next;
      this.options.onStatus({ kind: "saving" });

      let reply: SaveReply<R>;
      try {
        reply = await this.options.send(next.payload);
      } catch {
        this.options.onStatus({ kind: "offline" });
        this.wait(RETRY_MS);
        return;
      }

      this.unconfirmed = null;
      this.failed = reply.kind !== "saved";
      if (reply.kind === "stale" || reply.kind === "expired") {
        this.locked = true;
        this.wanted = null;
        this.clearTimer();
        this.options.onStatus({ kind: reply.kind });
        return;
      }
      if (reply.kind === "rejected") {
        this.options.onStatus({ kind: "error", message: reply.error });
      } else {
        this.confirmedKey = next.key;
        this.options.onSaved(reply.result);
        if (!this.wanted) this.options.onStatus({ kind: "saved" });
      }
    }
  }
}
