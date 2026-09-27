import { describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { NativePlanCard } from '../src/bot/native-plan';
import { sendManagedCard, updateManagedCard } from '../src/card/managed';

vi.mock('../src/card/managed', () => ({
  sendManagedCard: vi.fn(async () => ({ messageId: 'plan-message', cardId: 'plan-card' })),
  updateManagedCard: vi.fn(async () => undefined),
}));

describe('native Plan card', () => {
  it('updates one card and replaces provisional delta with the completed plan', async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    try {
      const plan = new NativePlanCard({} as LarkChannel, 'chat', 'reply', true);
      plan.apply({ type: 'plan_delta', itemId: 'p1', delta: 'partial' });
      await vi.advanceTimersByTimeAsync(400);
      expect(sendManagedCard).toHaveBeenCalledTimes(1);
      plan.apply({ type: 'plan', itemId: 'p1', text: 'final plan' });
      await plan.finish();
      expect(sendManagedCard).toHaveBeenCalledTimes(1);
      expect(updateManagedCard).toHaveBeenCalledTimes(1);
      const final = JSON.stringify(vi.mocked(updateManagedCard).mock.calls[0]![2]);
      expect(final).toContain('final plan');
      expect(final).not.toContain('partial');
    } finally { vi.useRealTimers(); }
  });
});
