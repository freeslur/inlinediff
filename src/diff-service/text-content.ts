import { detect } from "chardet";
import * as iconv from "iconv-lite";

export const binaryDetectionSampleSize = 8192;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isBinaryContent(content: Uint8Array): boolean {
  if (content.length === 0 || detectBomEncoding(content) !== undefined) {
    return false;
  }

  const sample = content.subarray(0, binaryDetectionSampleSize);
  let nullBytes = 0;
  let suspiciousControlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      nullBytes += 1;
    }
    if ((byte < 8 || (byte > 13 && byte < 32) || byte === 127) && byte !== 0) {
      suspiciousControlBytes += 1;
    }
  }

  // Any null byte means binary unless the sample looks like UTF-16. Files shorter than 4 bytes can't
  // be confirmed as UTF-16, so a stray null there reads as binary — acceptable for such tiny inputs.
  if (nullBytes > 0 && detectUtf16Encoding(sample) === undefined) {
    return true;
  }
  // A high ratio of other control bytes signals binary; the 0.3 cutoff tolerates the occasional
  // control character in legitimate text while still catching binary blobs.
  return suspiciousControlBytes / sample.length > 0.3;
}

export function decodeTextContent(content: Uint8Array): string {
  if (isBinaryContent(content)) {
    throw new Error("Binary file is outside Inline Diff scope.");
  }

  const buffer = Buffer.from(content);
  const bomEncoding = detectBomEncoding(content);
  const encoding = bomEncoding ?? detectEncoding(buffer);
  return iconv.decode(buffer, encoding);
}

function detectEncoding(content: Buffer): iconv.Encoding {
  try {
    utf8Decoder.decode(content);
    return "utf8";
  } catch {
    const utf16Encoding = detectUtf16Encoding(content);
    if (utf16Encoding !== undefined) {
      return utf16Encoding;
    }
    const detected = detect(content);
    if (detected !== null && detected !== "ASCII" && iconv.encodingExists(detected)) {
      return detected;
    }
    return "latin1";
  }
}

function detectBomEncoding(content: Uint8Array): iconv.Encoding | undefined {
  if (startsWith(content, [0xef, 0xbb, 0xbf])) {
    return "utf8";
  }
  if (startsWith(content, [0xff, 0xfe, 0x00, 0x00])) {
    return "utf32le";
  }
  if (startsWith(content, [0x00, 0x00, 0xfe, 0xff])) {
    return "utf32be";
  }
  if (startsWith(content, [0xff, 0xfe])) {
    return "utf16le";
  }
  if (startsWith(content, [0xfe, 0xff])) {
    return "utf16be";
  }
  return undefined;
}

function detectUtf16Encoding(content: Uint8Array): iconv.Encoding | undefined {
  if (content.length < 4) {
    return undefined;
  }

  // UTF-16 text usually has null bytes in one lane of each 2-byte pair. The
  // opposing-lane threshold avoids treating sparse binary nulls as text.
  let evenNulls = 0;
  let oddNulls = 0;
  const pairs = Math.floor(content.length / 2);
  for (let index = 0; index < pairs * 2; index += 2) {
    if (content[index] === 0) {
      evenNulls += 1;
    }
    if (content[index + 1] === 0) {
      oddNulls += 1;
    }
  }

  if (oddNulls / pairs > 0.6 && evenNulls / pairs < 0.2) {
    return "utf16le";
  }
  if (evenNulls / pairs > 0.6 && oddNulls / pairs < 0.2) {
    return "utf16be";
  }
  return undefined;
}

function startsWith(content: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => content[index] === byte);
}
