import { Emails } from "./emails.js";
import { NateqConfigurationError } from "./errors.js";
import { Transport, type FetchLike } from "./http.js";

const VERSION = "0.1.0";

/** Recognised API-key prefixes, mirroring the API's own validation. */
const KEY_PREFIXES = ["tg_live_", "tg_test_"] as const;
const MIN_KEY_LENGTH = 50;

export interface NateqOptions {
  /**
   * Your Nateq API key. Defaults to `process.env.NATEQ_API_KEY`.
   *
   * Load this from the environment or a secret manager — never commit it, and
   * never ship it to a browser: the key carries your organization's full scope
   * grant and this SDK is server-side only.
   */
  apiKey?: string;
  /** API base URL. Defaults to `process.env.NATEQ_BASE_URL` or production. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Retries after a retriable failure. Defaults to 2. Set 0 to disable. */
  maxRetries?: number;
  /** Custom fetch, for tests or proxies. Defaults to the global `fetch`. */
  fetch?: FetchLike;
}

function resolveApiKey(explicit?: string): string {
  const key = explicit ?? process.env["NATEQ_API_KEY"];

  if (!key) {
    throw new NateqConfigurationError(
      "No API key provided. Pass `new Nateq({ apiKey })` or set the NATEQ_API_KEY environment variable.",
    );
  }
  if (key !== key.trim()) {
    throw new NateqConfigurationError(
      "The API key has leading or trailing whitespace, which usually means it was copied incorrectly.",
    );
  }
  // Validate locally so an obviously bad key fails fast, without a round-trip
  // that would put the credential on the wire.
  if (!KEY_PREFIXES.some((p) => key.startsWith(p))) {
    throw new NateqConfigurationError(
      `Invalid API key format: expected it to start with ${KEY_PREFIXES.join(" or ")}.`,
    );
  }
  if (key.length < MIN_KEY_LENGTH) {
    throw new NateqConfigurationError("Invalid API key format: the key is too short.");
  }
  return key;
}

function resolveBaseUrl(explicit?: string): string {
  const raw = explicit ?? process.env["NATEQ_BASE_URL"] ?? "https://api.nateq.io/api/v1";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NateqConfigurationError(`Invalid baseUrl: ${raw}`);
  }

  // Refuse to send the key over cleartext. Loopback is exempt so local
  // development against a plain-HTTP server still works.
  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLoopback) {
    throw new NateqConfigurationError(
      `Refusing to send an API key over ${url.protocol}// to ${url.hostname}. Use https, or a localhost address for local development.`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * The Nateq API client.
 *
 * ```ts
 * import { Nateq } from "@nateq/sdk";
 *
 * const nateq = new Nateq(); // reads NATEQ_API_KEY
 *
 * await nateq.emails.send({
 *   toEmails: ["customer@example.com"],
 *   subject: "Welcome aboard",
 *   htmlBody: "<p>Thanks for signing up.</p>",
 * });
 * ```
 *
 * The instance holds your API key, so it is never safe to serialise: `console.log`,
 * `JSON.stringify`, and util.inspect all render it with the key redacted.
 */
export class Nateq {
  /** Outbound email: send, get, list. */
  readonly emails: Emails;

  readonly baseUrl: string;

  /** Stored non-enumerably so the key cannot leak via property enumeration. */
  readonly #apiKey: string;

  constructor(options: NateqOptions = {}) {
    this.#apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = resolveBaseUrl(options.baseUrl);

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new NateqConfigurationError(
        "No global fetch available. Use Node 18+, or pass a fetch implementation via `new Nateq({ fetch })`.",
      );
    }

    const transport = new Transport({
      apiKey: this.#apiKey,
      baseUrl: this.baseUrl,
      timeout: options.timeout ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      fetch: fetchImpl.bind(globalThis) as FetchLike,
      userAgent: `nateq-node/${VERSION} (node ${process.versions.node})`,
    });

    this.emails = new Emails(transport);
  }

  /** Last four characters of the key, for logging which key is in use. */
  get apiKeyLast4(): string {
    return this.#apiKey.slice(-4);
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, apiKey: `[REDACTED:...${this.apiKeyLast4}]` };
  }

  /** Keeps the key out of `console.log(client)` and util.inspect output. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Nateq { baseUrl: '${this.baseUrl}', apiKey: '[REDACTED:...${this.apiKeyLast4}]' }`;
  }
}
