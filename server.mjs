import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  FAILURE_MESSAGES,
  SUPPORTED_FORMATS,
  classifyYtdlpFailure,
  extensionForFormat,
  parseFfprobeDuration,
  safeEqual,
  sanitizeFilename,
  signMedia,
  verifyMediaSignature,
  ytdlpArgsForFormat,
} from "./lib.mjs";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL?.trim() || `http://localhost:${PORT}`
).replace(/\/+$/, "");
const PROVIDER_TOKEN = process.env.PROVIDER_TOKEN ?? "";
const CALLBACK_SECRET = process.env.CALLBACK_SECRET ?? "";
const MEDIA_SIGNING_SECRET =
  process.env.MEDIA_SIGNING_SECRET || CALLBACK_SECRET;
const MEDIA_TTL_SECONDS = Number(process.env.MEDIA_TTL_SECONDS ?? 300);
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_JOBS ?? 2),
);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 240_000);
const YTDLP_PATH = process.env.YTDLP_PATH ?? "yt-dlp";
const FFPROBE_PATH = process.env.FFPROBE_PATH ?? "ffprobe";
const WORK_DIR = process.env.WORK_DIR ?? "/tmp/downloader";
const MEDIA_DIR = path.join(WORK_DIR, "media");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_URL_RE = /^https?:\/\//i;

mkdirSync(MEDIA_DIR, { recursive: true });

/** fileId -> { path, filename, expiresAt } */
const media = new Map();
const queue = [];
let active = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How much of the extractor output to keep in a log line; the tail matters most. */
const STDERR_LOG_LIMIT = 2000;

/**
 * Emit the raw extractor output so a failure can be diagnosed from the host's
 * logs instead of being collapsed to a generic visitor-facing message. The
 * visitor never sees this; only Render's log stream does.
 */
function logFailure(jobId, stage, kind, detail) {
  const tail = String(detail ?? "").trim();
  const suffix = tail.length > 0 ? ` :: ${tail.slice(-STDERR_LOG_LIMIT)}` : "";
  console.error(
    `[downloader] job=${jobId} stage=${stage} kind=${kind}${suffix}`,
  );
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        return resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        return reject(error);
      }
    });
    req.on("error", reject);
  });
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function validateJob(body) {
  if (!body || typeof body !== "object") return null;
  const {
    jobId,
    url,
    format,
    callbackUrl,
    maxDurationSeconds,
    maxSizeBytes,
    linkTtlSeconds,
  } = body;
  if (typeof jobId !== "string" || !UUID_RE.test(jobId)) return null;
  if (typeof url !== "string" || !HTTP_URL_RE.test(url)) return null;
  if (!SUPPORTED_FORMATS.includes(format)) return null;
  if (typeof callbackUrl !== "string" || !HTTP_URL_RE.test(callbackUrl))
    return null;
  const duration = Number(maxDurationSeconds);
  const size = Number(maxSizeBytes);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  // Optional: the app may tune the signed link's lifetime; fall back to the env
  // default when it is absent or unusable.
  const ttl = Number(linkTtlSeconds);
  const linkTtl = Number.isFinite(ttl) && ttl > 0 ? ttl : null;
  return {
    jobId,
    url,
    format,
    callbackUrl,
    maxDurationSeconds: duration,
    maxSizeBytes: size,
    linkTtlSeconds: linkTtl,
  };
}

async function probe(url) {
  const result = await runCommand(
    YTDLP_PATH,
    ["-J", "--no-playlist", "--no-warnings", "--skip-download", "--", url],
    60_000,
  );
  if (result.code !== 0)
    return {
      ok: false,
      kind: classifyYtdlpFailure(result.stderr),
      stderr: result.stderr,
    };
  try {
    const info = JSON.parse(result.stdout);
    return {
      ok: true,
      title: typeof info.title === "string" ? info.title : null,
      duration: typeof info.duration === "number" ? info.duration : null,
    };
  } catch {
    return { ok: false, kind: "generic", stderr: result.stdout };
  }
}

function download(url, format, { jobId, maxSizeBytes }) {
  const outputTemplate = path.join(WORK_DIR, `${jobId}.%(ext)s`);
  return runCommand(
    YTDLP_PATH,
    [
      "--no-playlist",
      "--no-progress",
      "--no-warnings",
      "--max-filesize",
      String(maxSizeBytes),
      "-o",
      outputTemplate,
      ...ytdlpArgsForFormat(format),
      "--",
      url,
    ],
    JOB_TIMEOUT_MS,
  );
}

function findOutput(jobId, ext) {
  const exact = path.join(WORK_DIR, `${jobId}.${ext}`);
  if (existsSync(exact)) return exact;
  const match = readdirSync(WORK_DIR).find(
    (name) => name.startsWith(`${jobId}.`) && !name.endsWith(".part"),
  );
  return match ? path.join(WORK_DIR, match) : null;
}

async function probeDuration(filePath) {
  const result = await runCommand(
    FFPROBE_PATH,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    20_000,
  );
  return result.code === 0 ? parseFfprobeDuration(result.stdout) : null;
}

async function postCallback(callbackUrl, payload) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-downloader-callback-secret": CALLBACK_SECRET,
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return;
    } catch {
      // retry below
    }
    await sleep(attempt * 1000);
  }
}

async function handleJob(job) {
  const {
    jobId,
    url,
    format,
    callbackUrl,
    maxDurationSeconds,
    maxSizeBytes,
    linkTtlSeconds,
  } = job;
  let workFile = null;
  try {
    // Record the raw extractor output in the host log and echo the machine-
    // readable kind back to the app so a failure is diagnosable end to end.
    const fail = async (kind, stage, detail) => {
      logFailure(jobId, stage, kind, detail);
      await postCallback(callbackUrl, {
        jobId,
        status: "failed",
        code: kind,
        error: FAILURE_MESSAGES[kind] ?? FAILURE_MESSAGES.generic,
      });
    };

    const meta = await probe(url);
    if (!meta.ok) {
      await fail(meta.kind, "probe", meta.stderr);
      return;
    }
    if (meta.duration !== null && meta.duration > maxDurationSeconds) {
      await fail("duration", "duration");
      return;
    }

    const result = await download(url, format, { jobId, maxSizeBytes });
    if (result.timedOut || result.code !== 0) {
      if (result.timedOut) {
        await fail("timeout", "download-timeout");
      } else {
        await fail(
          classifyYtdlpFailure(result.stderr),
          "download",
          result.stderr,
        );
      }
      return;
    }

    const expectedExt = extensionForFormat(format);
    workFile = findOutput(jobId, expectedExt);
    if (!workFile) {
      await fail("generic", "output-missing");
      return;
    }

    // Trust the container yt-dlp actually produced over the requested one, so the
    // filename and Content-Type always match the bytes (a fallback format may be
    // a single file yt-dlp did not remux).
    const ext =
      path.extname(workFile).replace(/^\./, "").toLowerCase() || expectedExt;
    const sizeBytes = statSync(workFile).size;
    if (sizeBytes > maxSizeBytes) {
      await fail("size", "size");
      return;
    }

    const durationSeconds =
      (await probeDuration(workFile)) ?? meta.duration ?? 0;

    const fileId = randomUUID();
    const ttlSeconds = linkTtlSeconds ?? MEDIA_TTL_SECONDS;
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    const finalPath = path.join(MEDIA_DIR, `${fileId}.${ext}`);
    renameSync(workFile, finalPath);
    workFile = null;

    const filename = `${sanitizeFilename(meta.title, jobId)}.${ext}`;
    media.set(fileId, { path: finalPath, filename, expiresAt: expiresAtMs });

    const signature = signMedia(fileId, expiresAtMs, MEDIA_SIGNING_SECRET);
    await postCallback(callbackUrl, {
      jobId,
      status: "ready",
      platform: hostnameOf(url),
      durationSeconds,
      file: {
        url: `${PUBLIC_BASE_URL}/media/${fileId}?exp=${expiresAtMs}&sig=${signature}`,
        filename,
        sizeBytes,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    });
  } catch (error) {
    logFailure(jobId, "exception", "generic", error?.stack ?? error);
    await postCallback(callbackUrl, {
      jobId,
      status: "failed",
      code: "generic",
      error: FAILURE_MESSAGES.generic,
    });
  } finally {
    if (workFile) rmSync(workFile, { force: true });
  }
}

function pump() {
  while (active < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const job = queue.shift();
    active += 1;
    handleJob(job)
      .catch(() => {})
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function contentTypeFor(filename) {
  if (filename.endsWith(".mp3")) return "audio/mpeg";
  if (filename.endsWith(".m4a")) return "audio/mp4";
  if (filename.endsWith(".webm")) return "video/webm";
  if (filename.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function serveMedia(res, fileId, searchParams) {
  const entry = media.get(fileId);
  const expiresAtMs = Number(searchParams.get("exp"));
  const signature = searchParams.get("sig") ?? "";
  const valid =
    entry &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > Date.now() &&
    verifyMediaSignature({
      fileId,
      expiresAtMs,
      signature,
      secret: MEDIA_SIGNING_SECRET,
    });
  if (!valid) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  res.writeHead(200, {
    "content-type": contentTypeFor(entry.filename),
    "content-length": statSync(entry.path).size,
    "content-disposition": contentDisposition(entry.filename),
    "cache-control": "no-store",
  });
  const stream = createReadStream(entry.path);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  res.on("close", () => {
    rmSync(entry.path, { force: true });
    media.delete(fileId);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://internal");

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/healthz")
  ) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/dispatch") {
    const supplied = (req.headers.authorization ?? "").replace(
      /^Bearer\s+/i,
      "",
    );
    if (!safeEqual(supplied, PROVIDER_TOKEN)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid body" });
      return;
    }
    const job = validateJob(body);
    if (!job) {
      sendJson(res, 400, { error: "invalid job" });
      return;
    }
    sendJson(res, 202, { accepted: true });
    queue.push(job);
    pump();
    return;
  }

  const mediaMatch = url.pathname.match(/^\/media\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && mediaMatch) {
    serveMedia(res, mediaMatch[1], url.searchParams);
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`downloader-host listening on :${PORT}`);
});

setInterval(() => {
  const now = Date.now();
  for (const [fileId, entry] of media) {
    if (entry.expiresAt <= now) {
      rmSync(entry.path, { force: true });
      media.delete(fileId);
    }
  }
}, 60_000).unref();
