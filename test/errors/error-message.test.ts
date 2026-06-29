import { describe, expect, test } from "bun:test";
import { toErrorMessage } from "../../src/errors/error-message.ts";

describe("toErrorMessage", () => {
  test("returns Error messages", () => {
    expect(toErrorMessage(new Error("failed"))).toBe("failed");
  });

  test("returns string errors and a fallback for unknown values", () => {
    expect(toErrorMessage("failed")).toBe("failed");
    expect(toErrorMessage({ reason: "failed" })).toBe("Unknown error");
  });
});
