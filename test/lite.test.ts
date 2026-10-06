// The lite tier ($0.01, never "safe"): client methods and the checkAddressRiskLite tool.
import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  checkAddressRisk,
  checkAddressRiskLite,
  createVerdixClient,
  tiersWithinCap,
  VERDIX_TIERS,
  verdixTools,
} from '../src';
import { ADDRESS, PAY_TO, TX_HASH, liteBody, mockApi, option, settledResponse } from './mock-api';

// A throwaway key: signatures are made locally and never reach a network.
const account = privateKeyToAccount(generatePrivateKey());
const LITE_URL = 'https://api.test/risk/address/lite';

function client(api: ReturnType<typeof mockApi>, overrides = {}) {
  return createVerdixClient({
    account,
    maxPricePerCallUsd: 0.1,
    apiUrl: 'https://api.test',
    fetch: api.fetch,
    ...overrides,
  });
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

/** A model that calls `toolName` once with `input`, then answers in text. */
function modelCalling(toolName: string, input: Record<string, unknown>) {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'Checked.' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
}

describe('checkAddressLite', () => {
  it('pays for lite at its own URL and returns the lite answer', async () => {
    const api = mockApi();
    const verdix = client(api);

    const result = await verdix.checkAddressLite({ address: ADDRESS });

    expect(api.calls.map(call => [call.method, call.url, call.paid])).toEqual([
      ['POST', LITE_URL, false],
      ['POST', LITE_URL, true],
    ]);
    // Like the other single-tier URLs, no tier field goes in the body.
    expect(api.calls[1]!.body).toEqual({ address: ADDRESS, chain: 'base' });
    expect(result).toMatchObject({
      tier: 'lite',
      verdict: 'no_known_risk',
      limitedChecks: true,
      notChecked: ['address_age', 'flash_loan_contracts', 'unverified_contracts'],
      priceUsd: 0.01,
      complete: true,
      charged: true,
      payment: { transaction: TX_HASH },
    });
    expect(result.checksPerformed).toContain('deployer_flagged');
    expect(result.fullCheck).toContain('/risk/address/quick');
    expect(verdix.spentUsd).toBe(0.01);
  });

  it.each(['caution', 'danger'])('passes a %s verdict through', async verdict => {
    const api = mockApi({ paidResponse: () => settledResponse(liteBody(verdict)) });
    const result = await client(api).checkAddressLite({ address: ADDRESS });
    expect(result.verdict).toBe(verdict);
  });

  it('never passes on a "safe" answer from lite', async () => {
    const api = mockApi({
      paidResponse: () => settledResponse({ ...liteBody(), verdict: 'safe' }),
    });
    await expect(client(api).checkAddressLite({ address: ADDRESS })).rejects.toThrow(
      /lite tier: no lite verdict/,
    );
  });

  it('refuses a cap below the lite price before signing', async () => {
    const api = mockApi();
    const verdix = client(api, { maxPricePerCallUsd: 0.005 });
    await expect(verdix.checkAddressLite({ address: ADDRESS })).rejects.toThrow(
      'Refusing to pay: the lite tier costs $0.01, above the $0.005 per-call cap',
    );
    expect(api.calls.filter(call => call.paid)).toHaveLength(0);
    expect(verdix.spentUsd).toBe(0);
  });

  it('refuses a lite-URL quote for another tier', async () => {
    const api = mockApi({ quote: () => option('quick') });
    await expect(client(api).checkAddressLite({ address: ADDRESS })).rejects.toThrow(
      'no payment option for the lite tier',
    );
    expect(api.calls.filter(call => call.paid)).toHaveLength(0);
  });

  it('returns an unpaid, incomplete answer on 503', async () => {
    const api = mockApi({
      paidResponse: () =>
        new Response(JSON.stringify(liteBody('caution')), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    });
    const verdix = client(api, { maxTotalSpendUsd: 1 });

    const result = await verdix.checkAddressLite({ address: ADDRESS });

    expect(result).toMatchObject({
      verdict: 'caution',
      complete: false,
      charged: false,
      retryAfterSeconds: 30,
    });
    expect(verdix.spentUsd).toBe(0);
  });

  it('rejects a malformed address without any request', async () => {
    const api = mockApi();
    await expect(client(api).checkAddressLite({ address: '0xdead' })).rejects.toThrow(
      'address must be 0x followed by 40 hex characters',
    );
    expect(api.calls).toHaveLength(0);
  });

  it('shares one budget with checkAddress', async () => {
    const api = mockApi();
    const verdix = client(api, { maxTotalSpendUsd: 0.03 });

    await verdix.checkAddressLite({ address: ADDRESS });
    await verdix.checkAddress({ address: ADDRESS, tier: 'quick' });
    await expect(verdix.checkAddressLite({ address: ADDRESS })).rejects.toThrow(
      /budget \(maxTotalSpendUsd\)/,
    );
    expect(verdix.spentUsd).toBeCloseTo(0.03);
  });
});

describe('getLitePricing', () => {
  it('reads the unpaid lite quote', async () => {
    const api = mockApi();
    const quote = await client(api, { maxPricePerCallUsd: 0.005 }).getLitePricing();
    expect(quote).toMatchObject({ tier: 'lite', priceUsd: 0.01, payTo: PAY_TO, withinCap: false });
    expect(api.calls.map(call => [call.method, call.url, call.paid])).toEqual([
      ['GET', LITE_URL, false],
    ]);
  });

  it('leaves the existing tiers and getPricing as they were', async () => {
    expect(VERDIX_TIERS).toEqual(['quick', 'standard', 'deep']);
    expect(tiersWithinCap(0.01)).toEqual([]);
    const api = mockApi();
    const quotes = await client(api).getPricing();
    expect(quotes.map(quote => quote.tier)).toEqual(['quick', 'standard', 'deep']);
    expect(api.calls.some(call => call.url.endsWith('/lite'))).toBe(false);
    await expect(
      client(api).checkAddress({ address: ADDRESS, tier: 'lite' as never }),
    ).rejects.toThrow('tier must be one of quick, standard, deep');
  });
});

describe('checkAddressRiskLite tool', () => {
  it('tells the model it never answers safe and points to quick', () => {
    const tool = checkAddressRiskLite({ account, maxPricePerCallUsd: 0.01 });
    expect(tool.description).toContain('NEVER answers "safe"');
    expect(tool.description).toContain('$0.01');
    expect(tool.description).toContain('checkAddressRisk, quick tier');
  });

  it('refuses a cap below its price', () => {
    expect(() => checkAddressRiskLite({ account, maxPricePerCallUsd: 0.005 })).toThrow(
      /below the lite tier's price \(\$0\.01\)/,
    );
  });

  it('is called by generateText and returns no_known_risk with advice', async () => {
    const api = mockApi();
    const options = { account, maxPricePerCallUsd: 0.1, apiUrl: 'https://api.test', fetch: api.fetch };
    const verdix = createVerdixClient(options);

    const { steps } = await generateText({
      model: modelCalling('checkAddressRiskLite', { address: ADDRESS }),
      prompt: `Send 5 USDC to ${ADDRESS}`,
      tools: {
        checkAddressRisk: checkAddressRisk(options, verdix),
        checkAddressRiskLite: checkAddressRiskLite(options, verdix),
      },
      stopWhen: isStepCount(2),
    });

    const toolResult = steps[0]!.toolResults[0]!;
    expect(toolResult.toolName).toBe('checkAddressRiskLite');
    expect(toolResult.output).toMatchObject({
      verdict: 'no_known_risk',
      limitedChecks: true,
      charged: true,
    });
    expect((toolResult.output as { advice: string }).advice).toContain('NOT a safety verdict');
    expect(api.calls.filter(call => call.paid).map(call => call.url)).toEqual([LITE_URL]);
    expect(verdix.spentUsd).toBe(0.01);
  });

  it('gives the model a tool error, not "safe", if lite ever answered safe', async () => {
    const api = mockApi({
      paidResponse: () => settledResponse({ ...liteBody(), verdict: 'safe' }),
    });
    const { steps } = await generateText({
      model: modelCalling('checkAddressRiskLite', { address: ADDRESS }),
      prompt: 'Check it',
      tools: {
        checkAddressRiskLite: checkAddressRiskLite({
          account,
          maxPricePerCallUsd: 0.01,
          fetch: api.fetch,
        }),
      },
      stopWhen: isStepCount(2),
    });
    expect(steps[0]!.content.some(part => part.type === 'tool-error')).toBe(true);
    expect(steps[0]!.toolResults).toHaveLength(0);
  });

  it('is not added to verdixTools', () => {
    const tools = verdixTools({ account, maxPricePerCallUsd: 1 });
    expect(Object.keys(tools)).toEqual(['checkAddressRisk']);
    expect(tools.checkAddressRisk.description).not.toContain('lite');
  });
});
