// Constant-space diagnostics for the existing closed-loop heartbeat scheduler.
export class HeartbeatDemand {
	constructor(target, intervalMs, tickMs, nowMs) {
		this.target = target;
		this.intervalMs = intervalMs;
		this.tickMs = tickMs;
		this.epochMs = nowMs;
		this.previousTickMs = nowMs;
		this.idealSlotBase = 0;
		this.stoppedAtMs = null;
		this.timerCalls = 0;
		this.visitedSlots = 0;
		this.dispatched = 0;
		this.skippedNotReady = 0;
		this.skippedInFlight = 0;
		this.skippedStopping = 0;
		this.maxTickGapMs = 0;
	}

	idealSlots(nowMs) {
		const untilMs = this.stoppedAtMs ?? nowMs;
		const perTick = Math.max(1, Math.ceil(this.target * this.tickMs / this.intervalMs));
		return this.idealSlotBase + Math.max(0, untilMs - this.epochMs) * perTick / this.tickMs;
	}

	setTarget(target, nowMs) {
		this.idealSlotBase = this.idealSlots(nowMs);
		this.epochMs = nowMs;
		this.target = target;
	}

	tick(nowMs) {
		this.timerCalls++;
		this.maxTickGapMs = Math.max(this.maxTickGapMs, nowMs - this.previousTickMs);
		this.previousTickMs = nowMs;
	}

	visit(ready, inFlight, stopping) {
		this.visitedSlots++;
		if (!ready) { this.skippedNotReady++; return false; }
		if (inFlight) { this.skippedInFlight++; return false; }
		if (stopping) { this.skippedStopping++; return false; }
		this.dispatched++;
		return true;
	}

	stop(nowMs) {
		this.stoppedAtMs ??= nowMs;
	}

	snapshot(nowMs) {
		const idealTimerSlots = Math.floor(this.idealSlots(nowMs));
		return {
			model: "closed_loop_one_inflight_per_object",
			target: this.target,
			nominalTargetPerSecond: this.target * 1000 / this.intervalMs,
			timerSlotTargetPerSecond: Math.max(1, Math.ceil(this.target * this.tickMs / this.intervalMs)) * 1000 / this.tickMs,
			idealTimerSlots,
			timerCalls: this.timerCalls,
			visitedSlots: this.visitedSlots,
			timerSlotDeficit: Math.max(0, idealTimerSlots - this.visitedSlots),
			dispatched: this.dispatched,
			skippedNotReady: this.skippedNotReady,
			skippedInFlight: this.skippedInFlight,
			skippedStopping: this.skippedStopping,
			maxTickGapMs: this.maxTickGapMs,
		};
	}
}
