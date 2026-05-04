// Active-runs map — tracks AbortControllers for in-flight workflows so
// `cancelWorkflow` can signal cancellation by id.

export const activeRuns = new Map<string, AbortController>();
