import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { getPaywallHtml } from "./index";

vi.mock("./gen/template", () => ({
  PAYWALL_TEMPLATE: "<!DOCTYPE html><html><head></head><body></body></html>",
}));

type PaywallOptions = Parameters<typeof getPaywallHtml>[0];

const baseOptions: PaywallOptions = {
  amount: 0.1,
  testnet: false,
  currentUrl: "/premium/content",
  paymentRequirements: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "100000",
      resource: "https://example.com/premium/content",
      description: "Premium content",
      mimeType: "application/json",
      payTo: "0x1111111111111111111111111111111111111111",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      maxTimeoutSeconds: 60,
    },
  ],
};

const inputCases: {
  name: string;
  options: (value: string) => PaywallOptions;
}[] = [
  {
    name: "paymentRequirements.resource",
    options: value => ({
      ...baseOptions,
      paymentRequirements: [{ ...baseOptions.paymentRequirements[0], resource: value }],
    }),
  },
  {
    name: "paymentRequirements.description",
    options: value => ({
      ...baseOptions,
      paymentRequirements: [{ ...baseOptions.paymentRequirements[0], description: value }],
    }),
  },
  {
    name: "currentUrl",
    options: value => ({ ...baseOptions, currentUrl: value }),
  },
  {
    name: "cdpClientKey",
    options: value => ({ ...baseOptions, cdpClientKey: value }),
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
    name: "sessionTokenEndpoint",
    options: value => ({ ...baseOptions, sessionTokenEndpoint: value }),
  },
];

/**
 * Reads configuration after checking the enclosing script element.
 *
 * @param html - The generated paywall HTML
 * @returns The evaluated paywall configuration
 */
function readConfig(html: string): PaywallOptions {
  // Check HTML boundaries before evaluating JavaScript string contents.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script\s*>/gi)];
  expect(scripts).toHaveLength(1);
  expect(html.match(/<\/script\s*>/gi)).toHaveLength(1);

  const context: { window: { x402?: PaywallOptions } } = { window: {} };
  runInNewContext(scripts[0][1], context, { timeout: 1000 });
  expect(context.window.x402).toBeDefined();
  return context.window.x402!;
}

describe("legacy v1 paywall inline script safety", () => {
  describe.each(inputCases)("$name", ({ options }) => {
    it.each(["</script>", "</ScRiPt >"])(
      "keeps a %s breakout payload inside configuration data",
      closingTag => {
        const input = options(`${closingTag}<script>window.__x402Injected=true</script>`);

        expect(readConfig(getPaywallHtml(input))).toMatchObject(input);
      },
    );

    it("preserves quotes, backslashes, whitespace, Unicode, and angle brackets", () => {
      const input = options("App \"name\" 'quoted' \\ path\n\r\t日本語 <logo> & logo");

      expect(readConfig(getPaywallHtml(input))).toMatchObject(input);
    });
  });

  it("keeps omitted optional configuration strings empty", () => {
    const config = readConfig(getPaywallHtml(baseOptions));

    expect(config.cdpClientKey).toBe("");
    expect(config.appName).toBe("");
    expect(config.appLogo).toBe("");
    expect(config.sessionTokenEndpoint).toBe("");
  });
});
