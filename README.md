# verdix-ai-sdk

An [AI SDK](https://ai-sdk.dev) tool that screens an EVM address on Base **before your agent sends it funds**, and answers `safe`, `caution` or `danger` with reasons. A second, cheaper tool, [`checkAddressRiskLite`](#lite-001-never-safe) ($0.01), answers `no_known_risk`, `caution` or `danger` and never `safe`.

It checks OFAC sanctions, scam, phishing and exploit lists, live **address-poisoning lookalikes**, burn addresses, contract and deployer signals, and on-chain behaviour. There is no API key and no sign-up: each check is paid per call via [x402](https://x402.org), in USDC on Base, from your agent's own wallet, under caps you set.

## Install

```bash
npm install verdix-ai-sdk ai viem
```

Payments are real USDC on Base mainnet; there is no testnet mode.

## Usage

```ts
import { generateText, isStepCount } from 'ai';
import { privateKeyToAccount } from 'viem/accounts';
import { verdixTools } from 'verdix-ai-sdk';

const { text } = await generateText({
  model: 'openai/gpt-5-mini',
  tools: verdixTools({
    account: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
    maxPricePerCallUsd: 0.1, // never pay more than $0.10 for one check
    maxTotalSpendUsd: 1, // and at most $1 in total
  }),
  stopWhen: isStepCount(3),
  prompt: 'Send 250 USDC on Base to 0x000000000000000000000000000000000000dEaD.',
});
```

The `'openai/gpt-5-mini'` model string goes through the Vercel AI Gateway (set `AI_GATEWAY_API_KEY`); any AI SDK provider model works too.

The model gets one tool, `checkAddressRisk({ address, tier? })`, and its result:

```jsonc
{
  "verdict": "danger", // "safe" | "caution" | "danger"
  "riskScore": 90,
  "reasons": ["burn_address"],
  "checked": ["ofac", "scam_lists", "poisoning_watch", "burn_list", "..."],
  "advice": "Do not send funds to this address. Show the reasons to the user.",
  "tier": "standard",
  "priceUsd": 0.1,
  "complete": true,
  "charged": true,
  "payment": { "transaction": "0x...", "network": "eip155:8453" },
  "address": "0x000000000000000000000000000000000000dEaD",
  "chain": "base",
  "asOf": "2026-09-30T12:00:00+00:00"
}
```

### What the verdicts mean

| Verdict | Meaning | What the agent should do |
|---|---|---|
| `safe` | None of the checks in `checked` found a risk signal. **Not a guarantee.** | Still confirm the full address and amount with the user. |
| `caution` | Risk signals were found, or a data source could not be reached (`complete: false`). | Show the reasons and send only if the user explicitly confirms. |
| `danger` | Strong risk signals: sanctioned, known scam, poisoning lookalike, burn address... | Do not send. |

The tool description tells the model the same thing, and every result carries an `advice` string.

### Tiers

The model picks a tier by what is at stake. It can only pick tiers that fit under `maxPricePerCallUsd`.

| Tier | List price | When |
|---|---|---|
| `quick` | $0.02 | Small, routine transfers (under ~$100) to an address used before. Sanctions, scam lists, poisoning lookalikes, burn addresses, contract/deployer signals and a fast address-age read. |
| `standard` (default) | $0.10 | ~$100-$1,000, or any address that came from a message, a transaction history or a copy-paste. Adds deeper on-chain behaviour analysis. |
| `deep` | $0.50 | Over ~$1,000, first-time counterparties, contract interactions. Currently the same checks as `standard`; new counterparty checks land here first. |

Each tier has its own URL (`https://api.verdixapi.com/risk/address/{tier}`) with a single price, so the tier the model asks for is exactly the tier that is paid.

## Lite ($0.01, never "safe")

`checkAddressRiskLite({ address })` is a second, separate tool: the cheapest screen, meant for a quick look before sending USDC to an address you don't know. It calls `/risk/address/lite`, which checks OFAC sanctions, scam and phishing lists, address-poisoning lookalikes, burn addresses, phishing tokens and flagged contract deployers. It skips address age and the caution-only contract checks.

Its verdict is `no_known_risk`, `caution` or `danger`, **never `safe`**. `no_known_risk` only means the address is on none of those lists; it is not a safety verdict. If you need `safe` (say, before a large transfer), use `checkAddressRisk` with the `quick` tier ($0.02). The tool's description tells the model the same.

`verdixTools` does not include it, so add it yourself. Pass one client to both tools to share one budget:

```ts
import { checkAddressRisk, checkAddressRiskLite, createVerdixClient } from 'verdix-ai-sdk';

const options = { account, maxPricePerCallUsd: 0.1, maxTotalSpendUsd: 1 };
const verdix = createVerdixClient(options);

const tools = {
  checkAddressRisk: checkAddressRisk(options, verdix),
  checkAddressRiskLite: checkAddressRiskLite(options, verdix),
};
```

Its result:

```jsonc
{
  "verdict": "no_known_risk", // "no_known_risk" | "caution" | "danger", never "safe"
  "limitedChecks": true,
  "checksPerformed": ["ofac", "scam_lists", "poisoning_watch", "burn_list", "phishing_token", "deployer_flagged"],
  "notChecked": ["address_age", "flash_loan_contracts", "unverified_contracts"],
  "fullCheck": "Limited checks only: ... use POST /risk/address/quick.",
  "advice": "None of the lists lite checks know this address. This is NOT a safety verdict: ...",
  "tier": "lite",
  "priceUsd": 0.01
  // plus riskScore, reasons, checked, complete, charged, payment, address, chain, asOf
}
```

`checkAddressRisk` itself is unchanged: its `tier` choice is still quick, standard and deep, never lite. A best-effort lite check that could not finish is listed in `notChecked`; if the API ever answered `safe` on lite, the tool returns a tool error instead of passing it on. `verdixNeedsApproval` keeps using quick (it needs a `safe` answer to let a transfer run without asking).

The client methods behind it, `checkAddressLite` and `getLitePricing`, are optional on the `VerdixClient` interface, so a custom client written for 0.2.x still compiles. Given such a client, `checkAddressRiskLite` answers each call with a tool error ("This client does not support lite") and sends nothing. `createVerdixClient` always has both.

## Options

```ts
verdixTools({
  account,               // required: a viem account (or any x402 ClientEvmSigner)
  maxPricePerCallUsd,    // required: refuse any check costing more, before signing
  maxTotalSpendUsd,      // optional: total budget for this tool instance
  allowedTiers,          // optional: e.g. ['quick', 'standard'] (default: all tiers within the cap)
  defaultTier,           // optional: used when the model gives none (default: 'standard')
  apiUrl,                // optional: default https://api.verdixapi.com
  fetch,                 // optional: custom fetch
});
```

## Payments and safety

- The wallet needs a little **USDC on Base mainnet**. No ETH is needed: x402 payments are gasless signatures that the facilitator settles.
- The private key only signs the payment locally. It is never sent anywhere.
- A payment is signed only for **USDC on Base**, only for the tier requested, and only at or under `maxPricePerCallUsd`. Anything else is refused before signing.
- `maxTotalSpendUsd` is reserved before each payment is signed, so parallel tool calls cannot overspend. It is released when the API reports no charge.
- **You are not charged when a data source fails.** The API then answers `caution` with `complete: false` (and `retryAfterSeconds`), and never `safe`.
- The model cannot change the caps: they are fixed when the tool is created.

## Ask the user only when Verdix finds a risk

If your agent has its own send or transfer tool, use `verdixNeedsApproval` as its [`needsApproval`](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#tool-execution-approval). Before the tool runs, it checks the destination address. A `safe` answer runs the tool directly. A `caution` or `danger` answer pauses it for the user's approval (a `tool-approval-request`).

```ts
import { tool } from 'ai';
import { z } from 'zod';
import { verdixNeedsApproval } from 'verdix-ai-sdk';

const sendUsdc = tool({
  description: 'Send USDC on Base',
  inputSchema: z.object({ to: z.string(), amount: z.number() }),
  needsApproval: verdixNeedsApproval({ account, maxPricePerCallUsd: 0.02 }), // quick tier
  execute: async ({ to, amount }) => send(to, amount),
});
```

- **Address:** by default, the first of `to`, `recipient` or `address` in the tool input. Use `address: 'field'` or `address: input => input.payment.to` for another field.
- **Tier:** `tier` defaults to `quick` ($0.02).
- **Showing the reasons:** `onResult(result, input)` receives each answer, for example to display the reasons in your approval prompt.
- **When the check fails, the user is asked, never skipped.** This covers no address found, Verdix unreachable, a price over the cap, a spent budget and an incomplete answer.

## Without a model

```ts
import { createVerdixClient } from 'verdix-ai-sdk';

const verdix = createVerdixClient({ account, maxPricePerCallUsd: 0.1 });

const pricing = await verdix.getPricing(); // free: reads the unpaid 402 quotes
const result = await verdix.checkAddress({ address: '0x...', tier: 'quick' });
if (result.verdict !== 'safe') {
  // stop, or ask the user
}

const lite = await verdix.checkAddressLite({ address: '0x...' }); // $0.01
if (lite.verdict !== 'no_known_risk') {
  // lite never answers "safe"
}
const litePrice = await verdix.getLitePricing(); // free; getPricing() lists quick/standard/deep only
```

Errors you should expect are `VerdixError`s: a malformed address, a price over your cap, an exhausted budget or an unexpected API answer. When the tool runs inside `generateText`, the AI SDK hands them to the model as a tool error.

## Development

```bash
npm install
npm test          # offline: mocked API, throwaway key, no network, no payment
npm run typecheck
npm run build
```

`examples/check-before-send.ts` makes one real paid check.

## License

MIT
