# @nateq/sdk

[![npm](https://img.shields.io/npm/v/@nateq/sdk.svg)](https://www.npmjs.com/package/@nateq/sdk)
[![CI](https://github.com/nateq-ai/sdk-node/actions/workflows/ci.yml/badge.svg)](https://github.com/nateq-ai/sdk-node/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Official Node.js SDK for the [Nateq](https://nateq.io) API.

Works with any Node.js server framework — Express, Fastify, NestJS, Next.js route handlers, background workers. Zero runtime dependencies, ESM + CommonJS, fully typed.

> **Server-side only.** Your API key grants access to your whole organization. Never ship it to a browser, a mobile app, or any client bundle.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Authentication](#authentication) — keys, scopes, and how the SDK protects them
- [Sending email](#sending-email)
- [Reading email](#reading-email)
- [Errors](#errors)
- [Retries and duplicate sends](#retries-and-duplicate-sends)
- [Configuration](#configuration)
- [Framework usage](#framework-usage) — Express, NestJS, Next.js
- [License](#license)

## Install

```bash
npm install @nateq/sdk
```

Requires Node.js 18 or newer (it uses the built-in `fetch`).

## Quick start

```ts
import { Nateq } from "@nateq/sdk";

const nateq = new Nateq(); // reads process.env.NATEQ_API_KEY

const email = await nateq.emails.send({
  toEmails: ["customer@example.com"],
  subject: "Welcome aboard",
  htmlBody: "<p>Thanks for signing up.</p>",
});

console.log(email.id, email.status);
```

## Authentication

Create an API key in the Nateq developer portal and grant it the scopes it needs:

| Scope | Allows |
| --- | --- |
| `emails:send` | `emails.send()` |
| `emails:read` | `emails.get()`, `emails.list()` |

Grant only what the key needs — a key that just sends mail should not carry `emails:read`.

The SDK reads `NATEQ_API_KEY` from the environment by default, which keeps the key out of your source:

```bash
# .env — never commit this
NATEQ_API_KEY=tg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Or pass it explicitly, ideally from a secret manager:

```ts
const nateq = new Nateq({ apiKey: await secrets.get("nateq-api-key") });
```

Keys are environment-scoped by prefix: `tg_live_` for production, `tg_test_` for sandbox.

### How the SDK protects your key

- **Header only.** The key is sent as an `Authorization: Bearer` header, never in a URL, where it would be captured by server logs, proxies, and browser history.
- **HTTPS enforced.** Configuring a plaintext `http://` base URL throws rather than putting your key on the wire in cleartext. `localhost` is exempt for local development.
- **Never printed.** `console.log(nateq)`, `JSON.stringify(nateq)`, and `util.inspect` all redact the key. It is held in a private field, so it will not appear via property enumeration.
- **Never in errors.** Every error message is scrubbed of the key before it is thrown, so it cannot reach your logs through a stack trace.
- **Validated locally.** A malformed key throws immediately, without a network round-trip that would transmit it.

## Sending email

`toEmails` and `subject` are required, plus at least one of `htmlBody` / `plainTextBody`. Everything else is optional:

```ts
await nateq.emails.send({
  toEmails: ["a@example.com", "b@example.com"],
  ccEmails: ["cc@example.com"],
  bccEmails: ["bcc@example.com"],
  replyTo: "support@yourcompany.com",
  subject: "Your order shipped",
  htmlBody: "<p>Tracking: <b>ABC123</b></p>",
  plainTextBody: "Tracking: ABC123",
  fromName: "Acme Support",
  attachmentIds: ["6f1c…"], // ids of files already uploaded to Nateq
  headers: { "X-Campaign": "shipping" },
});
```

The From address defaults to your organization's default verified address. Override it with `emailAddressId` (preferred) or `fromEmail` — both must already be verified for your organization.

`send()` resolves once Nateq has **accepted** the email. Delivery happens asynchronously, so the returned `status` is usually `pending` or `sent`, not `delivered`.

### Threading and linking

Attach an email to a ticket, conversation, or contact, or thread it onto an existing message:

```ts
await nateq.emails.send({
  toEmails: ["customer@example.com"],
  subject: "Re: Invoice #42",
  htmlBody: "<p>Attached.</p>",
  ticketId: "…",
  inReplyTo: "<message-id@nateq.io>",
});
```

## Reading email

```ts
const email = await nateq.emails.get("email-id");
console.log(email.status, email.deliveredAt, email.bounceReason);

const { emails, total } = await nateq.emails.list({
  status: "bounced",
  limit: 50,
});
```

`list()` returns newest first. `limit` defaults to 50 and is capped at 100 by the API; page with `offset`.

## Errors

Every failure is an instance of `NateqError`, with a specific subclass you can branch on:

```ts
import { NateqError, NateqRateLimitError, NateqPermissionError } from "@nateq/sdk";

try {
  await nateq.emails.send({ /* … */ });
} catch (err) {
  if (err instanceof NateqRateLimitError) {
    await sleep((err.retryAfter ?? 60) * 1000);
  } else if (err instanceof NateqPermissionError) {
    // key is missing the emails:send scope
    console.error(err.code, err.details);
  } else if (err instanceof NateqError) {
    console.error(err.status, err.message, err.requestId);
  }
  throw err;
}
```

| Class | When |
| --- | --- |
| `NateqConfigurationError` | Bad SDK setup. Thrown before any network call. |
| `NateqValidationError` | 400/422, or params rejected locally. |
| `NateqAuthenticationError` | 401 — key missing, malformed, revoked, or unknown. |
| `NateqPermissionError` | 403 — missing scope, or IP outside the key's allow-list. |
| `NateqNotFoundError` | 404. |
| `NateqRateLimitError` | 429. Carries `retryAfter`. |
| `NateqServerError` | 5xx. |
| `NateqConnectionError` | No response: DNS, TLS, socket, offline. |
| `NateqTimeoutError` | Timed out or aborted. |

Errors carry `requestId` (from `X-Request-Id`) whenever the API supplies one — include it when contacting support.

## Retries and duplicate sends

Reads (`get`, `list`) retry automatically on 429, 408, 5xx, and network errors, with exponential backoff and full jitter, honouring `Retry-After`.

**`send()` is deliberately different.** Because the API has no idempotency key, a send that fails *after* reaching the server may already have delivered the mail — replaying it would send twice. So `send()` is only retried on **429**, which the API rejects during validation before any mail leaves, and is therefore provably safe.

On a timeout or 5xx from `send()`, the SDK throws rather than guessing. If you must recover, check before resending:

```ts
try {
  await nateq.emails.send(params);
} catch (err) {
  if (err instanceof NateqServerError || err instanceof NateqTimeoutError) {
    // Ambiguous: it may or may not have sent. Confirm first.
    const { emails } = await nateq.emails.list({ toEmail: params.toEmails[0], limit: 5 });
    const alreadySent = emails.some((e) => e.subject === params.subject);
    if (!alreadySent) await nateq.emails.send(params);
  }
}
```

## Configuration

```ts
const nateq = new Nateq({
  apiKey: process.env.NATEQ_API_KEY,
  baseUrl: "https://api.nateq.io/api", // or NATEQ_BASE_URL
  timeout: 30_000,                     // per attempt, ms
  maxRetries: 2,                       // 0 disables retries
  fetch: customFetch,                  // for proxies or tests
});
```

Cancel a request with an `AbortSignal`:

```ts
await nateq.emails.send(params, { signal: AbortSignal.timeout(5000) });
```

## Framework usage

The client is a plain class with no framework coupling, so it drops into anything running on Node 18+. Create one instance and share it — it is stateless and safe to reuse across requests.

**Express / Fastify** — build the client once at startup, not per request:

```ts
const nateq = new Nateq();

app.post("/signup", async (req, res, next) => {
  try {
    await nateq.emails.send({
      toEmails: [req.body.email],
      subject: "Welcome",
      htmlBody: "<p>Thanks for signing up.</p>",
    });
    res.sendStatus(202);
  } catch (err) {
    next(err);
  }
});
```

**NestJS** — provide the client through DI so services can inject it and tests can swap it:

```ts
// nateq.module.ts
import { Global, Module } from "@nestjs/common";
import { Nateq } from "@nateq/sdk";

export const NATEQ_CLIENT = "NATEQ_CLIENT";

@Global()
@Module({
  providers: [
    {
      provide: NATEQ_CLIENT,
      useFactory: () => new Nateq({ apiKey: process.env.NATEQ_API_KEY }),
    },
  ],
  exports: [NATEQ_CLIENT],
})
export class NateqModule {}
```

```ts
// mail.service.ts
import { Inject, Injectable } from "@nestjs/common";
import { Nateq } from "@nateq/sdk";

@Injectable()
export class MailService {
  constructor(@Inject(NATEQ_CLIENT) private readonly nateq: Nateq) {}

  sendWelcome(to: string) {
    return this.nateq.emails.send({
      toEmails: [to],
      subject: "Welcome",
      htmlBody: "<p>Hi there</p>",
    });
  }
}
```

In tests, override the provider with a stub — or pass a fake `fetch`:

```ts
const module = await Test.createTestingModule({ providers: [MailService] })
  .overrideProvider(NATEQ_CLIENT)
  .useValue(new Nateq({ apiKey: TEST_KEY, fetch: fakeFetch }))
  .compile();
```

**Next.js** — use it in route handlers, server actions, or any server-only module. Never import it into a client component: `NATEQ_API_KEY` must stay server-side (do not prefix it with `NEXT_PUBLIC_`).

**Module systems.** ESM and CommonJS are both supported, with correct types for `node10`, `node16`/`nodenext`, and bundler resolution — so `import` and `require` both work, whatever your `tsconfig` says.

## License

MIT
