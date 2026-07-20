import log from "./logger.js";

export const DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS = 15_000;
export const DEFAULT_UPSTREAM_BODY_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000];

function abortReason(signal, fallback) {
  return signal?.reason instanceof Error ? signal.reason : fallback;
}

function isRetryableStatus(status) {
  return status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function wait(delayMs, signal) {
  if (!delayMs) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortReason(signal, new Error("Fetch aborted")));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal, new Error("Fetch aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createAttemptController(signal, timeoutMs, label) {
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => {
    const error = new Error(`${label} upstream response timed out after ${timeoutMs}ms`);
    error.code = "UPSTREAM_RESPONSE_TIMEOUT";
    controller.abort(error);
  }, timeoutMs);
  return {
    controller,
    signal: combinedSignal,
    cleanup() {
      clearTimeout(timer);
    },
  };
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

async function readResponseBytes(response, signal, maxBytes, label) {
  const declaredBytes = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    const error = new Error(`${label} upstream body exceeds ${maxBytes} bytes`);
    error.code = "UPSTREAM_BODY_TOO_LARGE";
    throw error;
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await raceWithAbort(
      response.arrayBuffer(),
      signal,
      "Upstream body read aborted",
    ));
    if (buffer.length > maxBytes) {
      const error = new Error(`${label} upstream body exceeds ${maxBytes} bytes`);
      error.code = "UPSTREAM_BODY_TOO_LARGE";
      throw error;
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await raceWithAbort(
        reader.read(),
        signal,
        "Upstream body read aborted",
      );
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new Error(`${label} upstream body exceeds ${maxBytes} bytes`);
        error.code = "UPSTREAM_BODY_TOO_LARGE";
        throw error;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    try { await reader.cancel(error); } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchWithRetry(url, options = {}, {
  retries = 3,
  label = "fetch",
  responseTimeoutMs = DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  fetchFn = globalThis.fetch,
  logger = log,
} = {}) {
  let lastResponse = null;
  let lastError = null;
  const retryCount = Math.max(0, Number(retries) || 0);

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    if (options.signal?.aborted) throw abortReason(options.signal, new Error("Fetch aborted"));
    const attemptState = createAttemptController(options.signal, responseTimeoutMs, label);
    try {
      const response = await raceWithAbort(
        fetchFn(url, { ...options, signal: attemptState.signal }),
        attemptState.signal,
        `${label} aborted`,
      );
      if (response.ok || response.status === 206) return response;
      if (!isRetryableStatus(response.status) || attempt >= retryCount) return response;

      await response.body?.cancel?.().catch(() => {});
      lastResponse = response;
      logger?.warn?.({ label, status: response.status, attempt: attempt + 1, retries: retryCount }, "Retrying fetch");
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal, error);
      lastError = attemptState.signal.aborted
        ? abortReason(attemptState.signal, error)
        : error;
      if (attempt >= retryCount) break;
      logger?.warn?.({ label, err: lastError?.message, attempt: attempt + 1, retries: retryCount }, "Retrying fetch after error");
    } finally {
      attemptState.cleanup();
    }

    const delayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] || 0;
    await wait(delayMs, options.signal);
  }

  if (lastError) throw lastError;
  if (lastResponse) return lastResponse;
  throw new Error(`${label} failed`);
}

export async function fetchTextWithRetry(url, options = {}, {
  timeoutMs = DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS,
  maxBytes = DEFAULT_UPSTREAM_BODY_MAX_BYTES,
  ...retryOptions
} = {}) {
  const timeoutController = new AbortController();
  const forwardAbort = () => timeoutController.abort(abortReason(options.signal, new Error("Fetch aborted")));
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`${retryOptions.label || "fetch"} upstream body timed out after ${timeoutMs}ms`);
    error.code = "UPSTREAM_BODY_TIMEOUT";
    timeoutController.abort(error);
  }, timeoutMs);

  try {
    const response = await fetchWithRetry(
      url,
      { ...options, signal: timeoutController.signal },
      { ...retryOptions, responseTimeoutMs: timeoutMs },
    );
    const bytes = await readResponseBytes(
      response,
      timeoutController.signal,
      maxBytes,
      retryOptions.label || "fetch",
    );
    return { response, body: bytes.toString("utf8") };
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal, error);
    if (timeoutController.signal.aborted) throw abortReason(timeoutController.signal, error);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function fetchBufferWithRetry(url, options = {}, {
  timeoutMs = DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS,
  maxBytes = DEFAULT_UPSTREAM_BODY_MAX_BYTES,
  ...retryOptions
} = {}) {
  const timeoutController = new AbortController();
  const forwardAbort = () => timeoutController.abort(abortReason(options.signal, new Error("Fetch aborted")));
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error(`${retryOptions.label || "fetch"} upstream body timed out after ${timeoutMs}ms`);
    error.code = "UPSTREAM_BODY_TIMEOUT";
    timeoutController.abort(error);
  }, timeoutMs);

  try {
    const response = await fetchWithRetry(
      url,
      { ...options, signal: timeoutController.signal },
      { ...retryOptions, responseTimeoutMs: timeoutMs },
    );
    const buffer = await readResponseBytes(
      response,
      timeoutController.signal,
      maxBytes,
      retryOptions.label || "fetch",
    );
    return { response, buffer };
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal, error);
    if (timeoutController.signal.aborted) throw abortReason(timeoutController.signal, error);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function openUpstreamStream(url, options = {}, {
  label = "stream",
  responseTimeoutMs = DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS,
  inactivityTimeoutMs = DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(options.signal, new Error("Fetch aborted")));
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let inactivityTimer = null;
  let cleanedUp = false;
  const clearInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = null;
  };
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInactivityTimer();
    options.signal?.removeEventListener("abort", forwardAbort);
  };
  const touch = () => {
    clearInactivityTimer();
    inactivityTimer = setTimeout(() => {
      const error = new Error(`${label} made no upstream progress for ${inactivityTimeoutMs}ms`);
      error.code = "UPSTREAM_INACTIVITY_TIMEOUT";
      controller.abort(error);
    }, inactivityTimeoutMs);
  };
  const responseTimer = setTimeout(() => {
    const error = new Error(`${label} upstream response timed out after ${responseTimeoutMs}ms`);
    error.code = "UPSTREAM_RESPONSE_TIMEOUT";
    controller.abort(error);
  }, responseTimeoutMs);

  try {
    const response = await fetchFn(url, { ...options, signal: controller.signal });
    clearTimeout(responseTimer);
    touch();
    return {
      response,
      touch,
      cleanup,
      abort(reason = new Error(`${label} aborted`)) {
        controller.abort(reason);
        cleanup();
      },
    };
  } catch (error) {
    clearTimeout(responseTimer);
    cleanup();
    if (options.signal?.aborted) throw abortReason(options.signal, error);
    if (controller.signal.aborted) throw abortReason(controller.signal, error);
    throw error;
  }
}
