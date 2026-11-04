import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

/** Static, durable binding. Renewals only advance this incarnation's monotonic deadline. */
export interface OperatorLeaseClaim {
  version: 1; id: string; controller: { pid: number; startTime: string; bootId: string }; ttlMs: number;
}
export type OperatorLeaseEnd = "operator-exited" | "lease-expired";
export interface OperatorLeaseAbort {
  version: 1; owner: string; epoch: number; operationId: string; fence: string;
  operatorLease: OperatorLeaseClaim; reason: OperatorLeaseEnd; abortedAt: string;
}
const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
function alive(controller: OperatorLeaseClaim["controller"]) {
  try {
    const stat = readFileSync(`/proc/${controller.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/u);
    return !["Z", "X", "x"].includes(fields[0]!) && fields[19] === controller.startTime && controller.bootId === bootId();
  } catch { return false; }
}
export class OperatorLease {
  readonly claim: OperatorLeaseClaim;
  private deadline: number;
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  constructor(input: OperatorLeaseClaim | undefined, terminated: readonly string[] = []) {
    if (!input || input.version !== 1 || typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(input.id)
      || !Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1000 || input.ttlMs > 30000
      || !input.controller || !Number.isSafeInteger(input.controller.pid) || input.controller.pid < 1
      || typeof input.controller.startTime !== "string" || !/^\d+$/u.test(input.controller.startTime)
      || typeof input.controller.bootId !== "string" || !alive(input.controller)) throw Error("Live operator lease required");
    if (terminated.includes(input.id)) throw Error("Operator lease already terminated");
    // Never persist caller extensions, payloads or untrusted diagnostics.
    this.claim = { version: 1, id: input.id, ttlMs: input.ttlMs,
      controller: { pid: input.controller.pid, startTime: input.controller.startTime, bootId: input.controller.bootId } }; this.deadline = performance.now() + input.ttlMs;
  }
  ended(): OperatorLeaseEnd | undefined {
    return !alive(this.claim.controller) ? "operator-exited" : performance.now() >= this.deadline ? "lease-expired" : undefined;
  }
  assertLive() { if (this.ended()) throw Error("Operator lease expired or operator exited"); }
  renew(input: OperatorLeaseClaim | undefined) {
    this.assertLive();
    if (!input || input.id !== this.claim.id || input.version !== this.claim.version || input.ttlMs !== this.claim.ttlMs
      || input.controller?.pid !== this.claim.controller.pid || input.controller.startTime !== this.claim.controller.startTime
      || input.controller.bootId !== this.claim.controller.bootId) throw Error("Operator lease binding changed");
    this.deadline = performance.now() + this.claim.ttlMs;
  }
  status() { return { id: this.claim.id, remainingMs: Math.max(0, Math.ceil(this.deadline - performance.now())), ended: this.ended() }; }
  start(expire: (reason: OperatorLeaseEnd) => Promise<void> | void, failed: () => void) {
    if (this.timer) throw Error("Operator lease monitor already started");
    this.timer = setInterval(() => {
      const reason = this.ended();
      if (!reason || this.checking) return;
      this.checking = true;
      void Promise.resolve().then(() => expire(reason)).catch(failed).finally(() => { this.checking = false; });
    }, 100);
    this.timer.unref();
  }
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
