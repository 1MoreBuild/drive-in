# Build stage — install all deps and build player
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY player/package.json player/
COPY cli/package.json cli/
RUN npm ci

COPY player/ player/
RUN npm run build -w player

# Production stage — only runtime deps + external tools
FROM node:20-alpine

RUN apk add --no-cache \
    python3 \
    ffmpeg \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && rm -rf /tmp/* /var/cache/apk/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY player/package.json player/
COPY cli/package.json cli/
RUN npm ci --omit=dev

COPY server/ server/
COPY cli/ cli/
COPY player/index.html player/
COPY --from=build /app/player/dist/ player/dist/

ENV NODE_ENV=production

EXPOSE 9090

CMD ["node", "server/index.js"]
