export class DictationPressGesture {
  private disarm: (() => void) | null = null;
  private finish: (() => void) | null = null;
  private ignoreClick = false;
  private pointerId: number | null = null;
  constructor(private readonly ports = { schedule(callback: () => void) {
    const timer = setTimeout(callback, 150); return () => clearTimeout(timer);
  } }) {}
  press(start: () => void, finish: () => void, pointerId = 0): void {
    this.reset();
    this.pointerId = pointerId;
    this.disarm = this.ports.schedule(() => {
      this.disarm = null; this.finish = finish; this.ignoreClick = true; start();
    });
  }
  release(pointerId = this.pointerId): void {
    if (this.pointerId === null || pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.disarm?.(); this.disarm = null;
    const finish = this.finish; this.finish = null; finish?.();
  }
  consumeClick(): boolean { const ignored = this.ignoreClick; this.ignoreClick = false; return ignored; }
  reset(): void { this.disarm?.(); this.disarm = null; this.finish = null; this.ignoreClick = false; this.pointerId = null; }
}
