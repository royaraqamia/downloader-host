# downloader-host

Self-hosted media download host for **royaraqamia**'s Media Downloader. It is the
implementation behind the app's `MediaProvider` port: the app hands over a
**Download Job**, this service extracts and converts the media with `yt-dlp` +
`ffmpeg`, and reports the result back through a signed callback.

The wire contract of record lives in the app repository:
`docs/downloader-provider.md`. Keep the two in sync.

## How it works

1. The app `POST`s a job to `/dispatch` (Bearer token) and this host replies `202`
   immediately — before doing any work.
2. The host probes the link with `yt-dlp` (title + duration), enforces the duration
   and size caps, downloads and converts, then stores the file.
3. The host `POST`s the result to the app's callback URL (shared secret): a
   `ready` payload with a short-lived signed media link, or a `failed` payload with
   a visitor-readable reason.
4. The media link is HMAC-signed and expires after the dispatch payload's
   `linkTtlSeconds` (falling back to `MEDIA_TTL_SECONDS`); the file is deleted
   once downloaded or expired.

The app never carries media bytes; the visitor downloads straight from here.

## Environment variables

| Variable               | Required | Default                 | Purpose                                                |
| ---------------------- | -------- | ----------------------- | ------------------------------------------------------ |
| `PUBLIC_BASE_URL`      | yes      | `http://localhost:PORT` | Public URL of this service; used to build media links. |
| `PROVIDER_TOKEN`       | yes      | —                       | Must equal the app's `DOWNLOADER_PROVIDER_TOKEN`.      |
| `CALLBACK_SECRET`      | yes      | —                       | Must equal the app's `DOWNLOADER_CALLBACK_SECRET`.     |
| `MEDIA_SIGNING_SECRET` | no       | `CALLBACK_SECRET`       | HMAC key for media links.                              |
| `PORT`                 | no       | `8080`                  | Listen port (Render sets this).                        |
| `MEDIA_TTL_SECONDS`    | no       | `300`                   | Media link lifetime; the app can override per job.     |
| `MAX_CONCURRENT_JOBS`  | no       | `2`                     | Jobs processed at once.                                |
| `JOB_TIMEOUT_MS`       | no       | `240000`                | Per-job ceiling.                                       |
| `WORK_DIR`             | no       | `/tmp/downloader`       | Scratch + served files.                                |

## Deploy on Render (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/royaraqamia/downloader-host)

**Blueprint (recommended):**

1. Render → **New → Blueprint** → select this repository (`render.yaml`).
2. When prompted, set `PUBLIC_BASE_URL`, `PROVIDER_TOKEN`, `CALLBACK_SECRET`
   (`MEDIA_SIGNING_SECRET` optional).
3. Deploy, then set `PUBLIC_BASE_URL` to the assigned `https://<name>.onrender.com`.

**Manual:** New → **Web Service** → Docker → this repo → **Free** plan → add the
env vars above → Deploy.

Generate secrets with `openssl rand -hex 32` (use a different value for each).

## Point the app at it

In the app's Vercel environment:

- `DOWNLOADER_PROVIDER_URL` = `https://<service>.onrender.com/dispatch`
- `DOWNLOADER_PROVIDER_TOKEN` = the same value as `PROVIDER_TOKEN`
- `DOWNLOADER_CALLBACK_SECRET` = the same value as `CALLBACK_SECRET`

Then redeploy the app. Setting `DOWNLOADER_PROVIDER_URL` switches the app off its
in-repo stub and onto this host.

## Run locally

```sh
docker build -t downloader-host .
docker run --rm -p 8080:8080 \
  -e PUBLIC_BASE_URL=http://localhost:8080 \
  -e PROVIDER_TOKEN=dev-token \
  -e CALLBACK_SECRET=dev-secret \
  downloader-host
```

## Tests

```sh
npm test
```

## Free-tier reality and the scaling path

- Render's free plan is **0.1 CPU / 512 MB** and sleeps after ~15 minutes idle.
  The app waits up to 55s for the `202`, so a cold start delays the first job
  instead of failing it.
- **Scale up** (first step, no app change): move to a paid Render instance or a
  VPS — same image, same env vars.
- **Scale out** (later): the media registry and queue are in-process memory, so a
  multi-instance setup needs shared storage (e.g. S3) and a shared queue. The app
  points at a single `DOWNLOADER_PROVIDER_URL`, so front N instances with a load
  balancer when you get there.

## Security

- `/dispatch` requires the Bearer token and fails closed.
- Media links are HMAC-signed and expire; files are removed after serving.
- The callback secret authenticates this host to the app.
