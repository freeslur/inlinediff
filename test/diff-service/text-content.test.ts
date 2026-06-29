import { describe, expect, test } from "bun:test";
import { decodeTextContent, isBinaryContent } from "../../src/diff-service/text-content.ts";

describe("text content detection", () => {
  test("decodes valid UTF-8 text", () => {
    const content = Buffer.from("hello\n안녕하세요\n", "utf8");
    expect(isBinaryContent(content)).toBe(false);
    expect(decodeTextContent(content)).toBe("hello\n안녕하세요\n");
  });

  test("accepts and preserves UTF-16 text", () => {
    const content = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00, 0x0a, 0x00]);
    expect(isBinaryContent(content)).toBe(false);
    expect(decodeTextContent(content)).toBe("hi\n");
  });

  test("accepts non-UTF-8 single-byte text and rejects binary content", () => {
    expect(isBinaryContent(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBe(false);
    expect(isBinaryContent(Buffer.from([0x00, 0x01, 0x02, 0xff]))).toBe(true);
    expect(() => decodeTextContent(Buffer.from([0x00, 0x01, 0x02, 0xff]))).toThrow("Binary file");
  });
});
