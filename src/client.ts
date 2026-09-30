import type { ClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm';
import {
  decodePaymentResponseHeader,
  wrapFetchWithPaymentFromConfig,
} from '@x402/fetch';
import {
  BASE_MAINNET,
  DEFAULT_API_URL,
  TIER_LIST_PRICES_USD,
  USDC_BASE,
  USDC_DECIMALS,
  VERDIX_TIERS,
  type VerdixTier,
} from './constants';
import { VerdixError } from './errors';

type FetchFunction = typeof globalThis.fetch;

type PaymentRequirement = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: Record<string, unknown>;
};

export interface VerdixClientOptions {
  /**
   * The wallet that pays, e.g. `privateKeyToAccount(key)` from `viem/accounts`.
   * It only signs the x402 payment locally; the key never leaves your process.
   * It needs a little USDC on Base mainnet (no ETH: the facilitator pays gas).
   */
  account: ClientEvmSigner;

  /**
   * Hard cap, in USD, on what a single check may cost. A tier whose live
   * price is above it is refused before anything is signed.
   */
  maxPricePerCallUsd: number;

  /**
   * Optional total budget, in USD, for everything this client pays over its
   * lifetime. A payment is reserved against it before signing and released
   * again if the API reports it was not charged.
   */
  maxTotalSpendUsd?: number;

  /** Verdix API base URL. Defaults to https://api.verdixapi.com. */
  apiUrl?: string;

  /** Custom fetch implementation (for tests, proxies or instrumentation). */
  fetch?: FetchFunction;
}

export type VerdixVerdict = 'safe' | 'caution' | 'danger';

export interface VerdixPayment {
  /** Settlement transaction hash on Base. */
  transaction: string;
  network: string;
  /** The paying wallet. */
  payer?: string;
}

export interface VerdixCheckResult {
  address: string;
  chain: string;
  tier: VerdixTier;
  /**
   * `safe`: none of the checks in `checked` found a risk signal. It is not a
   * guarantee that the address is trustworthy.
   * `caution`: some risk signals, or a check could not complete.
   * `danger`: strong risk signals (sanctions, known scam, poisoning lookalike,
   * burn address...). Do not send funds.
   */
  verdict: VerdixVerdict;
  /** 0 (no signals) to 100 (highest risk). */
  riskScore: number;
  /** Human-readable reasons behind the verdict. */
  reasons: string[];
  /** The checks that ran. */
  checked: string[];
  /** ISO timestamp of the assessment. */
  asOf: string;
  priceUsd: number;
  /**
   * `false` when a data source failed or Verdix runs in degraded mode: the
   * verdict is then never `safe`, you are not charged, and you can retry
   * (after `retryAfterSeconds`, when given).
   */
  complete: boolean;
  retryAfterSeconds?: number;
  /** Whether a payment settled for this check. */
  charged: boolean;
  payment: VerdixPayment | null;
}

export interface VerdixTierQuote {
  tier: VerdixTier;
  priceUsd: number;
  network: string;
  asset: string;
  payTo: string;
  withinCap: boolean;
}

export interface VerdixClient {
  /** Paid address check at the given tier (default `standard`). */
  checkAddress(input: {
    address: string;
    tier?: VerdixTier;
    abortSignal?: AbortSignal;
  }): Promise<VerdixCheckResult>;

  /** Live price of each tier, from the API's unpaid quotes. Nothing is signed. */
  getPricing(): Promise<VerdixTierQuote[]>;

  /** USD paid (or reserved for an in-flight check) so far by this client. */
  readonly spentUsd: number;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

function usdToAtomic(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

function atomicToUsd(amount: bigint | string): number {
  return Number(BigInt(amount)) / 10 ** USDC_DECIMALS;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function assertUsdAmount(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new VerdixError(`${name} must be a non-negative number of US dollars`);
  }
}

function tierUrl(apiUrl: string, tier: VerdixTier): string {
  return `${apiUrl}/risk/address/${tier}`;
}

function parseQuote(header: string | null): PaymentRequirement[] {
  if (!header) {
    return [];
  }
  // atob + TextDecoder rather than Buffer, so this also runs on edge runtimes.
  const bytes = Uint8Array.from(atob(header), char => char.charCodeAt(0));
  const quote = JSON.parse(new TextDecoder().decode(bytes));
  return Array.isArray(quote?.accepts) ? quote.accepts : [];
}

/**
 * Throws unless `option` is exactly what this client agreed to pay: the
 * requested tier, USDC on Base, `exact` scheme, at or under the cap.
 */
function assertAcceptable(
  option: PaymentRequirement | undefined,
  tier: VerdixTier,
  maxPricePerCallUsd: number,
): asserts option is PaymentRequirement {
  if (!option || option.scheme !== 'exact' || option.extra?.tier !== tier) {
    throw new VerdixError(`Verdix offered no payment option for the ${tier} tier`);
  }
  if (
    option.network !== BASE_MAINNET ||
    String(option.asset).toLowerCase() !== USDC_BASE
  ) {
    throw new VerdixError(
      `Refusing to pay: expected USDC on Base (${BASE_MAINNET}), got ${option.asset} on ${option.network}`,
    );
  }
  if (BigInt(option.amount) > usdToAtomic(maxPricePerCallUsd)) {
    throw new VerdixError(
      `Refusing to pay: the ${tier} tier costs ${formatUsd(atomicToUsd(option.amount))}, ` +
        `above the ${formatUsd(maxPricePerCallUsd)} per-call cap (maxPricePerCallUsd)`,
    );
  }
}

function toCheckResult(
  body: Record<string, unknown>,
  complete: boolean,
  retryAfter: string | null,
  payment: VerdixPayment | null,
): VerdixCheckResult {
  const verdict = body.verdict;
  if (verdict !== 'safe' && verdict !== 'caution' && verdict !== 'danger') {
    throw new VerdixError('Unexpected answer from Verdix: no verdict');
  }
  const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
  return {
    address: String(body.address),
    chain: String(body.chain),
    tier: body.tier as VerdixTier,
    verdict,
    riskScore: Number(body.risk_score),
    reasons: Array.isArray(body.reasons) ? body.reasons.map(String) : [],
    checked: Array.isArray(body.checked) ? body.checked.map(String) : [],
    asOf: String(body.as_of),
    priceUsd: Number(body.price_usd),
    complete,
    ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
    charged: payment !== null,
    payment,
  };
}

/**
 * Creates a Verdix client that pays for each check via x402 from `account`,
 * within the caps you set.
 */
export function createVerdixClient(options: VerdixClientOptions): VerdixClient {
  const { account, maxPricePerCallUsd, maxTotalSpendUsd } = options;
  if (!account || typeof account.signTypedData !== 'function') {
    throw new VerdixError(
      'account must be a signer, e.g. privateKeyToAccount(key) from viem/accounts',
    );
  }
  assertUsdAmount('maxPricePerCallUsd', maxPricePerCallUsd);
  if (maxTotalSpendUsd !== undefined) {
    assertUsdAmount('maxTotalSpendUsd', maxTotalSpendUsd);
  }

  const apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const fetchImpl: FetchFunction = options.fetch ?? globalThis.fetch;
  const budget =
    maxTotalSpendUsd === undefined ? undefined : usdToAtomic(maxTotalSpendUsd);
  let spent = 0n;

  async function checkAddress({
    address,
    tier = 'standard',
    abortSignal,
  }: {
    address: string;
    tier?: VerdixTier;
    abortSignal?: AbortSignal;
  }): Promise<VerdixCheckResult> {
    if (!ADDRESS_PATTERN.test(address ?? '')) {
      throw new VerdixError('address must be 0x followed by 40 hex characters');
    }
    if (!VERDIX_TIERS.includes(tier)) {
      throw new VerdixError(`tier must be one of ${VERDIX_TIERS.join(', ')}`);
    }

    // The amount reserved against the budget for this call, if one was signed.
    let reserved = 0n;
    // The x402 library wraps errors thrown by the selector; keep ours so the
    // caller sees the plain refusal.
    let refusal: unknown = null;

    const payingFetch = wrapFetchWithPaymentFromConfig(fetchImpl, {
      schemes: [{ network: BASE_MAINNET, client: new ExactEvmScheme(account) }],
      // The selector below makes every check the library's spend controls
      // would (asset allow-list, per-payment cap), against the caller's own
      // cap. Left on, the library's default $1 cap would silently override a
      // higher cap and hide the refusal reason.
      spendControls: false,
      paymentRequirementsSelector: (_x402Version, accepts) => {
        try {
          const option = (accepts as PaymentRequirement[]).find(
            candidate => candidate?.extra?.tier === tier,
          );
          assertAcceptable(option, tier, maxPricePerCallUsd);
          const amount = BigInt(option.amount);
          if (budget !== undefined && spent + amount > budget) {
            throw new VerdixError(
              `Refusing to pay: the ${tier} tier costs ${formatUsd(atomicToUsd(amount))} and ` +
                `${formatUsd(atomicToUsd(budget - spent))} of the ${formatUsd(atomicToUsd(budget))} ` +
                `budget (maxTotalSpendUsd) is left`,
            );
          }
          // Reserved synchronously, so concurrent checks cannot overspend.
          spent += amount;
          reserved = amount;
          return option as never;
        } catch (error) {
          refusal = error;
          throw error;
        }
      },
    });

    let response: Response;
    try {
      response = await payingFetch(tierUrl(apiUrl, tier), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The URL selects the tier; the body carries only the address.
        body: JSON.stringify({ address, chain: 'base' }),
        signal: abortSignal,
      });
    } catch (error) {
      // A payment signed before a network failure may still settle, so the
      // reservation is kept (conservative).
      throw (
        refusal ??
        new VerdixError(
          `Verdix request failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      );
    }

    let payment: VerdixPayment | null = null;
    const receipt = response.headers.get('payment-response');
    if (receipt) {
      try {
        const settled = decodePaymentResponseHeader(receipt);
        if (settled.success) {
          payment = {
            transaction: settled.transaction,
            network: settled.network,
            ...(settled.payer ? { payer: settled.payer } : {}),
          };
        }
      } catch {
        payment = null;
      }
    }
    // Any status >= 400, or no settled receipt, means nothing was charged.
    if (!response.ok || payment === null) {
      spent -= reserved;
    }

    let body: Record<string, unknown>;
    try {
      body = await response.json();
    } catch {
      throw new VerdixError(`Unexpected answer from Verdix: HTTP ${response.status}`);
    }
    // 503 carries a "caution" verdict body when an upstream data source
    // failed, and a degraded-mode answer comes back free: both are usable
    // (unpaid) answers resting on incomplete data, not errors.
    if (response.ok || (response.status === 503 && body?.verdict)) {
      return toCheckResult(
        body,
        response.ok && !response.headers.get('x-verdix-degraded'),
        response.headers.get('retry-after'),
        payment,
      );
    }
    if (response.status === 402) {
      throw new VerdixError('Verdix did not accept the payment (HTTP 402)');
    }
    const detail = typeof body?.detail === 'string' ? `: ${body.detail}` : '';
    throw new VerdixError(`Verdix returned HTTP ${response.status}${detail}`);
  }

  async function getPricing(): Promise<VerdixTierQuote[]> {
    return Promise.all(
      VERDIX_TIERS.map(async tier => {
        const response = await fetchImpl(tierUrl(apiUrl, tier), { method: 'GET' });
        const option = parseQuote(response.headers.get('payment-required')).find(
          candidate => candidate?.extra?.tier === tier,
        );
        if (response.status !== 402 || !option) {
          throw new VerdixError(
            `Unexpected pricing answer from Verdix for the ${tier} tier: HTTP ${response.status}`,
          );
        }
        return {
          tier,
          priceUsd: atomicToUsd(option.amount),
          network: option.network,
          asset: option.asset,
          payTo: option.payTo,
          withinCap: BigInt(option.amount) <= usdToAtomic(maxPricePerCallUsd),
        };
      }),
    );
  }

  return {
    checkAddress,
    getPricing,
    get spentUsd() {
      return atomicToUsd(spent);
    },
  };
}

/** Tiers whose list price fits under `maxPricePerCallUsd`. */
export function tiersWithinCap(maxPricePerCallUsd: number): VerdixTier[] {
  return VERDIX_TIERS.filter(
    tier => TIER_LIST_PRICES_USD[tier] <= maxPricePerCallUsd,
  );
}
