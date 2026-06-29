export function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export const isMissingPathError = (error: unknown): boolean => isErrorWithCode(error, "ENOENT");

export const isPathExistsError = (error: unknown): boolean => isErrorWithCode(error, "EEXIST");

export const isNoSuchProcessError = (error: unknown): boolean => isErrorWithCode(error, "ESRCH");

export function isMissingOrInaccessiblePathError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}
