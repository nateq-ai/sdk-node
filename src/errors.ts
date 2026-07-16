/**
 * Error types raised by the Nateq SDK.
 *
 * Every error extends {@link NateqError}, so a single `catch (err) { if (err
 * instanceof NateqError) ... }` covers the whole surface. No error ever carries
 * the API key: see `redact` in `http.ts`.
 */

/** Machine-readable code returned by the API, when it sends one. */
export type NateqErrorCode =
  | "MISSING_API_KEY"
  | "INVALID_AUTH_FORMAT"
  | "INVALID_API_KEY_FORMAT"
  | "INVALID_API_KEY"
  | "AUTHENTICATION_FAILED"
  | "ENDPOINT_NOT_PUBLIC"
  | "INSUFFICIENT_SCOPE"
  | "INSUFFICIENT_PERMISSION"
  | "IP_NOT_ALLOWED"
  | "RATE_LIMIT_EXCEEDED"
  | (string & {});

export class NateqError extends Error {
  /** HTTP status, when the failure came from a response. */
  readonly status?: number | undefined;
  /** API error code, when the response carried one. */
  readonly code?: NateqErrorCode | undefined;
  /** Extra context from the API (validation details, scope lists, ...). */
  readonly details?: unknown;
  /** Value of the `X-Request-Id` response header, useful for support tickets. */
  readonly requestId?: string | undefined;

  constructor(
    message: string,
    opts: {
      status?: number | undefined;
      code?: NateqErrorCode | undefined;
      details?: unknown;
      requestId?: string | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.requestId = opts.requestId;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The key is missing, malformed, revoked, or unknown (401). */
export class NateqAuthenticationError extends NateqError {}

/**
 * The key is valid but not allowed to do this (403).
 *
 * Common causes: the key lacks the `emails:send` scope, the endpoint is not
 * exposed to API keys, or the caller's IP is outside the key's allow-list.
 */
export class NateqPermissionError extends NateqError {}

/** The request body failed validation (400/422). */
export class NateqValidationError extends NateqError {}

/** The requested resource does not exist, or is not visible to this key (404). */
export class NateqNotFoundError extends NateqError {}

/** A rate limit was hit (429). Nothing was sent — this is safe to retry. */
export class NateqRateLimitError extends NateqError {
  /** Seconds to wait before retrying, when the API supplies `Retry-After`. */
  readonly retryAfter?: number | undefined;

  constructor(
    message: string,
    opts: ConstructorParameters<typeof NateqError>[1] & { retryAfter?: number | undefined } = {},
  ) {
    super(message, opts);
    this.retryAfter = opts.retryAfter;
  }
}

/** The API failed to handle the request (5xx). */
export class NateqServerError extends NateqError {}

/** The request never produced a response: DNS, TLS, socket, or offline. */
export class NateqConnectionError extends NateqError {}

/** The request exceeded the configured timeout, or was aborted by the caller. */
export class NateqTimeoutError extends NateqError {}

/** Bad SDK usage — thrown before any network call (never carries a status). */
export class NateqConfigurationError extends NateqError {}
