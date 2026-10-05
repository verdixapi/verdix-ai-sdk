import { generateText, isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { verdixNeedsApproval, type VerdixCheckResult } from '../src';
import { ADDRESS, mockApi, settledResponse, verdictBody } from './mock-api';

const account = privateKeyToAccount(generatePrivateKey());

function needsApprovalWith(verdict: string, overrides: Record<string, unknown> = {}) {
  const api = mockApi({ paidResponse: tier => settledResponse(verdictBody(tier, verdict)) });
  const needsApproval = verdixNeedsApproval({
    account,
    maxPricePerCallUsd: 0.02,
    fetch: api.fetch,
    ...overrides,
  });
  return { api, needsApproval };
}

describe('verdixNeedsApproval', () => {
  it('runs without approval when Verdix says safe', async () => {
    const { api, needsApproval } = needsApprovalWith('safe');
    expect(await needsApproval({ to: ADDRESS, amount: 5 })).toBe(false);
    expect(api.calls.at(-1)).toMatchObject({
      url: 'https://api.verdixapi.com/risk/address/quick',
      paid: true,
      body: { address: ADDRESS, chain: 'base' },
    });
  });

  it.each(['caution', 'danger'])('asks for approval when Verdix says %s', async verdict => {
    const { needsApproval } = needsApprovalWith(verdict);
    expect(await needsApproval({ to: ADDRESS })).toBe(true);
  });

  it('finds the address in to, recipient or address, or where you say', async () => {
    for (const input of [{ to: ADDRESS }, { recipient: ADDRESS }, { address: ADDRESS }]) {
      const { api, needsApproval } = needsApprovalWith('safe');
      expect(await needsApproval(input)).toBe(false);
      expect(api.calls).toHaveLength(2);
    }
    const byField = needsApprovalWith('safe', { address: 'dest' });
    expect(await byField.needsApproval({ dest: ADDRESS })).toBe(false);
    const byFunction = needsApprovalWith('safe', {
      address: (input: { payment: { to: string } }) => input.payment.to,
    });
    expect(await byFunction.needsApproval({ payment: { to: ADDRESS } })).toBe(false);
  });

  it('asks for approval, without paying, when no address is found', async () => {
    const { api, needsApproval } = needsApprovalWith('safe');
    expect(await needsApproval({ to: 'vitalik.eth' })).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it('asks for approval when the check fails', async () => {
    const down = verdixNeedsApproval({
      account,
      maxPricePerCallUsd: 0.02,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await down({ to: ADDRESS })).toBe(true);

    // The quick tier costs $0.02, over this cap: refused, nothing paid.
    const { api, needsApproval } = needsApprovalWith('safe', { maxPricePerCallUsd: 0.01 });
    expect(await needsApproval({ to: ADDRESS })).toBe(true);
    expect(api.calls.every(call => !call.paid)).toBe(true);
  });

  it('uses the chosen tier and reports each answer to onResult', async () => {
    const seen: VerdixCheckResult[] = [];
    const { api, needsApproval } = needsApprovalWith('danger', {
      tier: 'standard',
      maxPricePerCallUsd: 0.1,
      onResult: (result: VerdixCheckResult) => seen.push(result),
    });
    expect(await needsApproval({ to: ADDRESS })).toBe(true);
    expect(api.calls.at(-1)!.url).toBe('https://api.verdixapi.com/risk/address/standard');
    expect(seen).toMatchObject([{ verdict: 'danger', reasons: ['burn_address'] }]);
  });

  it('rejects an unknown tier', () => {
    expect(() =>
      verdixNeedsApproval({ account, maxPricePerCallUsd: 1, tier: 'lite' as never }),
    ).toThrow(/tier must be one of/);
  });

  it.each([
    ['safe', 'tool-result'],
    ['danger', 'tool-approval-request'],
  ])('in generateText, a %s recipient gives a %s', async (verdict, partType) => {
    const { needsApproval } = needsApprovalWith(verdict);
    const sent: string[] = [];
    const sendUsdc = tool({
      description: 'Send USDC on Base',
      inputSchema: z.object({ to: z.string(), amount: z.number() }),
      needsApproval,
      execute: async ({ to }) => (sent.push(to), 'sent'),
    });

    const { steps } = await generateText({
      model: new MockLanguageModelV4({
        doGenerate: {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'sendUsdc',
              input: JSON.stringify({ to: ADDRESS, amount: 5 }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        },
      }),
      prompt: `Send 5 USDC to ${ADDRESS}`,
      tools: { sendUsdc },
      stopWhen: isStepCount(1),
    });

    expect(steps[0]!.content.some(part => part.type === partType)).toBe(true);
    expect(sent).toEqual(verdict === 'safe' ? [ADDRESS] : []);
  });
});
