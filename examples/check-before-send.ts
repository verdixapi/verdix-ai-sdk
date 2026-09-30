// Run: AGENT_PRIVATE_KEY=0x... AI_GATEWAY_API_KEY=... npx tsx examples/check-before-send.ts
// Makes one real paid check (at most $0.10 in USDC on Base) from AGENT_PRIVATE_KEY.
import { generateText, isStepCount } from 'ai';
import { privateKeyToAccount } from 'viem/accounts';
import { verdixTools } from '../src';

const { text, steps } = await generateText({
  model: 'openai/gpt-5-mini',
  tools: verdixTools({
    account: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
    maxPricePerCallUsd: 0.1,
    maxTotalSpendUsd: 1,
  }),
  stopWhen: isStepCount(3),
  prompt:
    'I am about to send 250 USDC on Base to 0x000000000000000000000000000000000000dEaD. ' +
    'Is it safe to send?',
});

for (const result of steps.flatMap(step => step.toolResults)) {
  console.log(result.output);
}
console.log(text);
