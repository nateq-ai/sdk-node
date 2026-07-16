import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Nateq,
  NateqAuthenticationError,
  NateqConfigurationError,
  NateqPermissionError,
  NateqRateLimitError,
  NateqServerError,
  NateqValidationError,
} from "../src/index.js";

const KEY = "tg_test_" + "a".repeat(50);

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Reads a recorded fetch call, asserting it happened. */
function callAt(fetchImpl: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] {
  const call = fetchImpl.mock.calls[index] as [string, RequestInit] | undefined;
  if (!call) throw new Error(`expected a fetch call at index ${index}`);
  return call;
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

function client(fetchImpl: ReturnType<typeof vi.fn>, opts = {}) {
  return new Nateq({
    apiKey: KEY,
    baseUrl: "https://api.example.com/api/v1",
    fetch: fetchImpl as never,
    maxRetries: 0,
    ...opts,
  });
}

beforeEach(() => {
  delete process.env["NATEQ_API_KEY"];
  delete process.env["NATEQ_BASE_URL"];
});

describe("configuration", () => {
  it("reads the key from NATEQ_API_KEY", () => {
    process.env["NATEQ_API_KEY"] = KEY;
    expect(new Nateq().apiKeyLast4).toBe("aaaa");
  });

  it("rejects a missing key", () => {
    expect(() => new Nateq()).toThrow(NateqConfigurationError);
  });

  it.each([
    ["wrong prefix", "sk_live_" + "a".repeat(50)],
    ["too short", "tg_live_abc"],
    ["untrimmed", ` ${KEY} `],
  ])("rejects a malformed key: %s", (_label, key) => {
    expect(() => new Nateq({ apiKey: key })).toThrow(NateqConfigurationError);
  });

  it("refuses to send the key over plain http", () => {
    expect(() => new Nateq({ apiKey: KEY, baseUrl: "http://api.example.com" })).toThrow(
      /Refusing to send an API key over http/,
    );
  });

  it("allows http on loopback for local development", () => {
    expect(() => new Nateq({ apiKey: KEY, baseUrl: "http://localhost:8080/api" })).not.toThrow();
  });
});

describe("url construction", () => {
  // Regression: the default baseUrl already carries /v1, so request paths must
  // not repeat it. Every other test overrides baseUrl, which would hide this.
  it("builds a correct URL against the built-in default baseUrl", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "e1" }));
    const c = new Nateq({ apiKey: KEY, fetch: fetchImpl as never, maxRetries: 0 });

    await c.emails.get("e1");

    expect(callAt(fetchImpl, 0)[0]).toBe("https://api.nateq.io/api/v1/outbound-emails/e1");
  });

  it("respects NATEQ_BASE_URL", async () => {
    process.env["NATEQ_BASE_URL"] = "https://staging.example.com/api/v1";
    const fetchImpl = vi.fn(async () => jsonResponse(200, { emails: [], total: 0, limit: 50, offset: 0 }));

    await new Nateq({ apiKey: KEY, fetch: fetchImpl as never }).emails.list();

    expect(callAt(fetchImpl, 0)[0]).toContain("https://staging.example.com/api/v1/outbound-emails");
  });

  it("tolerates a trailing slash on baseUrl", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "e1" }));
    const c = new Nateq({
      apiKey: KEY,
      baseUrl: "https://api.example.com/api/v1/",
      fetch: fetchImpl as never,
    });

    await c.emails.get("e1");

    expect(callAt(fetchImpl, 0)[0]).toBe("https://api.example.com/api/v1/outbound-emails/e1");
  });
});

describe("credential safety", () => {
  it("keeps the key out of inspect, JSON, and enumeration", () => {
    const c = client(vi.fn());
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(inspect(c)).not.toContain(KEY);
    expect(Object.keys(c)).not.toContain("apiKey");
  });

  it("redacts the key from error messages", async () => {
    // A server that foolishly echoes the key back must not leak it onwards.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { error: `upstream rejected key ${KEY}` }),
    );
    const err = await client(fetchImpl)
      .emails.send({ toEmails: ["a@b.com"], subject: "s", htmlBody: "<p>x</p>" })
      .catch((e) => e);

    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[REDACTED]");
  });
});

describe("authentication", () => {
  it("sends the key as a Bearer token and never in the URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { id: "1", status: "sent", createdAt: "t" }));
    await client(fetchImpl).emails.send({ toEmails: ["a@b.com"], subject: "s", htmlBody: "<p>x</p>" });

    const [url, init] = callAt(fetchImpl, 0);
    expect(headerOf(init, "Authorization")).toBe(`Bearer ${KEY}`);
    expect(url).not.toContain(KEY);
  });

  it.each([
    [401, NateqAuthenticationError],
    [403, NateqPermissionError],
    [400, NateqValidationError],
    [500, NateqServerError],
  ])("maps HTTP %i to the right error type", async (status, expected) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(status, { success: false, error: { code: "X", message: "nope" } }),
    );
    await expect(
      client(fetchImpl).emails.send({ toEmails: ["a@b.com"], subject: "s", htmlBody: "<p>x</p>" }),
    ).rejects.toBeInstanceOf(expected);
  });

  it("parses the flat error shape the email handler returns", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: "not allowed", details: "missing scope" }),
    );
    const err = await client(fetchImpl)
      .emails.send({ toEmails: ["a@b.com"], subject: "s", htmlBody: "<p>x</p>" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(NateqPermissionError);
    expect(err.message).toBe("not allowed");
    expect(err.details).toBe("missing scope");
  });
});

describe("emails.send", () => {
  it("validates before making a request", async () => {
    const fetchImpl = vi.fn();
    const c = client(fetchImpl);

    await expect(c.emails.send({ toEmails: [], subject: "s", htmlBody: "x" })).rejects.toThrow(
      /at least one recipient/,
    );
    await expect(c.emails.send({ toEmails: ["a@b.com"], subject: "s" })).rejects.toThrow(
      /htmlBody.*plainTextBody/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the body and returns the result", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, { id: "e1", providerMessageId: "p1", status: "sent", createdAt: "t" }),
    );
    const result = await client(fetchImpl).emails.send({
      toEmails: ["a@b.com"],
      subject: "Hello",
      htmlBody: "<p>hi</p>",
    });

    const [url, init] = callAt(fetchImpl, 0);
    expect(url).toBe("https://api.example.com/api/v1/outbound-emails");
    expect(url).not.toContain("/v1/v1/");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).subject).toBe("Hello");
    expect(result.id).toBe("e1");
  });
});

describe("retries", () => {
  const send = (c: Nateq) =>
    c.emails.send({ toEmails: ["a@b.com"], subject: "s", htmlBody: "<p>x</p>" });

  it("never replays a send after an ambiguous 5xx, to avoid double-sending", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "boom" }));
    await expect(send(client(fetchImpl, { maxRetries: 3 }))).rejects.toBeInstanceOf(NateqServerError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never replays a send after a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(send(client(fetchImpl, { maxRetries: 3 }))).rejects.toThrow(/Could not reach/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a send on 429, which the API rejects before any mail is sent", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limit exceeded" }, { "retry-after": "0" }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "e1", status: "sent", createdAt: "t" }));

    await expect(send(client(fetchImpl, { maxRetries: 2 }))).resolves.toMatchObject({ id: "e1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces retryAfter when retries are exhausted", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, { error: "slow down" }, { "retry-after": "7" }),
    );
    const err = await send(client(fetchImpl)).catch((e) => e);
    expect(err).toBeInstanceOf(NateqRateLimitError);
    expect(err.retryAfter).toBe(7);
  });

  it("does retry reads on 5xx, since they have no side effects", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockResolvedValueOnce(jsonResponse(200, { emails: [], total: 0, limit: 50, offset: 0 }));

    await expect(client(fetchImpl, { maxRetries: 2 }).emails.list()).resolves.toMatchObject({
      total: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("emails.list / get", () => {
  it("serialises filters into the query string", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { emails: [], total: 0, limit: 10, offset: 0 }),
    );
    await client(fetchImpl).emails.list({ status: "delivered", limit: 10, isAutomatic: false });

    const url = new URL(callAt(fetchImpl, 0)[0]);
    expect(url.searchParams.get("status")).toBe("delivered");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("isAutomatic")).toBe("false");
  });

  it("url-encodes the id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "a b" }));
    await client(fetchImpl).emails.get("a b");
    expect(callAt(fetchImpl, 0)[0]).toContain("/outbound-emails/a%20b");
  });
});
