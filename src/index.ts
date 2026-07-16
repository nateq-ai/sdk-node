export { Nateq, type NateqOptions } from "./client.js";
export { Emails } from "./emails.js";
export type { FetchLike } from "./http.js";
export {
  NateqError,
  NateqAuthenticationError,
  NateqPermissionError,
  NateqValidationError,
  NateqNotFoundError,
  NateqRateLimitError,
  NateqServerError,
  NateqConnectionError,
  NateqTimeoutError,
  NateqConfigurationError,
  type NateqErrorCode,
} from "./errors.js";
export type {
  OutboundEmail,
  OutboundEmailStatus,
  SendEmailParams,
  SendEmailResult,
  ListEmailsParams,
  ListEmailsResult,
} from "./types.js";
