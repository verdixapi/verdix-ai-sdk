import {
  createVerdixClient,
  type VerdixCheckResult,
  type VerdixClient,
  type VerdixClientOptions,
} from './client';
import { VERDIX_TIERS, type VerdixTier } from './constants';
import { VerdixError } from './errors';

export interface VerdixNeedsApprovalOptions<INPUT> extends VerdixClientOptions {
  /**
   * Where the destination address is in the tool's input: a field name, or a
   * function. Defaults to the first of `to`, `recipient`, `address` that holds
   * an address.
   */
  address?: string | ((input: INPUT) => unknown);

  /** Check depth. Defaults to `quick` ($0.02). */
  tier?: VerdixTier;

  /**
   * Called with every Verdix answer, e.g. to show the reasons next to the
   * approval prompt. Not called when the check itself failed.
   */
  onResult?: (result: VerdixCheckResult, input: INPUT) => void;
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_FIELDS = ['to', 'recipient', 'address'];

function findAddress<INPUT>(
  input: INPUT,
  address: VerdixNeedsApprovalOptions<INPUT>['address'],
): string | undefined {
  if (typeof address === 'function') {
    const found = address(input);
    return typeof found === 'string' && ADDRESS_PATTERN.test(found) ? found : undefined;
  }
  const record = (input ?? {}) as Record<string, unknown>;
  for (const field of address === undefined ? DEFAULT_FIELDS : [address]) {
    const value = record[field];
    if (typeof value === 'string' && ADDRESS_PATTERN.test(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * A `needsApproval` function for your own send/transfer tool: it checks the
 * destination with Verdix (paid via x402 from `account`) and asks the user
 * to approve only when Verdix says `caution` or `danger`. A `safe` answer
 * runs the tool without asking.
 *
 * Anything else also asks the user rather than letting the tool run
 * unchecked: no address found in the input, Verdix unreachable, a price over
 * the cap, a spent budget, or an incomplete answer.
 *
 * @example
 * ```ts
 * const sendUsdc = tool({
 *   inputSchema: z.object({ to: z.string(), amount: z.number() }),
 *   needsApproval: verdixNeedsApproval({ account, maxPricePerCallUsd: 0.02 }),
 *   execute: async ({ to, amount }) => send(to, amount),
 * });
 * ```
 */
export function verdixNeedsApproval<INPUT = unknown>(
  options: VerdixNeedsApprovalOptions<INPUT>,
  client: VerdixClient = createVerdixClient(options),
): (input: INPUT) => Promise<boolean> {
  const tier = options.tier ?? 'quick';
  if (!VERDIX_TIERS.includes(tier)) {
    throw new VerdixError(`tier must be one of ${VERDIX_TIERS.join(', ')}`);
  }
  const { onResult } = options;

  return async input => {
    const address = findAddress(input, options.address);
    if (!address) {
      return true;
    }
    let result: VerdixCheckResult;
    try {
      result = await client.checkAddress({ address, tier });
    } catch {
      return true;
    }
    try {
      onResult?.(result, input);
    } catch {
      // A display callback must not change the decision.
    }
    return !(result.verdict === 'safe' && result.complete);
  };
}
