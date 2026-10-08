import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyYtdlpFailure,
  extensionForFormat,
  parseFfprobeDuration,
  safeEqual,
  sanitizeFilename,
  signMedia,
  verifyMediaSignature,
  ytdlpArgsForFormat,
} from "../lib.mjs";

test("ytdlpArgsForFormat maps each supported format and rejects others", () => {
  assert.ok(ytdlpArgsForFormat("audio").includes("-x"));
  assert.ok(ytdlpArgsForFormat("audio").includes("m4a"));
  assert.ok(
    ytdlpArgsForFormat("video-720p").some((arg) => arg.includes("height<=720")),
  );
  assert.throws(() => ytdlpArgsForFormat("video-4k"), /unsupported/);
});

test("extensionForFormat", () => {
  assert.equal(extensionForFormat("audio"), "m4a");
  assert.equal(extensionForFormat("video-1080p"), "mp4");
  assert.throws(() => extensionForFormat("nope"));
});

test("media signature round-trips and rejects tampering", () => {
  const signature = signMedia("id-1", 12345, "secret");
  assert.ok(
    verifyMediaSignature({
      fileId: "id-1",
      expiresAtMs: 12345,
      signature,
      secret: "secret",
    }),
  );
  assert.ok(
    !verifyMediaSignature({
      fileId: "id-2",
      expiresAtMs: 12345,
      signature,
      secret: "secret",
    }),
  );
  assert.ok(
    !verifyMediaSignature({
      fileId: "id-1",
      expiresAtMs: 12345,
      signature,
      secret: "other",
    }),
  );
});

test("safeEqual is fail-closed on empty input", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("", ""));
  assert.ok(!safeEqual("abc", ""));
});

test("sanitizeFilename strips path and control characters", () => {
  assert.equal(sanitizeFilename("a/b\\c:d", "fallback"), "a b c d");
  assert.equal(sanitizeFilename("", "fallback"), "fallback");
  assert.equal(sanitizeFilename(null, "fallback"), "fallback");
});

test("parseFfprobeDuration", () => {
  assert.equal(parseFfprobeDuration("123.456\n"), 123.456);
  assert.equal(parseFfprobeDuration("N/A"), null);
  assert.equal(parseFfprobeDuration(""), null);
});

test("classifyYtdlpFailure", () => {
  assert.equal(classifyYtdlpFailure("ERROR: does not pass filter"), "duration");
  assert.equal(classifyYtdlpFailure("ERROR: larger than max-filesize"), "size");
  assert.equal(classifyYtdlpFailure("ERROR: Unsupported URL"), "unsupported");
  assert.equal(classifyYtdlpFailure("boom"), "generic");
});
