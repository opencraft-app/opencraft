/** A briefly-ready crashing process does not earn a fresh restart budget. */
export class DshRestartBudget {
  private remaining: number;
  private readyAt: number | null = null;
  constructor(private readonly limit = 3, private readonly stableMs = 60_000) { this.remaining = limit; }
  ready(now = Date.now()) { this.readyAt = now; }
  begin(now = Date.now()) {
    if (this.readyAt !== null && now - this.readyAt >= this.stableMs) this.remaining = this.limit;
    this.readyAt = null;
  }
  take(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
  reset() { this.remaining = this.limit; }
}
