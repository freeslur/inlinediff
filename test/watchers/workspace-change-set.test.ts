import { describe, expect, test } from "bun:test";
import { processWorkspaceChanges } from "../../src/watchers/workspace-change-set.ts";

describe("processWorkspaceChanges", () => {
  test("marks every change before processing and continues after one item fails", async () => {
    const events: string[] = [];
    const errors: string[] = [];

    await processWorkspaceChanges(
      ["first", "second"],
      (value) => events.push(`mark:${value}`),
      async (value) => {
        events.push(`process:${value}`);
        if (value === "first") {
          throw new Error("failed");
        }
      },
      (error) => {
        if (error instanceof Error) {
          errors.push(error.message);
          return;
        }
        throw error;
      },
    );

    expect(events).toEqual(["mark:first", "mark:second", "process:first", "process:second"]);
    expect(errors).toEqual(["failed"]);
  });
});
