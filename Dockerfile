# Build the browser bundle on glibc. Rolldown's Alpine ARM64 binding can hang
# during Vite builds, and the player does not need server install scripts.
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS player-build

WORKDIR /app

COPY package.json package-lock.json ./
COPY player/package.json player/
RUN npm ci --ignore-scripts --workspace player

COPY player/ player/
RUN npm run build -w player

# Use an immutable Deno release image as the runtime source.
FROM denoland/deno:alpine-2.9.3@sha256:9d590d72116913ec9d73acb25112040fbffa657e33565075e7e71904b09e110e AS deno-runtime

# Compile production-only native dependencies against the final glibc runtime.
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS production-deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --omit=dev --workspace server

# Production stage — only runtime deps + pinned external tools
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG YT_DLP_VERSION=2026.06.09
ARG YT_DLP_SHA256=e5d57466682cfa9d61e9cf7c8a4f09b00f4a62af37d3bbdc4bcffdf63615feac

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deno-runtime /bin/deno /usr/local/bin/deno

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server/package.json server/
COPY --chown=node:node --from=production-deps /app/node_modules/ node_modules/

COPY --chown=node:node server/ server/
COPY --chown=node:node --from=player-build /app/player/dist/ player/dist/

ENV NODE_ENV=production

EXPOSE 9090

RUN chown node:node /app
USER node

CMD ["node", "server/index.js"]
