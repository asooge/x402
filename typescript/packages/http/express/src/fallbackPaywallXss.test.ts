import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { x402ResourceServer } from "@x402/core/server";
import { createPaywall } from "../../paywall/src/builder";
import { evmPaywall } from "../../paywall/src/evm";
import { paymentMiddleware } from "./index";

// Keep the real HTML generator while excluding the bundled wallet application.
vi.mock("../../paywall/src/evm/template-loader", () => ({
  getEvmTemplate: () => "<!DOCTYPE html><html><head></head><body></body></html>",
}));

/** Network the routing tests price their protected routes on. */
const TEST_NETWORK = "eip155:84532";

/**
 * Builds an initialized resource server with the `exact` scheme registered and
 * a stub facilitator advertising it, so a matched route answers 402 instead of
 * failing to build payment requirements.
 *
 * @returns A resource server that serves a real 402 for a matched route.
 */
async function buildTestResourceServer(): Promise<x402ResourceServer> {
  const resourceServer = new x402ResourceServer({
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: TEST_NETWORK }],
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: "", network: TEST_NETWORK }),
  });
  resourceServer.register(TEST_NETWORK, {
    scheme: "exact",
    parsePrice: async () => ({
      amount: "1000000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      extra: {},
    }),
    enhancePaymentRequirements: async paymentRequirements => paymentRequirements,
    defaultAssetTransferMethod: "default",
    paymentFlows: { default: { supported: ["upfront"], default: "upfront" } },
  });
  await resourceServer.initialize();
  return resourceServer;
}

/**
 * Issue an HTTP GET to the local server, simulating a real browser
 * (Accept: text/html + Mozilla User-Agent so the middleware serves the
 * paywall HTML branch), and return the response.
 *
 * @param port - The local server port.
 * @param rawPath - The raw HTTP path (already percent-encoded as desired).
 * @param host - The Host header to send, independently of the connection address.
 * @returns The response status, headers, and decoded UTF-8 body.
 */
async function fetchHtml(
  port: number,
  rawPath: string,
  host = `127.0.0.1:${port}`,
): Promise<{ statusCode: number | undefined; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: rawPath,
        headers: {
          Host: host,
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0",
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("express end-to-end: fallback paywall HTML does not reflect attacker input", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    const resourceServer = await buildTestResourceServer();
    app.use(
      paymentMiddleware(
        {
          "/api/protected": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00",
              network: TEST_NETWORK,
            },
          },
        },
        resourceServer,
        // App config with a sentinel appName that should never be reflected,
        // since the fallback is fully static.
        { appName: "TENANT_SENTINEL_q9w8e7\"' onerror=alert(1)" },
        undefined,
        false,
      ),
    );

    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it("does not reflect any portion of the request URL into the rendered HTML", async () => {
    const { body } = await fetchHtml(
      port,
      "/api/protected?token=ATTACKER_SENTINEL_8a7b6c&x='%3Cscript%3Ealert(1)%3C/script%3E",
    );

    expect(body).not.toContain("ATTACKER_SENTINEL_8a7b6c");
    expect(body).not.toContain("<script>alert");
    expect(body).not.toMatch(/'\s*onfocus/i);
  });

  it("does not reflect the configured appName into the rendered HTML", async () => {
    const { body } = await fetchHtml(port, "/api/protected");

    expect(body).not.toContain("TENANT_SENTINEL_q9w8e7");
    expect(body).not.toContain("onerror=alert");
  });

  it("does not include a data-requirements attribute (no JSON reflection surface)", async () => {
    const { body } = await fetchHtml(port, "/api/protected?q=anything");

    expect(body).not.toContain("data-requirements");
  });

  it("still tells the developer to install @x402/paywall", async () => {
    const { body } = await fetchHtml(port, "/api/protected");

    expect(body).toContain("@x402/paywall");
    expect(body).toMatch(/Payment Required/);
  });
});

describe("express end-to-end: EVM paywall keeps request URLs inside script data", () => {
  let server: Server;
  let port: number;
  const payload = "</script><script>window.__x402Injected=true</script>";

  beforeAll(async () => {
    const app = express();
    const resourceServer = await buildTestResourceServer();
    app.use(
      paymentMiddleware(
        {
          "/api/protected/*": {
            accepts: {
              scheme: "exact",
              payTo: "0xabc",
              price: "$1.00",
              network: TEST_NETWORK,
            },
          },
        },
        resourceServer,
        { testnet: true },
        createPaywall().withNetwork(evmPaywall).build(),
        false,
      ),
    );

    server = app.listen(0);
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it.each([
    { name: "normal request", path: "/api/protected/content", host: "example.test" },
    { name: "URL path", path: `/api/protected/content${payload}`, host: "example.test" },
    { name: "query string", path: `/api/protected/content?test=${payload}`, host: "example.test" },
    { name: "Host header", path: "/api/protected/content", host: `example.test${payload}` },
  ])("safely embeds the resource URL from $name", async ({ path, host }) => {
    const { statusCode, headers, body } = await fetchHtml(port, path, host);

    expect(statusCode).toBe(402);
    expect(headers["content-type"]).toContain("text/html");
    expect(body).toContain("window.x402 =");

    // Check HTML boundaries before evaluating the configuration. Directly
    // evaluating all script text would miss a breakout inside a JS string.
    const scripts = [...body.matchAll(/<script>([\s\S]*?)<\/script\s*>/gi)];
    expect(scripts).toHaveLength(1);
    expect(body.match(/<\/script\s*>/gi)).toHaveLength(1);

    const context: {
      window: {
        x402?: { currentUrl: string; paymentRequired: { resource?: { url: string } } };
      };
    } = { window: {} };
    runInNewContext(scripts[0][1], context, { timeout: 1000 });

    const expectedUrl = `http://${host}${path}`;
    expect(context.window.x402?.paymentRequired.resource?.url).toBe(expectedUrl);
    expect(context.window.x402?.currentUrl).toBe(expectedUrl);
  });
});
