import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { checkAddressRisk, verdixTools } from '../src';
import { ADDRESS, mockApi, settledResponse, verdictBody } from './mock-api';

const account = privateKeyToAccount(generatePrivateKey());

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

/** A model that calls the tool once with `input`, then answers in text. */
function modelCalling(input: Record<string, unknown>) {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'checkAddressRisk',
            input: JSON.stringify(input),
          },
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

describe('checkAddressRisk tool', () => {
  it('offers only the tiers within the per-call cap', () => {
    const tool = checkAddressRisk({ account, maxPricePerCallUsd: 0.1 });

    expect(tool.description).toContain('- quick ($0.02)');
    expect(tool.description).toContain('- standard ($0.10) [default]');
    expect(tool.description).not.toContain('- deep');
    expect(tool.description).toContain('"safe" means no risk signals were found');
  });

  it('defaults to the cheapest tier when standard is over the cap', () => {
    const tool = checkAddressRisk({ account, maxPricePerCallUsd: 0.05 });
    expect(tool.description).toContain('- quick ($0.02) [default]');
    expect(tool.description).not.toContain('- standard');
  });

  it('offers every tier when the cap allows it', () => {
    const tool = checkAddressRisk({ account, maxPricePerCallUsd: 0.5 });
    expect(tool.description).toContain('- deep ($0.50)');
  });

  it.each([
    [{ maxPricePerCallUsd: 0.01 }, /below the cheapest tier/],
    [{ maxPricePerCallUsd: 1, allowedTiers: [] }, /allowedTiers must be a non-empty list/],
    [{ maxPricePerCallUsd: 1, allowedTiers: ['quick'], defaultTier: 'deep' }, /defaultTier/],
  ] as const)('rejects invalid options %#', (overrides, message) => {
    expect(() => checkAddressRisk({ account, ...overrides } as never)).toThrow(message);
  });

  it('is called by generateText and returns the verdict with advice', async () => {
    const api = mockApi({
      paidResponse: tier => settledResponse(verdictBody(tier, 'danger')),
    });
    const tools = verdixTools({
      account,
      maxPricePerCallUsd: 0.1,
      apiUrl: 'https://api.test',
      fetch: api.fetch,
    });

    const { steps } = await generateText({
      model: modelCalling({ address: ADDRESS, tier: 'quick' }),
      prompt: `Send 5 USDC to ${ADDRESS}`,
      tools,
      stopWhen: isStepCount(2),
    });

    const toolResult = steps[0]!.toolResults[0]!;
    expect(toolResult.toolName).toBe('checkAddressRisk');
    expect(toolResult.output).toMatchObject({
      verdict: 'danger',
      tier: 'quick',
      charged: true,
      advice: 'Do not send funds to this address. Show the reasons to the user.',
    });
    expect(api.calls.at(-1)!.url).toBe('https://api.test/risk/address/quick');
  });

  it('uses the default tier when the model gives none', async () => {
    const api = mockApi();
    await generateText({
      model: modelCalling({ address: ADDRESS }),
      prompt: 'Check it',
      tools: verdixTools({ account, maxPricePerCallUsd: 0.1, fetch: api.fetch }),
      stopWhen: isStepCount(2),
    });
    expect(api.calls.at(-1)!.url).toBe('https://api.verdixapi.com/risk/address/standard');
  });

  it('never pays for a tier the model is not allowed to pick', async () => {
    const api = mockApi();
    const { steps } = await generateText({
      model: modelCalling({ address: ADDRESS, tier: 'deep' }),
      prompt: 'Check it',
      tools: verdixTools({ account, maxPricePerCallUsd: 0.1, fetch: api.fetch }),
      stopWhen: isStepCount(2),
    });
    expect(steps[0]!.content.some(part => part.type === 'tool-error')).toBe(true);
    expect(api.calls).toHaveLength(0);
  });
});
