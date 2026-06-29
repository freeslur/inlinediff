import { describe, expect, test } from "bun:test";
import type { ProjectActionSummary } from "../src/diff-service/project-actions.ts";
import {
  type ProjectActionMessageSink,
  showProjectActionSummaryMessage,
} from "../src/project-action-messages.ts";

type CapturedMessage = {
  readonly message: string;
  readonly severity: "error" | "information" | "warning";
};

function createMessageSink(messages: CapturedMessage[]): ProjectActionMessageSink {
  return {
    showErrorMessage: async (message: string) => {
      messages.push({ message, severity: "error" });
    },
    showInformationMessage: async (message: string) => {
      messages.push({ message, severity: "information" });
    },
    showWarningMessage: async (message: string) => {
      messages.push({ message, severity: "warning" });
    },
  };
}

describe("project action messages", () => {
  test("shows successful Accept All summaries as information", async () => {
    const messages: CapturedMessage[] = [];
    const summary: ProjectActionSummary = {
      attempted: 3,
      failed: [],
      succeeded: ["added.ts", "deleted.ts", "modified.ts"],
      total: 3,
    };

    await showProjectActionSummaryMessage(createMessageSink(messages), "accept", summary);

    expect(messages).toEqual([
      {
        message: "Inline Diff accepted 3 changed files.",
        severity: "information",
      },
    ]);
  });

  test("shows best-effort Reject All failures after every file was attempted", async () => {
    const messages: CapturedMessage[] = [];
    const summary: ProjectActionSummary = {
      attempted: 3,
      failed: [{ error: "Cannot reject deleted.ts", relativePath: "deleted.ts" }],
      succeeded: ["added.ts", "modified.ts"],
      total: 3,
    };

    await showProjectActionSummaryMessage(createMessageSink(messages), "reject", summary);

    expect(messages).toEqual([
      {
        message:
          "Inline Diff rejected 2 of 3 changed files. Failed: deleted.ts (Cannot reject deleted.ts). All remaining changed files were attempted. Successful files were not rolled back.",
        severity: "warning",
      },
    ]);
  });
});
