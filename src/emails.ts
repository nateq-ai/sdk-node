import { NateqValidationError } from "./errors.js";
import type { Transport } from "./http.js";
import type {
  ListEmailsParams,
  ListEmailsResult,
  OutboundEmail,
  SendEmailParams,
  SendEmailResult,
} from "./types.js";

/** Outbound email operations. Reachable at `client.emails`. */
export class Emails {
  constructor(private readonly transport: Transport) {}

  /**
   * Sends an email, returning once the API has accepted it. Delivery itself is
   * asynchronous — poll {@link get} or subscribe to a webhook for the outcome.
   *
   * Requires an API key with the `emails:send` scope.
   *
   * A failed send is **not** replayed automatically unless the API rejected it
   * outright (429), because a request that fails after reaching the server may
   * already have sent the mail. On a timeout or 5xx, look the email up with
   * {@link list} before retrying, or you risk sending twice.
   *
   * @throws {NateqValidationError} if the params are unusable, before any call.
   * @throws {NateqPermissionError} if the key lacks the `emails:send` scope.
   */
  async send(params: SendEmailParams, opts: { signal?: AbortSignal } = {}): Promise<SendEmailResult> {
    // Validate locally what the API would reject anyway, so the common mistakes
    // surface as a typed error instead of an opaque 400.
    if (!params.toEmails?.length) {
      throw new NateqValidationError("`toEmails` must contain at least one recipient.");
    }
    if (!params.subject?.trim()) {
      throw new NateqValidationError("`subject` is required.");
    }
    if (!params.htmlBody?.trim() && !params.plainTextBody?.trim()) {
      throw new NateqValidationError("Provide `htmlBody`, `plainTextBody`, or both.");
    }

    return this.transport.request<SendEmailResult>({
      method: "POST",
      path: "/outbound-emails",
      body: params,
      signal: opts.signal,
      // Sending is not idempotent and the API has no idempotency key, so an
      // ambiguous failure must surface rather than silently double-send.
      retryOnAmbiguousFailure: false,
    });
  }

  /**
   * Fetches a single sent email by id, including delivery status.
   *
   * Requires an API key with the `emails:read` scope.
   */
  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<OutboundEmail> {
    if (!id?.trim()) throw new NateqValidationError("`id` is required.");

    return this.transport.request<OutboundEmail>({
      method: "GET",
      path: `/outbound-emails/${encodeURIComponent(id)}`,
      signal: opts.signal,
      retryOnAmbiguousFailure: true,
    });
  }

  /**
   * Lists sent emails, newest first. `limit` defaults to 50 and is capped at 100.
   *
   * Requires an API key with the `emails:read` scope.
   */
  async list(
    params: ListEmailsParams = {},
    opts: { signal?: AbortSignal } = {},
  ): Promise<ListEmailsResult> {
    return this.transport.request<ListEmailsResult>({
      method: "GET",
      path: "/outbound-emails",
      query: params as Record<string, unknown>,
      signal: opts.signal,
      retryOnAmbiguousFailure: true,
    });
  }
}
