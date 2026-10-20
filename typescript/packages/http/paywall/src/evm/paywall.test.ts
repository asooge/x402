import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { getEvmPaywallHtml } from "./paywall";

type PaywallOptions = Parameters<typeof getEvmPaywallHtml>[0];

const baseOptions: PaywallOptions = {
  amount: 0.1,
  testnet: false,
  currentUrl: "https://example.com/premium/content",
  paymentRequired: {
    x402Version: 2,
    resource: {
      url: "https://example.com/premium/content",
      description: "Premium content",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "100000",
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60,
      },
    ],
  },
};

const inputCases: {
  name: string;
  options: (value: string) => PaywallOptions;
}[] = [
  {
    name: "paymentRequired.resource.url",
    options: value => ({
      ...baseOptions,
      paymentRequired: {
        ...baseOptions.paymentRequired,
        resource: { url: `https://example.com/premium/content?test=${value}` },
      },
    }),
  },
  {
    name: "paymentRequired.resource.description",
    options: value => ({
      ...baseOptions,
      paymentRequired: {
        ...baseOptions.paymentRequired,
        resource: { url: baseOptions.currentUrl, description: value },
      },
    }),
  },
  {
    name: "currentUrl",
    options: value => ({ ...baseOptions, currentUrl: value }),
  },
  {
    name: "appName",
    options: value => ({ ...baseOptions, appName: value }),
  },
  {
    name: "appLogo",
    options: value => ({ ...baseOptions, appLogo: value }),
  },
  {
    name: "faucetUrls value",
    options: value => ({ ...baseOptions, faucetUrls: { "eip155:84532": value } }),
  },
  {
    name: "faucetUrls key",
    options: value => ({
      ...baseOptions,
      faucetUrls: { [value]: "https://faucet.circle.com/" },
    }),
  },
];

// The shared test setup supplies an HTML template with no scripts of its own.
// Inspect the HTML boundary before evaluating JavaScript: evaluating the entire
// config directly would miss a closing script tag inside a JavaScript string.
function readConfig(html: string): PaywallOptions {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script\s*>/gi)];
  expect(scripts).toHaveLength(1);
  expect(html.match(/<\/script\s*>/gi)).toHaveLength(1);

  const context: { window: { x402?: PaywallOptions } } = { window: {} };
  runInNewContext(scripts[0][1], context, { timeout: 1000 });
  expect(context.window.x402).toBeDefined();
  return context.window.x402!;
}

describe("EVM paywall inline script safety", () => {
  describe.each(inputCases)("$name", ({ options }) => {
    it.each(["</script>", "</ScRiPt >"])(
      "keeps a %s breakout payload inside configuration data",
      closingTag => {
        const payload = `${closingTag}<script>window.__x402Injected = true</script>`;
        const input = options(payload);
        const html = getEvmPaywallHtml(input);

        expect(readConfig(html)).toMatchObject(input);
      },
    );

    it("preserves quotes, backslashes, whitespace, Unicode, and angle brackets", () => {
      const input = options("App \"name\" 'quoted' \\ path\n\r\t日本語 <logo> & logo");

      expect(readConfig(getEvmPaywallHtml(input))).toMatchObject(input);
    });
  });

  it("keeps omitted faucet URLs undefined and optional metadata empty", () => {
    const config = readConfig(getEvmPaywallHtml(baseOptions));

    expect(config.faucetUrls).toBeUndefined();
    expect(config.appName).toBe("");
    expect(config.appLogo).toBe("");
  });
});
