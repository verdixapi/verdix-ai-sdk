// An in-memory stand-in for the Verdix API: no network, no real payment.
// Unpaid requests get a 402 quote; paid ones (any x402 payment header) get
// a verdict and a settlement receipt.
import type { VerdixTier } from '../src';

export const ADDRESS = '0x1111111111111111111111111111111111111111';
export const PAY_TO = '0x2222222222222222222222222222222222222222';
export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const TX_HASH = `0x${'ab'.repeat(32)}`;

const PRICES: Record<VerdixTier, number> = { quick: 20000, standard: 100000, deep: 500000 };

export function option(tier: VerdixTier, overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: String(PRICES[tier]),
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2', tier },
    ...overrides,
  };
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

export function verdictBody(tier: VerdixTier, verdict = 'safe') {
  return {
    address: ADDRESS,
    chain: 'base',
    tier,
    price_usd: PRICES[tier] / 1e6,
    risk_score: verdict === 'safe' ? 5 : 60,
    verdict,
    reasons: verdict === 'safe' ? [] : ['burn_address'],
    checked: ['ofac', 'scam_lists'],
    as_of: '2026-09-30T00:00:00+00:00',
  };
}

export interface RecordedCall {
  method: string;
  url: string;
  paid: boolean;
  body: unknown;
}

export interface MockApiOptions {
  /** Payment option to quote per tier (defaults to the real shape). */
  quote?: (tier: VerdixTier) => Record<string, unknown>;
  /** Answer to a paid request (defaults to a settled 200 "safe"). */
  paidResponse?: (tier: VerdixTier) => Response;
  /** Answer to an unpaid POST, instead of the 402 quote. */
  unpaidResponse?: (tier: VerdixTier) => Response | undefined;
}

export function settledResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'payment-response': encode({
        success: true,
        transaction: TX_HASH,
        network: 'eip155:8453',
        payer: '0x3333333333333333333333333333333333333333',
      }),
    },
  });
}

export function mockApi(options: MockApiOptions = {}) {
  const calls: RecordedCall[] = [];
  const quote = options.quote ?? ((tier: VerdixTier) => option(tier));

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const tier = new URL(request.url).pathname.split('/').pop() as VerdixTier;
    const paid =
      request.headers.has('payment-signature') || request.headers.has('x-payment');
    const text = request.method === 'POST' ? await request.clone().text() : '';
    calls.push({
      method: request.method,
      url: request.url,
      paid,
      body: text ? JSON.parse(text) : null,
    });

    if (!paid) {
      const unpaid = request.method === 'POST' ? options.unpaidResponse?.(tier) : undefined;
      if (unpaid) return unpaid;
      return new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'payment-required': encode({
            x402Version: 2,
            resource: { url: request.url },
            accepts: [quote(tier)],
          }),
        },
      });
    }
    return options.paidResponse?.(tier) ?? settledResponse(verdictBody(tier));
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}
