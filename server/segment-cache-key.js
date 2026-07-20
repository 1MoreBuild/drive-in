import { createHash } from "node:crypto";
import { resolve } from "node:path";

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function snapshotProxyUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host.toLowerCase(),
      pathname: parsed.pathname || "/",
      params: Object.fromEntries(parsed.searchParams.entries()),
    };
  } catch {
    return { host: "", pathname: "", params: {} };
  }
}

export function normalizeRangeForCacheKey(rangeHeader = "") {
  const match = String(rangeHeader).match(/^bytes=(\d+)?-(\d+)?$/i);
  return { start: match?.[1] || "*", end: match?.[2] || "*" };
}

export function computeSegmentCacheKey(upstreamUrl, rangeHeader = "", cacheContext = null) {
  const urlInfo = snapshotProxyUrl(upstreamUrl);
  const hostCandidates = [urlInfo.host, cacheContext?.registeredUrlHost, cacheContext?.originalUrlHost]
    .filter(Boolean)
    .map((value) => value.toLowerCase());
  const mergedParams = {
    ...(cacheContext?.registeredUrlParams || {}),
    ...(cacheContext?.originalUrlParams || {}),
    ...urlInfo.params,
  };

  const isYouTubeSource = hostCandidates.some((host) => (
    host.includes("googlevideo.com") || host.includes("youtube.com") || host.includes("youtu.be")
  ));
  if (isYouTubeSource) {
    const required = ["id", "itag", "clen", "lmt"];
    if (required.every((key) => mergedParams[key])) {
      const range = normalizeRangeForCacheKey(rangeHeader);
      const logicalKey = `yt:${mergedParams.id}:${mergedParams.itag}:${mergedParams.clen}:${mergedParams.lmt}:${range.start}-${range.end}`;
      return {
        kind: "logical",
        sourceType: "youtube",
        logicalKey,
        filenameKey: sha256Hex(logicalKey),
      };
    }
  }

  const isBilibiliSource = hostCandidates.some((host) => host.includes("bilivideo.com"));
  if (isBilibiliSource && /\.m4s$/i.test(urlInfo.pathname)) {
    const range = normalizeRangeForCacheKey(rangeHeader);
    const logicalKey = `bili:${urlInfo.pathname}:${range.start}-${range.end}`;
    return {
      kind: "logical",
      sourceType: "bilibili",
      logicalKey,
      filenameKey: sha256Hex(logicalKey),
    };
  }

  const hlsPath = urlInfo.pathname || cacheContext?.registeredUrlPathname || cacheContext?.originalUrlPathname || "";
  if (hlsPath.toLowerCase().endsWith(".ts")) {
    const logicalKey = `hls:${sha256Hex(hlsPath)}`;
    return {
      kind: "logical",
      sourceType: "hls",
      logicalKey,
      filenameKey: sha256Hex(logicalKey),
    };
  }

  const fallbackHash = sha256Hex(`${upstreamUrl}\n${rangeHeader || ""}`);
  return {
    kind: "hash",
    sourceType: "fallback",
    logicalKey: `hash:${fallbackHash}`,
    filenameKey: fallbackHash,
  };
}

export function createSegmentCachePathResolver(cacheDir) {
  return function getSegmentCachePaths(upstreamUrl, rangeHeader = "", cacheContext = null) {
    const cacheKey = computeSegmentCacheKey(upstreamUrl, rangeHeader, cacheContext);
    return {
      ...cacheKey,
      key: cacheKey.filenameKey,
      dataPath: resolve(cacheDir, `${cacheKey.filenameKey}.dat`),
      metaPath: resolve(cacheDir, `${cacheKey.filenameKey}.meta`),
    };
  };
}
