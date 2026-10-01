/** Wall time can jump on resume; event/usage timestamps must not be rewritten. */
export class ResumeClockGuard {
  constructor(private wall: number, private monotonic: number, private readonly thresholdMs: number) {}

  observe(wall: number, monotonic: number): boolean {
    const wallDelta = wall - this.wall;
    const monoDelta = monotonic - this.monotonic;
    this.wall = wall;
    this.monotonic = monotonic;
    // Linux monotonic stops during suspend, but a long event-loop pause needs grace too.
    return wallDelta < 0 || monoDelta < 0 || wallDelta > this.thresholdMs || Math.abs(wallDelta - monoDelta) > this.thresholdMs;
  }
}
