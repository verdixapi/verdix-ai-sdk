import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createVerdixClient, VerdixError } from '../src';
import {
  ADDRESS,
  TX_HASH,
  mockApi,
  option,
  settledResponse,
  verdictBody,
} from './mock-api';

// A throwaway key: signatures are made locally and never reach a network.
const account = privateKeyToAccount(generatePrivateKey());

function client(api: ReturnType<typeof mockApi>, overrides = {}) {
  return createVerdixClient({
    account,
    maxPricePerCallUsd: 0.1,
    apiUrl: 'https://api.test',
    fetch: api.fetch,
    ...overrides,
  });
}

describe('checkAddress', () => {
  it('pays for the requested tier at its own URL', async () => {
    const api = mockApi();
    const verdix = client(api);

    const result = await verdix.checkAddress({ address: ADDRESS, tier: 'quick' });

    expect(api.calls.map(call => [call.method, call.url, call.paid])).toEqual([
      ['POST', 'https://api.test/risk/address/quick', false],
      ['POST', 'https://api.test/risk/address/quick', true],
    ]);
    // The URL selects the tier; the body does not repeat it.
    expect(api.calls[1]!.body).toEqual({ address: ADDRESS, chain: 'base' });
    expect(result).toMatchObject({
      address: ADDRESS,
      tier: 'quick',
      verdict: 'safe',
      riskScore: 5,
      checked: ['ofac', 'scam_lists'],
      asOf: '2026-09-30T00:00:00+00:00',
      priceUsd: 0.02,
      complete: true,
      charged: true,
      payment: { transaction: TX_HASH, network: 'eip155:8453' },
    });
    expect(verdix.spentUsd).toBe(0.02);
  });

  it('defaults to the standard tier', async () => {
    const api = mockApi();
    await client(api).checkAddress({ address: ADDRESS });
    expect(api.calls[0]!.url).toBe('https://api.test/risk/address/standard');
  });

  it('refuses a price above the per-call cap before signing', async () => {
    const api = mockApi();
    const verdix = client(api, { maxPricePerCallUsd: 0.05 });

    await expect(verdix.checkAddress({ address: ADDRESS, tier: 'standard' })).rejects.toThrow(
      'Refusing to pay: the standard tier costs $0.10, above the $0.05 per-call cap',
    );
    expect(api.calls.filter(call => call.paid)).toHaveLength(0);
    expect(verdix.spentUsd).toBe(0);
  });

  it('pays above the x402 library default cap when the caller allows it', async () => {
    const api = mockApi({ quote: tier => option(tier, { amount: '1500000' }) });
    const result = await client(api, { maxPricePerCallUsd: 2 }).checkAddress({
      address: ADDRESS,
      tier: 'deep',
    });
    expect(result.charged).toBe(true);
  });

  it.each([
    // The x402 library itself drops options on networks with no registered
    // scheme, before our selector sees them.
    ['another network', { network: 'eip155:1' }, /No network\/scheme registered/],
    [
      'another asset',
      { asset: '0x4444444444444444444444444444444444444444' },
      /Refusing to pay: expected USDC on Base/,
    ],
  ])('refuses %s', async (_label, overrides, message) => {
    const api = mockApi({ quote: tier => option(tier, overrides) });
    await expect(client(api).checkAddress({ address: ADDRESS, tier: 'quick' })).rejects.toThrow(
      message,
    );
    expect(api.calls.filter(call => call.paid)).toHaveLength(0);
  });

  it('refuses a quote for a different tier than the URL asked for', async () => {
    const api = mockApi({ quote: () => option('quick') });
    await expect(client(api).checkAddress({ address: ADDRESS, tier: 'standard' })).rejects.toThrow(
      'Verdix offered no payment option for the standard tier',
    );
    expect(api.calls.filter(call => call.paid)).toHaveLength(0);
  });

  it('stops at the total budget', async () => {
    const api = mockApi();
    const verdix = client(api, { maxTotalSpendUsd: 0.05 });

    await verdix.checkAddress({ address: ADDRESS, tier: 'quick' });
    await verdix.checkAddress({ address: ADDRESS, tier: 'quick' });
    await expect(verdix.checkAddress({ address: ADDRESS, tier: 'quick' })).rejects.toThrow(
      'Refusing to pay: the quick tier costs $0.02 and $0.01 of the $0.05 budget (maxTotalSpendUsd) is left',
    );
    expect(api.calls.filter(call => call.paid)).toHaveLength(2);
    expect(verdix.spentUsd).toBe(0.04);
  });

  it('reserves the budget for concurrent checks', async () => {
    const api = mockApi();
    const verdix = client(api, { maxTotalSpendUsd: 0.02 });

    const results = await Promise.allSettled([
      verdix.checkAddress({ address: ADDRESS, tier: 'quick' }),
      verdix.checkAddress({ address: ADDRESS, tier: 'quick' }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(verdix.spentUsd).toBe(0.02);
  });

  it('returns an incomplete, unpaid answer on 503 and releases the budget', async () => {
    const api = mockApi({
      paidResponse: tier =>
        new Response(JSON.stringify(verdictBody(tier, 'caution')), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        }),
    });
    const verdix = client(api, { maxTotalSpendUsd: 1 });

    const result = await verdix.checkAddress({ address: ADDRESS, tier: 'quick' });

    expect(result).toMatchObject({
      verdict: 'caution',
      complete: false,
      retryAfterSeconds: 60,
      charged: false,
      payment: null,
    });
    expect(verdix.spentUsd).toBe(0);
  });

  it('marks a free degraded-mode answer as incomplete', async () => {
    const api = mockApi({
      unpaidResponse: tier =>
        new Response(JSON.stringify(verdictBody(tier, 'caution')), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-verdix-degraded': 'poisoning_watch' },
        }),
    });
    const verdix = client(api);

    const result = await verdix.checkAddress({ address: ADDRESS, tier: 'quick' });

    expect(result).toMatchObject({ verdict: 'caution', complete: false, charged: false });
    expect(api.calls).toHaveLength(1);
    expect(verdix.spentUsd).toBe(0);
  });

  it('reports an error status without a verdict as an error', async () => {
    const api = mockApi({
      paidResponse: () => settledResponse({ detail: 'internal error' }, 500),
    });
    await expect(client(api).checkAddress({ address: ADDRESS, tier: 'quick' })).rejects.toThrow(
      'Verdix returned HTTP 500: internal error',
    );
  });

  it('rejects a malformed address without calling the API', async () => {
    const api = mockApi();
    await expect(client(api).checkAddress({ address: '0x1234' })).rejects.toBeInstanceOf(
      VerdixError,
    );
    expect(api.calls).toHaveLength(0);
  });
});

describe('createVerdixClient', () => {
  it.each([
    [{ maxPricePerCallUsd: -1 }, /maxPricePerCallUsd/],
    [{ maxPricePerCallUsd: Number.NaN }, /maxPricePerCallUsd/],
    [{ maxTotalSpendUsd: -0.01 }, /maxTotalSpendUsd/],
    [{ account: {} }, /account must be a signer/],
  ])('rejects invalid options %#', (overrides, message) => {
    expect(() => client(mockApi(), overrides)).toThrow(message);
  });
});

describe('getPricing', () => {
  it('reads each tier from its unpaid quote, without paying', async () => {
    const api = mockApi();
    const pricing = await client(api).getPricing();

    expect(pricing.map(quote => [quote.tier, quote.priceUsd, quote.withinCap])).toEqual([
      ['quick', 0.02, true],
      ['standard', 0.1, true],
      ['deep', 0.5, false],
    ]);
    expect(api.calls.every(call => call.method === 'GET' && !call.paid)).toBe(true);
  });
});
