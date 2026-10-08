import { createHmac, timingSafeEqual } from "node:crypto";

/** Formats the app may dispatch (must match shared/contracts/downloader.ts). */
export const SUPPORTED_FORMATS = [
  "audio",
  "audio-mp3",
  "video-360p",
  "video-480p",
  "video-720p",
  "video-1080p",
  "image-original",
  "image-jpg",
  "image-png",
  "image-webp",
];

const FORMAT_ARGS = {
  audio: ["-x", "--audio-format", "m4a", "--audio-quality", "0"],
  "audio-mp3": ["-x", "--audio-format", "mp3", "--audio-quality", "0"],
  "video-360p": [
    "-f",
    "bv*[height<=360]+ba/b[height<=360]/b",
    "--merge-output-format",
    "mp4",
  ],
  "video-480p": [
    "-f",
    "bv*[height<=480]+ba/b[height<=480]/b",
    "--merge-output-format",
    "mp4",
  ],
  "video-720p": [
    "-f",
    "bv*[height<=720]+ba/b[height<=720]/b",
    "--merge-output-format",
    "mp4",
  ],
  "video-1080p": [
    "-f",
    "bv*[height<=1080]+ba/b[height<=1080]/b",
    "--merge-output-format",
    "mp4",
  ],
  // Images download as-is; a jpg/png/webp request is recoded with ffmpeg after.
  "image-original": [],
  "image-jpg": [],
  "image-png": [],
  "image-webp": [],
};

const FORMAT_EXT = {
  audio: "m4a",
  "audio-mp3": "mp3",
  "video-360p": "mp4",
  "video-480p": "mp4",
  "video-720p": "mp4",
  "video-1080p": "mp4",
  "image-original": "jpg",
  "image-jpg": "jpg",
  "image-png": "png",
  "image-webp": "webp",
};

/**
 * Visitor-facing reasons, keyed by failure kind (the same string is echoed to
 * the app as `code`). Keep `generic` as the catch-all: a distinct message must
 * mean the extractor was actually understood, not guessed.
 */
export const FAILURE_MESSAGES = {
  duration: "مدة الوسائط تتجاوز الحدّ المسموح (15 دقيقة).",
  size: "حجم الملف يتجاوز الحدّ المسموح.",
  unsupported: "هذا الرابط غير مدعوم.",
  blocked: "الموقع يحجب خادم التنزيل مؤقتًا؛ حاول مجددًا بعد قليل.",
  unavailable: "هذا الفيديو غير متاح.",
  timeout: "استغرق تنزيل الوسائط وقتًا أطول من المتوقع.",
  generic: "تعذّر تنزيل الوسائط من هذا الرابط.",
};

/**
 * yt-dlp arguments shared by the probe and download calls. YouTube bot-checks
 * the `web` client hardest from a datacenter IP, so we ask for a spread of
 * clients (`default` expands to the jslss set on an image without Deno, then
 * `tv` and `web_safari`). `tv` is normally token-free; `web_safari` often
 * escapes the check where `web` does not.
 */
export const YTDLP_YOUTUBE_ARGS = [
  "--extractor-args",
  "youtube:player_client=default,tv,web_safari",
];

/**
 * Network-resilience flags shared by the probe and download calls: a transient
 * socket or segment failure should be retried inside yt-dlp, not surfaced as a
 * failed download.
 */
export const YTDLP_NETWORK_ARGS = [
  "--socket-timeout",
  "15",
  "--retries",
  "5",
  "--fragment-retries",
  "5",
  "--extractor-retries",
  "3",
];

export function ytdlpArgsForFormat(format) {
  const args = FORMAT_ARGS[format];
  if (!args) throw new Error(`unsupported format: ${format}`);
  return args;
}

export function extensionForFormat(format) {
  const ext = FORMAT_EXT[format];
  if (!ext) throw new Error(`unsupported format: ${format}`);
  return ext;
}

export function signMedia(fileId, expiresAtMs, secret) {
  return createHmac("sha256", secret)
    .update(`${fileId}.${expiresAtMs}`)
    .digest("hex");
}

export function verifyMediaSignature({
  fileId,
  expiresAtMs,
  signature,
  secret,
}) {
  const expected = Buffer.from(signMedia(fileId, expiresAtMs, secret));
  const supplied = Buffer.from(String(signature ?? ""));
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

/** Constant-time compare that fails closed when either side is empty. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return (
    left.length > 0 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

export function sanitizeFilename(name, fallback) {
  const base = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base.length > 0 ? base.slice(0, 120) : fallback;
}

export function parseFfprobeDuration(stdout) {
  const value = Number.parseFloat(String(stdout).trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Extensions yt-dlp reports for still-image extractors (a link can be a photo). */
export const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "avif",
  "svg",
]);

function streams(info) {
  return Array.isArray(info?.formats) ? info.formats : [];
}

function hasVideo(f) {
  return typeof f.vcodec === "string" && f.vcodec !== "none";
}
function hasAudio(f) {
  return typeof f.acodec === "string" && f.acodec !== "none";
}

/**
 * The broad kind of media a yt-dlp `-J` payload describes. Prefers the presence
 * of real streams; falls back to the reported container extension for image
 * extractors, which often expose no `formats`.
 */
export function deriveMediaType(info) {
  const list = streams(info);
  if (list.some(hasVideo)) return "video";
  if (list.some(hasAudio)) return "audio";
  const ext = String(info?.ext ?? "").toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (hasVideo({ vcodec: info?.vcodec })) return "video";
  if (hasAudio({ acodec: info?.acodec })) return "audio";
  return "unknown";
}

/** A stream's byte size: exact, approximate, or estimated from its bitrate. */
function bytesOf(f, duration) {
  if (!f) return null;
  if (typeof f.filesize === "number") return f.filesize;
  if (typeof f.filesize_approx === "number") return f.filesize_approx;
  if (typeof f.tbr === "number" && duration) {
    return Math.round(((f.tbr * 1000) / 8) * duration);
  }
  return null;
}

/** Best stream from a list, by bitrate then declared size. */
function pickBest(list) {
  let best = null;
  let bestScore = -1;
  for (const f of list) {
    const score =
      (typeof f.tbr === "number" ? f.tbr : 0) * 1e6 +
      (typeof f.filesize === "number" ? f.filesize : 0);
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

/** Highest-resolution stream at or below `height`. */
function bestAtHeight(list, height) {
  const within = list.filter(
    (f) => typeof f.height === "number" && f.height <= height,
  );
  if (within.length === 0) return null;
  return within.reduce((best, f) =>
    (f.height ?? 0) > (best.height ?? 0) ? f : best,
  );
}

/**
 * Estimate the size of each Download format we would offer for a link. Mirrors
 * the app's `DownloadFormat` vocabulary; `null` means "unknown" and the UI says
 * so rather than guessing. Image formats are added in Phase 2.
 */
export function estimateFormatSizes(info, mediaType) {
  const duration = typeof info?.duration === "number" ? info.duration : null;
  const list = streams(info);
  const audioOnly = list.filter((f) => hasAudio(f) && !hasVideo(f));
  const videoOnly = list.filter((f) => hasVideo(f) && !hasAudio(f));
  const progressive = list.filter((f) => hasVideo(f) && hasAudio(f));
  const bestAudio = pickBest(audioOnly) ?? pickBest(progressive);

  if (mediaType === "audio") {
    const bytes = bytesOf(bestAudio ?? info, duration);
    return [
      { format: "audio", filesizeBytes: bytes },
      { format: "audio-mp3", filesizeBytes: bytes },
    ];
  }

  if (mediaType === "image") {
    const original = [
      { format: "image-original", filesizeBytes: bytesOf(info, null) },
    ];
    // svg is a source format only — ffmpeg cannot produce it, so no recodes.
    if (String(info?.ext ?? "").toLowerCase() === "svg") return original;
    return [
      ...original,
      { format: "image-jpg", filesizeBytes: null },
      { format: "image-png", filesizeBytes: null },
      { format: "image-webp", filesizeBytes: null },
    ];
  }

  if (mediaType !== "video") return [];

  const audioBytes = bytesOf(bestAudio, duration);
  const out = [];
  for (const [height, format] of [
    [360, "video-360p"],
    [480, "video-480p"],
    [720, "video-720p"],
    [1080, "video-1080p"],
  ]) {
    const video =
      bestAtHeight(videoOnly, height) ?? bestAtHeight(progressive, height);
    if (!video) {
      out.push({ format, filesizeBytes: null });
      continue;
    }
    let bytes = bytesOf(video, duration);
    if (bytes !== null && !hasAudio(video) && audioBytes !== null)
      bytes += audioBytes;
    out.push({ format, filesizeBytes: bytes });
  }
  out.push({ format: "audio", filesizeBytes: audioBytes });
  out.push({ format: "audio-mp3", filesizeBytes: audioBytes });
  return out;
}

export function classifyYtdlpFailure(stderr) {
  const text = String(stderr ?? "");
  if (/does not pass filter/i.test(text)) return "duration";
  if (/max-filesize|larger than max/i.test(text)) return "size";
  // The extractor is being refused by the platform: bot checks, rate limits and
  // IP/geo blocks. Checked before `unsupported`, whose "unable to extract" catch
  // would otherwise swallow these.
  if (
    /sign in to confirm|not a bot|cookies|http error 403|forbidden|\b429\b|too many requests|rate.?limit|blocked|unable to download webpage|temporary failure in name resolution/i.test(
      text,
    )
  ) {
    return "blocked";
  }
  // The link itself resolves but the media is gone or gated for this caller.
  if (
    /private video|video unavailable|not available in your country|has been removed|removed by the uploader|account.*terminated|members-only|age.?restricted|sign in to view|login required|this video is not available/i.test(
      text,
    )
  ) {
    return "unavailable";
  }
  if (
    /unsupported url|is not a valid url|no video formats found|unable to extract/i.test(
      text,
    )
  ) {
    return "unsupported";
  }
  return "generic";
}
