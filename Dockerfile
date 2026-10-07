FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY lib.mjs server.mjs ./

ENV NODE_ENV=production \
    PORT=8080 \
    WORK_DIR=/tmp/downloader

EXPOSE 8080
CMD ["node", "server.mjs"]
