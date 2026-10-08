import { createHmac, timingSafeEqual } from "node:crypto";

/** Formats the app may dispatch (must match shared/contracts/downloader.ts). */
export const SUPPORTED_FORMATS = [
  "audio",
  "video-360p",
  "video-720p",
  "video-1080p",
];

const FORMAT_ARGS = {
  audio: ["-x", "--audio-format", "m4a", "--audio-quality", "0"],
  "video-360p": [
    "-f",
    "bv*[height<=360]+ba/b[height<=360]/b",
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
};

const FORMAT_EXT = {
  audio: "m4a",
  "video-360p": "mp4",
  "video-720p": "mp4",
  "video-1080p": "mp4",
};

/** Visitor-facing reasons, matching what the app surfaces on a `failed` job. */
export const FAILURE_MESSAGES = {
  duration: "مدة الوسائط تتجاوز الحدّ المسموح (15 دقيقة).",
  size: "حجم الملف يتجاوز الحدّ المسموح.",
  unsupported: "هذا الرابط غير مدعوم.",
  generic: "تعذّر تنزيل الوسائط من هذا الرابط.",
};

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

export function classifyYtdlpFailure(stderr) {
  const text = String(stderr ?? "");
  if (/does not pass filter/i.test(text)) return "duration";
  if (/max-filesize|larger than max/i.test(text)) return "size";
  if (
    /unsupported url|is not a valid url|no video formats found|unable to extract/i.test(
      text,
    )
  ) {
    return "unsupported";
  }
  return "generic";
}
