import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import type { NativeRequest } from '../src/agent/types';
import { CardDispatcher } from '../src/card/dispatcher';
import { NativeRequestBridge, userInputResponse } from '../src/bot/native-requests';
import { sendManagedCard } from '../src/card/managed';

vi.mock('../src/card/managed', () => ({
  sendManagedCard: vi.fn(async () => ({ messageId: 'card-message', cardId: 'card-1' })),
  updateManagedCard: vi.fn(async () => undefined),
}));

const questions = [
  { id: 'q1', header: 'Mode', question: 'Choose mode', isOther: true, isSecret: false,
    options: [{ label: 'A', description: 'Option A' }, { label: 'B', description: 'Option B' }] },
  { id: 'q2', header: 'Reason', question: 'Why?', isOther: false, isSecret: false, options: null },
];

function callbackToken(card: unknown): string {
  const find = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const obj = value as Record<string, unknown>;
    if (typeof obj.token === 'string') return obj.token;
    for (const child of Object.values(obj)) {
      if (Array.isArray(child)) {
        for (const part of child) { const token = find(part); if (token) return token; }
      } else { const token = find(child); if (token) return token; }
    }
    return undefined;
  };
  return find(card)!;
}

function event(token: string, chatId = 'chat', messageId = 'card-message'): CardActionEvent {
  return { chatId, messageId, operator: { openId: 'owner' }, action: { value: { a: 'native.answer', token } },
    raw: { action: { form_value: { choice_0: 'B', custom_1: 'Because it fits' } } } } as unknown as CardActionEvent;
}

describe('native user input card', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps multiple questions, choices and free text by question id', () => {
    expect(userInputResponse(questions, { choice_0: 'A', custom_1: 'details' })).toEqual({
      answers: { q1: { answers: ['A'] }, q2: { answers: ['details'] } },
    });
    expect(userInputResponse(questions, { choice_0: 'Unknown', custom_1: 'details' })).toBeNull();
  });

  it('accepts the first authorized card answer only and rejects wrong card/thread context', async () => {
    const channel = { send: vi.fn(async () => undefined) } as unknown as LarkChannel;
    const dispatcher = new CardDispatcher(channel, {} as never);
    const bridge = new NativeRequestBridge(channel, dispatcher, async (evt, pending) =>
      evt.operator?.openId === 'owner' && pending.cwd === '/workspace');
    const respond = vi.fn();
    const reject = vi.fn();
    const request: NativeRequest = { requestId: 77, method: 'item/tool/requestUserInput', threadId: 'thread-A',
      turnId: 'turn-1', itemId: 'ask-1', params: { questions }, respond, reject };
    await bridge.receive(request, { chatId: 'chat', cwd: '/workspace', requesterOpenId: 'owner' });
    const card = vi.mocked(sendManagedCard).mock.calls[0]![2];
    const token = callbackToken(card);
    await dispatcher.handle(event(token, 'other-chat'));
    await dispatcher.handle(event(token, 'chat', 'other-message'));
    expect(respond).not.toHaveBeenCalled();
    await dispatcher.handle(event(token));
    await dispatcher.handle(event(token));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ answers: {
      q1: { answers: ['B'] }, q2: { answers: ['Because it fits'] },
    } });
    expect(reject).not.toHaveBeenCalled();
  });

  it('expires a request when Codex resolves it elsewhere', async () => {
    const channel = { send: vi.fn(async () => undefined) } as unknown as LarkChannel;
    const dispatcher = new CardDispatcher(channel, {} as never);
    const bridge = new NativeRequestBridge(channel, dispatcher, async () => true);
    const respond = vi.fn();
    await bridge.receive({ requestId: 78, method: 'item/tool/requestUserInput', threadId: 'thread-A', turnId: 'turn-1',
      itemId: 'ask-2', params: { questions }, respond, reject: vi.fn() },
    { chatId: 'chat', cwd: '/workspace', requesterOpenId: 'owner' });
    const token = callbackToken(vi.mocked(sendManagedCard).mock.calls[0]![2]);
    bridge.closeRequest('thread-B', 78);
    await dispatcher.handle(event(token));
    expect(respond).toHaveBeenCalledTimes(1);
    await bridge.receive({ requestId: 79, method: 'item/tool/requestUserInput', threadId: 'thread-A', turnId: 'turn-2',
      itemId: 'ask-3', params: { questions }, respond, reject: vi.fn() },
    { chatId: 'chat', cwd: '/workspace', requesterOpenId: 'owner' });
    const nextToken = callbackToken(vi.mocked(sendManagedCard).mock.calls[1]![2]);
    bridge.closeRequest('thread-A', 79);
    await dispatcher.handle(event(nextToken));
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('rejects a card response after its timeout', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      const channel = { send: vi.fn(async () => undefined) } as unknown as LarkChannel;
      const dispatcher = new CardDispatcher(channel, {} as never);
      const bridge = new NativeRequestBridge(channel, dispatcher, async () => true);
      const respond = vi.fn();
      await bridge.receive({ requestId: 80, method: 'item/tool/requestUserInput', threadId: 'thread-A', turnId: 'turn-3',
        itemId: 'ask-4', params: { questions }, respond, reject: vi.fn() },
      { chatId: 'chat', cwd: '/workspace', requesterOpenId: 'owner' });
      const token = callbackToken(vi.mocked(sendManagedCard).mock.calls[0]![2]);
      vi.setSystemTime(31 * 60_000);
      await dispatcher.handle(event(token));
      expect(respond).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('returns native command and permission approval responses', async () => {
    const channel = { send: vi.fn(async () => undefined) } as unknown as LarkChannel;
    const dispatcher = new CardDispatcher(channel, {} as never);
    const bridge = new NativeRequestBridge(channel, dispatcher, async () => true);
    const commandRespond = vi.fn();
    await bridge.receive({ requestId: 81, method: 'item/commandExecution/requestApproval', threadId: 'thread-A',
      turnId: 'turn-4', itemId: 'cmd', params: { command: 'npm install' }, respond: commandRespond, reject: vi.fn() },
    { chatId: 'chat', cwd: '/workspace', requesterOpenId: 'owner' });
    const commandToken = callbackToken(vi.mocked(sendManagedCard).mock.calls[0]![2]);
    await dispatcher.handle({ ...event(commandToken), action: { value: { a: 'native.approve', token: commandToken, decision: 'once' } } } as CardActionEvent);
    expect(commandRespond).toHaveBeenCalledWith({ decision: 'accept' });

    const permissionRespond = vi.fn();
    await bridge.receive({ requestId: 82, method: 'item/permissions/requestApproval', threadId: 'thread-A',
      turnId: 'turn-4', itemId: 'permission', params: { permissions: { network: { enabled: true }, fileSystem: null } },
      respond: permissionRespond, reject: vi.fn() },
    { chatId: 'chat', cwd: '/workspace', requesterOpenId: 'owner' });
    const permissionToken = callbackToken(vi.mocked(sendManagedCard).mock.calls[1]![2]);
    await dispatcher.handle({ ...event(permissionToken), action: { value: { a: 'native.approve', token: permissionToken, decision: 'session' } } } as CardActionEvent);
    expect(permissionRespond).toHaveBeenCalledWith({ permissions: { network: { enabled: true } }, scope: 'session' });
  });
});
