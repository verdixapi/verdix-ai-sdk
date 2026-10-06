export const DEFAULT_API_URL = 'https://api.verdixapi.com';

/** CAIP-2 id of Base mainnet, the only network Verdix accepts payment on. */
export const BASE_MAINNET = 'eip155:8453';

/** Native USDC on Base (lowercase), the only asset Verdix accepts. */
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

export const USDC_DECIMALS = 6;

export const VERDIX_TIERS = ['quick', 'standard', 'deep'] as const;

export type VerdixTier = (typeof VERDIX_TIERS)[number];

/**
 * List prices in USD, used to pick which tiers fit under your cap and to
 * describe them to the model. The API's own 402 quote is authoritative: a
 * tier is never paid for if its live price is above `maxPricePerCallUsd`.
 */
export const TIER_LIST_PRICES_USD: Record<VerdixTier, number> = {
  quick: 0.02,
  standard: 0.1,
  deep: 0.5,
};

/**
 * The lite tier is sold only at its own URL and never answers "safe", so it
 * stays out of `VERDIX_TIERS` (and so out of `checkAddressRisk`'s tier
 * choice, `getPricing` and `tiersWithinCap`); it has its own tool and client
 * methods.
 */
export const LITE_TIER = 'lite' as const;

export type VerdixLiteTier = typeof LITE_TIER;

export const LITE_LIST_PRICE_USD = 0.01;
