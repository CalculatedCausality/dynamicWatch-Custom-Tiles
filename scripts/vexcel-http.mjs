// Fetch and consume a response within the same timeout/retry attempt. Never
// include URLs, response bodies, or underlying exception messages in errors.
export class HttpRequestError extends Error {
  constructor(message, code, { status, retryable = false } = {}) {
    super(message);
    this.name = 'HttpRequestError';
    this.code = code;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
  }
}

const abortError = () => new HttpRequestError('Request aborted', 'ABORTED');
const sleep = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

// Also settles if an injected fetcher/body reader ignores AbortSignal.
function untilAbort(work, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(work).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function retryDelay(response, attempt) {
  let raw;
  try { raw = response?.headers?.get?.('retry-after'); }
  catch { /* An unavailable header must not expose a response error. */ }
  const seconds = raw == null ? NaN : Number(raw);
  const date = raw && !Number.isFinite(seconds) ? Date.parse(raw) : NaN;
  const requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 :
    Number.isFinite(date) ? Math.max(0, date - Date.now()) : 200 * 2 ** attempt;
  return Math.min(5000, requested);
}

async function backoff(ms, wait, signals) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of signals) signal?.addEventListener('abort', onAbort, { once: true });
  if (signals.some((signal) => signal?.aborted)) controller.abort();
  try {
    await untilAbort(() => wait(ms, controller.signal), controller.signal);
    if (controller.signal.aborted) throw abortError();
  } catch {
    if (controller.signal.aborted) throw abortError();
    // A failing injected delay must not expose its exception (which may contain secrets).
    throw new HttpRequestError('Retry delay failed', 'NETWORK');
  } finally {
    for (const signal of signals) signal?.removeEventListener('abort', onAbort);
  }
}

async function request(fetcher, url, init = {}, opts = {}, format) {
  const { retries = 2, timeoutMs = 20_000, wait = sleep } = opts;
  if (!Number.isSafeInteger(retries) || retries < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Invalid request retry or timeout configuration');
  }
  const signals = [init.signal, opts.signal].filter(Boolean);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signals.some((signal) => signal.aborted)) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let failure, delay;
    try {
      if (signals.some((signal) => signal.aborted)) controller.abort();
      let response;
      try {
        response = await untilAbort(() => fetcher(url, { ...init, signal: controller.signal }), controller.signal);
      } catch {
        throw new HttpRequestError('Network request failed', 'NETWORK', { retryable: true });
      }
      const status = response?.status;
      if (!response?.ok) {
        const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
        const retryable = safeStatus === 429 || (safeStatus >= 500 && safeStatus <= 599);
        if (retryable) delay = retryDelay(response, attempt);
        throw new HttpRequestError(safeStatus ? `HTTP ${safeStatus}` : 'Invalid HTTP response',
          'HTTP_STATUS', { status: safeStatus, retryable });
      }
      if (format === 'json') {
        try {
          return await untilAbort(() => response.json(), controller.signal);
        } catch (error) {
          if (error instanceof SyntaxError) throw new HttpRequestError('Invalid JSON response', 'INVALID_JSON');
          throw new HttpRequestError('Network request failed', 'NETWORK', { retryable: true });
        }
      }
      let bytes;
      try {
        bytes = await untilAbort(() => response.arrayBuffer(), controller.signal);
      } catch {
        throw new HttpRequestError('Network request failed', 'NETWORK', { retryable: true });
      }
      return Buffer.from(bytes);
    } catch (error) {
      failure = signals.some((signal) => signal.aborted) ? abortError() : timedOut ?
        new HttpRequestError('Request timed out', 'TIMEOUT', { retryable: true }) :
        error instanceof HttpRequestError ? error :
          new HttpRequestError('Network request failed', 'NETWORK', { retryable: true });
    } finally {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
    }
    if (!failure.retryable || attempt === retries) throw failure;
    await backoff(delay ?? retryDelay(null, attempt), wait, signals);
  }
}

// opts: retries (default 2), timeoutMs (default 20000), wait(ms, signal), signal.
// Both init.signal and opts.signal are respected; each retry gets a fresh signal.
export function requestJson(fetcher, url, init = {}, opts = {}) {
  return request(fetcher, url, init, opts, 'json');
}

// Returns a Node Buffer, suitable for JPEG validation or base64 encoding.
export function requestBytes(fetcher, url, init = {}, opts = {}) {
  return request(fetcher, url, init, opts, 'bytes');
}
