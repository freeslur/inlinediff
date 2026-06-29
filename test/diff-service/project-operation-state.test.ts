import { describe, expect, test } from "bun:test";
import { ProjectOperationState } from "../../src/diff-service/project-operation-state.ts";

describe("ProjectOperationState", () => {
  test("blocks every operation in the same project and hides only its pending hunk", () => {
    const state = new ProjectOperationState();

    const operation = state.begin("C:/project", {
      hunkId: "first",
      relativePath: "src/file.ts",
    });

    expect(operation).toBeDefined();
    expect(state.begin("C:/project")).toBeUndefined();
    expect(state.isBusy("C:/project")).toBe(true);
    expect(state.isPendingHunk("C:/project", "src/file.ts", "first")).toBe(true);
    expect(state.isPendingHunk("C:/project", "src/file.ts", "second")).toBe(false);
  });

  test("allows another operation after the active operation ends", () => {
    const state = new ProjectOperationState();
    const operation = state.begin("C:/project");
    if (operation === undefined) {
      throw new Error("Expected an operation.");
    }

    state.end(operation);

    expect(state.isBusy("C:/project")).toBe(false);
    expect(state.begin("C:/project")).toBeDefined();
  });

  test("does not block a different project", () => {
    const state = new ProjectOperationState();
    state.begin("C:/project-a");

    expect(state.begin("C:/project-b")).toBeDefined();
  });
});
