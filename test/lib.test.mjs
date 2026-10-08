import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_MESSAGES,
  YTDLP_NETWORK_ARGS,
  YTDLP_YOUTUBE_ARGS,
  classifyYtdlpFailure,
  deriveMediaType,
  estimateFormatSizes,
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

test("YTDLP_YOUTUBE_ARGS requests non-web clients to dodge the bot check", () => {
  const value = YTDLP_YOUTUBE_ARGS.join(" ");
  assert.match(value, /--extractor-args/);
  assert.match(value, /player_client=default,tv,web_safari/);
});

test("YTDLP_NETWORK_ARGS retries transient socket/segment failures", () => {
  const value = YTDLP_NETWORK_ARGS.join(" ");
  assert.match(value, /--socket-timeout 15/);
  assert.match(value, /--retries 5/);
  assert.match(value, /--fragment-retries 5/);
  assert.match(value, /--extractor-retries 3/);
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

test("classifyYtdlpFailure distinguishes platform blocks from unavailable media", () => {
  assert.equal(
    classifyYtdlpFailure(
      "ERROR: [youtube] x: Sign in to confirm you're not a bot. Use --cookies",
    ),
    "blocked",
  );
  assert.equal(
    classifyYtdlpFailure(
      "ERROR: unable to download webpage: HTTP Error 403: Forbidden",
    ),
    "blocked",
  );
  assert.equal(
    classifyYtdlpFailure("ERROR: HTTP Error 429: Too Many Requests"),
    "blocked",
  );
  assert.equal(
    classifyYtdlpFailure("ERROR: [youtube] x: Video unavailable"),
    "unavailable",
  );
  assert.equal(
    classifyYtdlpFailure(
      "ERROR: [youtube] x: This video is not available in your country",
    ),
    "unavailable",
  );
});

test("FAILURE_MESSAGES covers every kind the classifier can return", () => {
  const kinds = [
    "duration",
    "size",
    "unsupported",
    "blocked",
    "unavailable",
    "timeout",
    "generic",
  ];
  for (const kind of kinds) {
    assert.equal(typeof FAILURE_MESSAGES[kind], "string");
    assert.ok(FAILURE_MESSAGES[kind].length > 0);
  }
});

test("deriveMediaType reads streams then falls back to the container", () => {
  assert.equal(
    deriveMediaType({
      formats: [
        { vcodec: "avc1", acodec: "none", height: 720 },
        { vcodec: "none", acodec: "mp4a" },
      ],
    }),
    "video",
  );
  assert.equal(
    deriveMediaType({ formats: [{ vcodec: "none", acodec: "mp4a" }] }),
    "audio",
  );
  assert.equal(deriveMediaType({ ext: "jpg", formats: [] }), "image");
  assert.equal(deriveMediaType({ formats: [] }), "unknown");
});

test("estimateFormatSizes sums merged streams and estimates from bitrate", () => {
  const info = {
    duration: 100,
    formats: [
      { vcodec: "avc1", acodec: "none", height: 720, filesize: 8_000_000 },
      { vcodec: "avc1", acodec: "none", height: 360, filesize: 3_000_000 },
      { vcodec: "none", acodec: "mp4a", filesize: 1_000_000 },
    ],
  };
  const sizes = estimateFormatSizes(info, "video");
  const byFormat = Object.fromEntries(
    sizes.map((s) => [s.format, s.filesizeBytes]),
  );
  // 720p merges the best video + audio; 360p merges the 360p video + audio.
  assert.equal(byFormat["video-720p"], 9_000_000);
  assert.equal(byFormat["video-360p"], 4_000_000);
  // No 480p stream, so the 480p option falls back to the best at or below it (360p).
  assert.equal(byFormat["video-480p"], 4_000_000);
  assert.equal(byFormat.audio, 1_000_000);
  // 1080p has no stream at or below 1080 with video-only besides these; it reuses 720p.
  assert.equal(byFormat["video-1080p"], 9_000_000);
});

test("estimateFormatSizes estimates an audio-only link and derives from tbr", () => {
  const sizes = estimateFormatSizes(
    {
      duration: 10,
      formats: [{ vcodec: "none", acodec: "mp4a", tbr: 128 }],
    },
    "audio",
  );
  assert.deepEqual(sizes, [
    { format: "audio", filesizeBytes: 160_000 },
    { format: "audio-mp3", filesizeBytes: 160_000 },
  ]);
});

test("estimateFormatSizes offers image recodes but not for svg sources", () => {
  const jpg = estimateFormatSizes({ ext: "jpg", filesize: 2_000_000 }, "image");
  assert.deepEqual(
    jpg.map((s) => s.format),
    ["image-original", "image-jpg", "image-png", "image-webp"],
  );
  assert.equal(jpg[0].filesizeBytes, 2_000_000);

  const svg = estimateFormatSizes({ ext: "svg", filesize: 5000 }, "image");
  assert.deepEqual(svg, [{ format: "image-original", filesizeBytes: 5000 }]);
});
