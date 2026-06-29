export async function processWorkspaceChanges<T>(
  changes: readonly T[],
  markChanged: (change: T) => void,
  processChange: (change: T) => Promise<void>,
  onError: (error: unknown, change: T) => void,
): Promise<void> {
  for (const change of changes) {
    markChanged(change);
  }
  for (const change of changes) {
    try {
      await processChange(change);
    } catch (error) {
      onError(error, change);
    }
  }
}
