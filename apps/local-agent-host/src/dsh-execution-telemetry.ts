/** Local bounded execution observations; never stores message or argument bodies. */
export class DshExecutionTelemetry {
  private readonly startedAt = Date.now();
  private endedAt: number | null = null;
  private status = "running";
  private events = 0;
  private textDeltas = 0;
  private reasoningDeltas = 0;
  private nativeWatermark = -1;
  private milestones: Array<{ name: string; at: number }> = [];
  observe(type: string, seq: number, chunkType?: string) {
    if (this.endedAt !== null) return;
    this.events++;
    this.nativeWatermark = Math.max(this.nativeWatermark, seq);
    if (chunkType === "text-delta") this.textDeltas++;
    if (chunkType === "reasoning-delta") this.reasoningDeltas++;
    if (["turn/start", "turn/end", "step/start", "step/end", "tool/call", "tool/result"].includes(type)) this.milestone(type);
  }
  milestone(name: string) {
    this.milestones.push({ name, at: Date.now() });
    if (this.milestones.length > 32) this.milestones.shift();
  }
  end(status: string) {
    if (this.endedAt !== null) return;
    this.endedAt = Date.now(); this.status = status;
  }
  snapshot() {
    return { status: this.status, startedAt: this.startedAt, endedAt: this.endedAt,
      durationMs: (this.endedAt ?? Date.now()) - this.startedAt, events: this.events,
      textDeltas: this.textDeltas, reasoningDeltas: this.reasoningDeltas, nativeWatermark: this.nativeWatermark,
      milestones: this.milestones.map(value => ({ ...value })) };
  }
}
