import {
  NateqAuthenticationError,
  NateqConnectionError,
  NateqError,
  NateqNotFoundError,
  NateqPermissionError,
  NateqRateLimitError,
  NateqServerError,
  NateqTimeoutError,
  NateqValidationError,
  type NateqErrorCode,
} from "./errors.js";

/** Subset of `fetch` the SDK relies on, so callers can inject their own. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  fetch: FetchLike;
  userAgent: string;
}

export interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, unknown> | undefined;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /**
   * Whether this request may be replayed after an ambiguous failure (network
   * error, timeout, 5xx) — i.e. a failure where the server may already have
   * acted. Only safe for requests with no side effects.
   *
   * A 429 is retried regardless: the API rejects rate-limited sends during
   * validation, before any mail leaves, so no duplicate can result.
   */
  retryOnAmbiguousFailure: boolean;
}

/**
 * The two error envelopes the API emits. Auth middleware returns the standard
 * `{success,error:{code,message,details}}` envelope; the outbound-email handler
 * returns a flat `{error,details}`. Both are parsed into one error type.
 */
interface EnvelopeError {
  success?: boolean;
  error?: { code?: string; message?: string; details?: unknown } | string;
  details?: unknown;
}

/**
 * Removes the API key from a string. Applied to every message the SDK raises so
 * a leaked stack trace or log line can never reveal the credential.
 */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("[REDACTED]") : text;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, unknown>): string {
  const url = new URL(baseUrl.replace(/\/+$/, "") + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Maps a failed response onto the matching error class. */
function toError(
  status: number,
  payload: EnvelopeError | undefined,
  headers: Headers,
  apiKey: string,
): NateqError {
  let code: string | undefined;
  let message: string | undefined;
  let details: unknown;

  const err = payload?.error;
  if (typeof err === "string") {
    // Flat shape: { error: "Failed to send email", details: "..." }
    message = err;
    details = payload?.details;
  } else if (err && typeof err === "object") {
    // Envelope shape: { success: false, error: { code, message, details } }
    code = err.code;
    message = err.message;
    details = err.details;
  }

  const requestId = headers.get("x-request-id") ?? undefined;
  const text = redact(message ?? `Request failed with status ${status}`, apiKey);
  const opts = {
    status,
    code: code as NateqErrorCode | undefined,
    details,
    requestId,
  };

  if (status === 401) return new NateqAuthenticationError(text, opts);
  if (status === 403) return new NateqPermissionError(text, opts);
  if (status === 404) return new NateqNotFoundError(text, opts);
  if (status === 400 || status === 422) return new NateqValidationError(text, opts);
  if (status === 429) {
    return new NateqRateLimitError(text, { ...opts, retryAfter: parseRetryAfter(headers) });
  }
  if (status >= 500) return new NateqServerError(text, opts);
  return new NateqError(text, opts);
}

/** Full-jitter exponential backoff, capped at 8s, honouring `Retry-After`. */
function backoffDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return Math.min(retryAfter * 1000, 60_000);
  const ceiling = Math.min(500 * 2 ** attempt, 8_000);
  return Math.random() * ceiling;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new NateqTimeoutError("Request aborted by caller"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new NateqTimeoutError("Request aborted by caller"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class Transport {
  constructor(private readonly options: TransportOptions) {}

  async request<T>(req: RequestOptions): Promise<T> {
    const { apiKey, baseUrl, timeout, maxRetries, fetch: doFetch, userAgent } = this.options;
    const url = buildUrl(baseUrl, req.path, req.query);

    let lastError: NateqError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const retryAfter = lastError instanceof NateqRateLimitError ? lastError.retryAfter : undefined;
        await sleep(backoffDelay(attempt - 1, retryAfter), req.signal);
      }

      // Per-attempt timeout, combined with any caller-supplied signal.
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = req.signal
        ? AbortSignal.any([req.signal, timeoutSignal])
        : timeoutSignal;

      let response: Response;
      try {
        response = await doFetch(url, {
          method: req.method,
          signal,
          headers: {
            // The key travels in the Authorization header only — never in the
            // URL, where it would land in server logs and browser history.
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            "User-Agent": userAgent,
            ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        });
      } catch (err) {
        // The request produced no response. Whether the server acted is unknown.
        const caller = req.signal?.aborted === true;
        lastError = caller
          ? new NateqTimeoutError("Request aborted by caller", { cause: err })
          : isAbortError(err) || (err as Error)?.name === "TimeoutError"
            ? new NateqTimeoutError(`Request timed out after ${timeout}ms`, { cause: err })
            : new NateqConnectionError(
                redact(`Could not reach the Nateq API: ${(err as Error)?.message ?? err}`, apiKey),
                { cause: err },
              );

        if (caller) throw lastError;
        if (req.retryOnAmbiguousFailure && attempt < maxRetries) continue;
        throw lastError;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      let payload: EnvelopeError | undefined;
      try {
        payload = (await response.json()) as EnvelopeError;
      } catch {
        payload = undefined;
      }

      lastError = toError(response.status, payload, response.headers, apiKey);

      const retriable =
        lastError instanceof NateqRateLimitError ||
        (req.retryOnAmbiguousFailure &&
          (lastError instanceof NateqServerError || response.status === 408));

      if (retriable && attempt < maxRetries) continue;
      throw lastError;
    }

    /* istanbul ignore next — the loop always returns or throws. */
    throw lastError ?? new NateqError("Request failed");
  }
}
