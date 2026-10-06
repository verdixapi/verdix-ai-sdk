import { tool, type Tool } from 'ai';
import { z } from 'zod';
import {
  createVerdixClient,
  tiersWithinCap,
  type VerdixCheckResult,
  type VerdixClient,
  type VerdixClientOptions,
  type VerdixLiteCheckResult,
} from './client';
import {
  LITE_LIST_PRICE_USD,
  TIER_LIST_PRICES_USD,
  VERDIX_TIERS,
  type VerdixTier,
} from './constants';
import { VerdixError } from './errors';

export interface VerdixToolOptions extends VerdixClientOptions {
  /**
   * Tiers the model may choose. Defaults to every tier whose list price is
   * within `maxPricePerCallUsd`.
   */
  allowedTiers?: VerdixTier[];

  /**
   * Tier used when the model does not pick one. Defaults to `standard` if it
   * is allowed, otherwise the cheapest allowed tier.
   */
  defaultTier?: VerdixTier;
}

export interface VerdixToolInput {
  address: string;
  tier?: VerdixTier;
}

export interface VerdixToolResult extends VerdixCheckResult {
  /** What the agent should do with this verdict. */
  advice: string;
}

const TIER_GUIDANCE: Record<VerdixTier, string> = {
  quick:
    'small, routine transfers (under ~$100) to an address the user has used before. ' +
    'Sanctions, scam/phishing lists, address-poisoning lookalikes, burn addresses, ' +
    'contract/deployer signals and a fast address-age read.',
  standard:
    'transfers of ~$100-$1,000, or any address that came from a message, a transaction ' +
    'history or a copy-paste. Everything in quick, plus deeper on-chain behaviour analysis ' +
    '(transfer history, activity patterns).',
  deep:
    'large transfers (over ~$1,000), first-time counterparties or contract interactions. ' +
    'Currently runs the same checks as standard; further counterparty checks land here first.',
};

const ADVICE: Record<VerdixCheckResult['verdict'], string> = {
  safe:
    'No risk signals were found by the checks listed in "checked". This is not a guarantee: ' +
    'still confirm the full address and amount with the user before sending.',
  caution:
    'Risk signals were found, or a check could not complete. Do not send automatically: ' +
    'show the reasons to the user and send only if they explicitly confirm.',
  danger: 'Do not send funds to this address. Show the reasons to the user.',
};

function describeTool(tiers: VerdixTier[], defaultTier: VerdixTier): string {
  const tierLines = tiers
    .map(
      tier =>
        `- ${tier} ($${TIER_LIST_PRICES_USD[tier].toFixed(2)})` +
        `${tier === defaultTier ? ' [default]' : ''}: ${TIER_GUIDANCE[tier]}`,
    )
    .join('\n');
  return [
    'Screen an EVM address on Base BEFORE sending it funds or approving it, and get a',
    'verdict: "safe", "caution" or "danger". Each call is paid in USDC from the',
    "agent's wallet, so call it once per destination address, not repeatedly.",
    '',
    'Choose the tier by how much is at stake:',
    tierLines,
    '',
    'Verdicts: "safe" means no risk signals were found by the listed checks (not a',
    'guarantee). "caution" means risk signals or incomplete data: ask the user before',
    'sending. "danger" means do not send. Follow the "advice" field of the result.',
  ].join('\n');
}

/**
 * Creates the `checkAddressRisk` tool: an address screen the model calls
 * before sending funds, paid per call via x402 from `account`.
 */
export function checkAddressRisk(
  options: VerdixToolOptions,
  client: VerdixClient = createVerdixClient(options),
): Tool<VerdixToolInput, VerdixToolResult> {
  const tiers = options.allowedTiers ?? tiersWithinCap(options.maxPricePerCallUsd);
  if (tiers.length === 0 || tiers.some(tier => !VERDIX_TIERS.includes(tier))) {
    throw new VerdixError(
      options.allowedTiers
        ? `allowedTiers must be a non-empty list of ${VERDIX_TIERS.join(', ')}`
        : `maxPricePerCallUsd ($${options.maxPricePerCallUsd}) is below the cheapest tier ` +
            `($${TIER_LIST_PRICES_USD.quick.toFixed(2)})`,
    );
  }
  const defaultTier: VerdixTier =
    options.defaultTier ?? (tiers.includes('standard') ? 'standard' : tiers[0]!);
  if (!tiers.includes(defaultTier)) {
    throw new VerdixError(`defaultTier "${defaultTier}" is not in the allowed tiers`);
  }

  return tool({
    description: describeTool(tiers, defaultTier),
    inputSchema: z.object({
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .describe('The full destination address (0x followed by 40 hex characters).'),
      tier: z
        .enum(tiers as [VerdixTier, ...VerdixTier[]])
        .optional()
        .describe(`Check depth; pick by transfer size. Defaults to ${defaultTier}.`),
    }),
    execute: async (
      { address, tier = defaultTier },
      { abortSignal },
    ): Promise<VerdixToolResult> => {
      const result = await client.checkAddress({ address, tier, abortSignal });
      return { ...result, advice: ADVICE[result.verdict] };
    },
  });
}

/**
 * All Verdix tools, ready to spread into `tools` of `generateText` /
 * `streamText`.
 *
 * @example
 * ```ts
 * const tools = verdixTools({
 *   account: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
 *   maxPricePerCallUsd: 0.1,
 * });
 * ```
 */
export function verdixTools(options: VerdixToolOptions): {
  checkAddressRisk: Tool<VerdixToolInput, VerdixToolResult>;
} {
  return {
    checkAddressRisk: checkAddressRisk(options),
  };
}

export interface VerdixLiteToolInput {
  address: string;
}

export interface VerdixLiteToolResult extends VerdixLiteCheckResult {
  /** What the agent should do with this verdict. */
  advice: string;
}

const LITE_ADVICE: Record<VerdixLiteCheckResult['verdict'], string> = {
  no_known_risk:
    'None of the lists lite checks know this address. This is NOT a safety verdict: lite ' +
    'skips some checks (see "notChecked"). Confirm the full address and amount with the ' +
    'user, and for a large or irreversible transfer run the full check (checkAddressRisk, ' +
    'quick tier), which can answer "safe".',
  caution: ADVICE.caution,
  danger: ADVICE.danger,
};

const LITE_DESCRIPTION = [
  `Cheapest screen ($${LITE_LIST_PRICE_USD.toFixed(2)}) of an EVM address on Base BEFORE sending it`,
  'funds, when the recipient is unknown or new. Checks OFAC sanctions, scam/phishing lists,',
  'address-poisoning lookalikes, burn addresses, phishing tokens and flagged contract',
  'deployers; skips address age and the caution-only contract checks. Each call is paid in',
  "USDC from the agent's wallet, so call it once per destination address.",
  '',
  'Verdicts: "no_known_risk", "caution" or "danger". This tool NEVER answers "safe":',
  '"no_known_risk" only means the address is on none of these lists, not that it is safe.',
  '"caution" means risk signals or incomplete data: ask the user before sending. "danger"',
  'means do not send. If you need a "safe" verdict (e.g. before a large transfer), use the',
  'full check (checkAddressRisk, quick tier) instead. Follow the "advice" field.',
].join('\n');

/**
 * Creates the `checkAddressRiskLite` tool: the cheapest Verdix screen
 * ($0.01), paid per call via x402 from `account`. Its verdict is
 * `no_known_risk`, `caution` or `danger`, never `safe`.
 *
 * Not part of `verdixTools`; add it yourself, with the same client to share
 * one budget:
 *
 * @example
 * ```ts
 * const verdix = createVerdixClient(options);
 * const tools = {
 *   checkAddressRisk: checkAddressRisk(options, verdix),
 *   checkAddressRiskLite: checkAddressRiskLite(options, verdix),
 * };
 * ```
 */
export function checkAddressRiskLite(
  options: VerdixClientOptions,
  client: VerdixClient = createVerdixClient(options),
): Tool<VerdixLiteToolInput, VerdixLiteToolResult> {
  if (
    typeof options.maxPricePerCallUsd === 'number' &&
    options.maxPricePerCallUsd < LITE_LIST_PRICE_USD
  ) {
    throw new VerdixError(
      `maxPricePerCallUsd ($${options.maxPricePerCallUsd}) is below the lite tier's price ` +
        `($${LITE_LIST_PRICE_USD.toFixed(2)})`,
    );
  }
  return tool({
    description: LITE_DESCRIPTION,
    inputSchema: z.object({
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .describe('The full destination address (0x followed by 40 hex characters).'),
    }),
    execute: async ({ address }, { abortSignal }): Promise<VerdixLiteToolResult> => {
      const result = await client.checkAddressLite({ address, abortSignal });
      return { ...result, advice: LITE_ADVICE[result.verdict] };
    },
  });
}
