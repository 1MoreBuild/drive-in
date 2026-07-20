import { lookup } from "dns/promises";
import http from "http";
import https from "https";
import { isIP } from "net";
import { isAbsolute, relative, resolve, sep } from "path";
import { realpathSync } from "fs";

export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export class SafeFetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "SafeFetchError";
    this.status = status;
  }
}

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return true;
  }
  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const halves = normalized.split("::");
  if (halves.length > 2) return true;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return true;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return true;
  const value = parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
  if (value === 0n || value === 1n) return true;
  const ipv4MappedPrefix = value >> 32n;
  if (ipv4MappedPrefix === 0xffffn) {
    const ipv4 = Number(value & 0xffffffffn);
    return isPrivateIpv4([
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ].join("."));
  }
  return value >> 32n === 0n // deprecated IPv4-compatible range
    || value >> 96n === 0x64ff9bn // NAT64 well-known prefix
    || value >> 80n === 0x64ff9b0001n // local-use NAT64 prefix
    || value >> 96n === 0x20010000n // Teredo
    || value >> 112n === 0x2002n // 6to4
    || value >> 121n === 0x7en // fc00::/7
    || value >> 118n === 0x3fan // fe80::/10
    || value >> 120n === 0xffn // multicast
    || value >> 96n === 0x20010db8n; // documentation
}

export function isPrivateAddress(address) {
  const normalized = String(address || "").replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return true;
}

export function isPathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveSubtitleFile(root, key, filename) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(key || ""))) return null;
  if (!/^sub_[A-Za-z0-9._-]{1,160}\.vtt$/.test(String(filename || ""))) return null;
  const candidate = resolve(root, key, filename);
  if (!isPathInside(root, candidate)) return null;
  try {
    const canonicalRoot = realpathSync(root);
    const canonicalFile = realpathSync(candidate);
    return isPathInside(canonicalRoot, canonicalFile) ? canonicalFile : null;
  } catch {
    return null;
  }
}

function validatePublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("Invalid thumbnail URL", 400);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new SafeFetchError("Unsupported thumbnail URL", 400);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new SafeFetchError("Private thumbnail hosts are not allowed", 403);
  }
  return url;
}

async function resolvePublicAddress(hostname) {
  hostname = String(hostname || "").replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new SafeFetchError("Private thumbnail addresses are not allowed", 403);
    return { address: hostname, family: isIP(hostname) };
  }
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError("Thumbnail host could not be resolved");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new SafeFetchError("Private thumbnail addresses are not allowed", 403);
  }
  return addresses[0];
}

function requestOnce(url, pinnedAddress, timeoutMs) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolveRequest, rejectRequest) => {
    const req = transport.get(url, {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8",
        "User-Agent": "Drive-In thumbnail proxy",
      },
      lookup: (_hostname, _options, callback) => {
        if (_options?.all) callback(null, [pinnedAddress]);
        else callback(null, pinnedAddress.address, pinnedAddress.family);
      },
    }, resolveRequest);
    req.setTimeout(timeoutMs, () => req.destroy(new SafeFetchError("Thumbnail request timed out", 504)));
    req.once("error", rejectRequest);
  });
}

async function readLimitedImage(response, maxBytes) {
  const contentType = String(response.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    response.resume();
    throw new SafeFetchError("Upstream did not return a supported image", 415);
  }
  const declaredLength = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.destroy();
    throw new SafeFetchError("Thumbnail is too large", 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response) {
    total += chunk.length;
    if (total > maxBytes) {
      response.destroy();
      throw new SafeFetchError("Thumbnail is too large", 413);
    }
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks, total), contentType };
}

export async function fetchPublicImage(rawUrl, {
  maxBytes = MAX_THUMBNAIL_BYTES,
  maxRedirects = MAX_REDIRECTS,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  let url = validatePublicUrl(rawUrl);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const pinnedAddress = await resolvePublicAddress(url.hostname);
    const response = await requestOnce(url, pinnedAddress, timeoutMs);
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new SafeFetchError("Thumbnail redirect had no location");
      if (redirectCount === maxRedirects) throw new SafeFetchError("Too many thumbnail redirects");
      url = validatePublicUrl(new URL(location, url).href);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw new SafeFetchError(`Thumbnail upstream returned ${response.statusCode}`, response.statusCode);
    }
    const image = await readLimitedImage(response, maxBytes);
    return { ...image, finalUrl: url.href };
  }
  throw new SafeFetchError("Too many thumbnail redirects");
}
