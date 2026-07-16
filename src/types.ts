/** Delivery status of an outbound email. */
export type OutboundEmailStatus =
  | "pending"
  | "sending"
  | "sent"
  | "delivered"
  | "bounced"
  | "failed"
  | "rejected"
  | "opened"
  | "clicked";

/**
 * Body of a send request.
 *
 * At least one of `htmlBody` / `plainTextBody` must be present. When
 * `emailAddressId` and `fromEmail` are both omitted, the organization's default
 * verified address is used.
 */
export interface SendEmailParams {
  /** Verified organization address to send from. Defaults to the org default. */
  emailAddressId?: string;
  /** Override the From address. Must be a verified organization address. */
  fromEmail?: string;
  fromName?: string;
  /** One or more recipients. Required. */
  toEmails: string[];
  ccEmails?: string[];
  bccEmails?: string[];
  replyTo?: string;
  /** Required, 1-998 characters. */
  subject: string;
  htmlBody?: string;
  plainTextBody?: string;
  /** `Message-ID` this email replies to (threading). */
  inReplyTo?: string;
  /** `References` header (threading). */
  references?: string;
  ticketId?: string;
  conversationId?: string;
  contactId?: string;
  /** IDs of previously uploaded files to attach. */
  attachmentIds?: string[];
  /** Extra custom headers. */
  headers?: Record<string, string>;
}

/** Result of a successful send. */
export interface SendEmailResult {
  id: string;
  providerMessageId?: string;
  status: OutboundEmailStatus;
  createdAt: string;
}

/** A stored outbound email, as returned by `get` and `list`. */
export interface OutboundEmail {
  id: string;
  organizationId: string;
  emailAddressId?: string;
  messageId?: string;
  providerMessageId?: string;
  fromEmail: string;
  fromName?: string;
  toEmails: string[];
  ccEmails?: string[];
  bccEmails?: string[];
  subject?: string;
  htmlBody?: string;
  plainTextBody?: string;
  status: OutboundEmailStatus;
  ticketId?: string;
  conversationId?: string;
  contactId?: string;
  sentByUserId?: string;
  isAutomatic?: boolean;
  deliveredAt?: string;
  bouncedAt?: string;
  openedAt?: string;
  openCount?: number;
  bounceReason?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/** Filters for `emails.list`. */
export interface ListEmailsParams {
  emailAddressId?: string;
  status?: OutboundEmailStatus;
  fromEmail?: string;
  /** Match against any recipient. */
  toEmail?: string;
  ticketId?: string;
  conversationId?: string;
  contactId?: string;
  sentByUserId?: string;
  isAutomatic?: boolean;
  /** Defaults to 50 server-side; capped at 100. */
  limit?: number;
  offset?: number;
}

/** A page of outbound emails. */
export interface ListEmailsResult {
  emails: OutboundEmail[];
  total: number;
  limit: number;
  offset: number;
}
