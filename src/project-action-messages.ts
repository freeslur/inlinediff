import type { ProjectActionSummary } from "./diff-service/project-actions.ts";

export interface ProjectActionMessageSink {
  readonly showErrorMessage: (message: string) => PromiseLike<unknown>;
  readonly showInformationMessage: (message: string) => PromiseLike<unknown>;
  readonly showWarningMessage: (message: string) => PromiseLike<unknown>;
}

type ProjectAction = "accept" | "reject";
type MessageSeverity = "error" | "information" | "warning";

interface ProjectActionMessage {
  readonly message: string;
  readonly severity: MessageSeverity;
}

export async function showProjectActionSummaryMessage(
  sink: ProjectActionMessageSink,
  action: ProjectAction,
  summary: ProjectActionSummary,
): Promise<void> {
  const { message, severity } = formatProjectActionSummaryMessage(action, summary);
  switch (severity) {
    case "error":
      await sink.showErrorMessage(message);
      return;
    case "information":
      await sink.showInformationMessage(message);
      return;
    case "warning":
      await sink.showWarningMessage(message);
      return;
  }
}

function formatProjectActionSummaryMessage(
  action: ProjectAction,
  summary: ProjectActionSummary,
): ProjectActionMessage {
  const pastTense = action === "accept" ? "accepted" : "rejected";
  if (summary.failed.length === 0) {
    return {
      message: `Inline Diff ${pastTense} ${summary.succeeded.length} changed files.`,
      severity: "information",
    };
  }

  const failed = summary.failed
    .map((failure) => `${failure.relativePath} (${failure.error})`)
    .join(", ");
  const rollback =
    summary.succeeded.length > 0
      ? "Successful files were not rolled back."
      : "No files were changed before the failure.";

  return {
    message: `Inline Diff ${pastTense} ${summary.succeeded.length} of ${summary.total} changed files. Failed: ${failed}. All remaining changed files were attempted. ${rollback}`,
    severity: summary.succeeded.length > 0 ? "warning" : "error",
  };
}
