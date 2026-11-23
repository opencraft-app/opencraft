/** Assistant Host extension selected through Headless composition in tests. */
export const failures = [];
export const assistantHostExtension = Object.freeze({
  reportFailure: (error) => failures.push(error instanceof Error ? error.message : String(error)),
});
