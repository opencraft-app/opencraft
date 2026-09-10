/**
 * Browser Workbench does not own the lightvela.com analytics bootstrap.
 * The copied feature code keeps every tracking call intact; this boundary
 * supplies the SDK shape without creating a second page-level reporter.
 */
export default class UniversalReportAdapter {
  constructor(_options: unknown) {}
  reportEvent(_payload: unknown): void {}
  setPublicParams(_params: Record<string, unknown>): void {}
  startReport(): void {}
  destroy(): void {}
}
