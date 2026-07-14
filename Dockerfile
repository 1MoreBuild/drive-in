# Build the browser bundle on glibc. Rolldown's Alpine ARM64 binding can hang
# during Vite builds, and the player does not need server install scripts.
FROM node:20-bookworm-slim AS player-build

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY player/package.json player/
COPY cli/package.json cli/
RUN npm ci --ignore-scripts

COPY player/ player/
RUN npm run build -w player

# Compile production-only native dependencies against Alpine/musl.
FROM node:20-alpine AS production-deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY player/package.json player/
COPY cli/package.json cli/
RUN npm ci --omit=dev

# Production stage — only runtime deps + external tools
FROM node:20-alpine

RUN apk add --no-cache \
    python3 \
    ffmpeg \
    curl \
    unzip \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && rm -rf /tmp/* /var/cache/apk/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY player/package.json player/
COPY cli/package.json cli/
COPY --from=production-deps /app/node_modules/ node_modules/

COPY server/ server/
COPY --from=player-build /app/player/dist/ player/dist/

ENV NODE_ENV=production

EXPOSE 9090

CMD ["node", "server/index.js"]
