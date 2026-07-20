const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [300, 900];
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class NetworkRequestError extends Error {
  constructor(message, { code = "NETWORK_REQUEST_FAILED", status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "NetworkRequestError";
    this.code = code;
    this.status = status;
  }
}

function abortReason(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : fallback;
}

function isIdempotent(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

function canRetryStatus(status) {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

function waitForRetry(delayMs, signal, sleepFn) {
  if (!signal) return sleepFn(delayMs);
  if (signal.aborted) return Promise.reject(abortReason(signal, new Error("Request aborted")));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal, new Error("Request aborted")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(sleepFn(delayMs)).then(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function raceWithAbort(promise, signal, fallbackMessage) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal, new Error(fallbackMessage)));
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal, new Error(fallbackMessage)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

async function readBody(response, { maxBytes, label, signal }) {
  const declaredBytes = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new NetworkRequestError(`${label} response is too large`, {
      code: "RESPONSE_TOO_LARGE",
      status: response.status,
    });
  }

  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await raceWithAbort(
      response.arrayBuffer(),
      signal,
      `${label} body read aborted`,
    ));
    if (bytes.byteLength > maxBytes) {
      throw new NetworkRequestError(`${label} response is too large`, {
        code: "RESPONSE_TOO_LARGE",
        status: response.status,
      });
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await raceWithAbort(
        reader.read(),
        signal,
        `${label} body read aborted`,
      );
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new NetworkRequestError(`${label} response is too large`, {
          code: "RESPONSE_TOO_LARGE",
          status: response.status,
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function runAttempt(input, init, {
  timeoutMs,
  maxBytes,
  label,
  fetchFn,
}) {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const forwardAbort = () => controller.abort(abortReason(externalSignal, new Error(`${label} aborted`)));
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    const error = new NetworkRequestError(`${label} timed out after ${timeoutMs}ms`, {
      code: "REQUEST_TIMEOUT",
    });
    controller.abort(error);
  }, timeoutMs);

  try {
    const response = await raceWithAbort(
      fetchFn(input, { ...init, signal: controller.signal }),
      controller.signal,
      `${label} aborted`,
    );
    const bytes = await readBody(response, { maxBytes, label, signal: controller.signal });
    return { response, bytes };
  } catch (error) {
    if (externalSignal?.aborted) throw abortReason(externalSignal, error);
    if (controller.signal.aborted) throw abortReason(controller.signal, error);
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

export async function requestBytes(input, init = {}, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = isIdempotent(init.method) ? DEFAULT_RETRY_DELAYS_MS.length : 0,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
  label = "Request",
  fetchFn = globalThis.fetch,
  sleepFn = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  if (typeof fetchFn !== "function") throw new TypeError("fetch is unavailable");
  const retryCount = Math.max(0, Number(retries) || 0);
  let lastError = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    if (init.signal?.aborted) throw abortReason(init.signal, new Error(`${label} aborted`));
    try {
      const result = await runAttempt(input, init, { timeoutMs, maxBytes, label, fetchFn });
      if (canRetryStatus(result.response.status) && attempt < retryCount) {
        lastError = new NetworkRequestError(`${label} failed with ${result.response.status}`, {
          code: "HTTP_RETRYABLE",
          status: result.response.status,
        });
      } else {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted || error?.code === "RESPONSE_TOO_LARGE" || attempt >= retryCount) throw error;
    }
    const delayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] || 0;
    await waitForRetry(delayMs, init.signal, sleepFn);
  }
  throw lastError || new NetworkRequestError(`${label} failed`);
}

function decodeBody(bytes) {
  return new TextDecoder().decode(bytes);
}

export async function requestText(input, init = {}, options = {}) {
  const { response, bytes } = await requestBytes(input, init, options);
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text: decodeBody(bytes),
  };
}

export async function requestJson(input, init = {}, options = {}) {
  const result = await requestText(input, init, options);
  let data = null;
  if (result.text) {
    try {
      data = JSON.parse(result.text);
    } catch (cause) {
      throw new NetworkRequestError(`${options.label || "Request"} returned invalid JSON`, {
        code: "INVALID_JSON",
        status: result.status,
        cause,
      });
    }
  }
  return { ...result, data };
}

export async function requestJsonData(input, init = {}, options = {}) {
  const result = await requestJson(input, init, options);
  if (!result.ok) {
    throw new NetworkRequestError(
      result.data?.error || `${options.label || "Request"} failed with ${result.status}`,
      { code: "HTTP_ERROR", status: result.status },
    );
  }
  return result.data;
}

export async function requestOk(input, init = {}, options = {}) {
  const result = await requestText(input, init, options);
  return result.ok;
}
