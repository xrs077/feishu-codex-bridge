import { randomUUID } from 'node:crypto';
import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import type { NativeRequest } from '../agent/types';
import { actions, button, card, form, input, md, note, selectMenu, submitButton, type CardElement } from '../card/cards';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import type { CardDispatcher } from '../card/dispatcher';
import { log } from '../core/logger';

type Question = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
};

type Pending = {
  token: string;
  request: NativeRequest;
  chatId: string;
  cwd: string;
  requesterOpenId: string;
  messageId?: string;
  questions?: Question[];
  status: 'pending' | 'answering' | 'answered' | 'expired';
  createdAt: number;
};

const MAX_AGE_MS = 30 * 60_000;
const ACTION_ANSWER = 'native.answer';
const ACTION_APPROVE = 'native.approve';

function questionsFrom(params: Record<string, unknown>): Question[] | null {
  if (!Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 3) return null;
  const questions: Question[] = [];
  for (const raw of params.questions) {
    if (!raw || typeof raw !== 'object') return null;
    const q = raw as Record<string, unknown>;
    if (typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question) return null;
    if (q.options !== null && !Array.isArray(q.options)) return null;
    const options = q.options === null ? null : Array.isArray(q.options)
      ? q.options.map((o: unknown) => {
          if (!o || typeof o !== 'object') return null;
          const option = o as Record<string, unknown>;
          return typeof option.label === 'string' && typeof option.description === 'string'
            ? { label: option.label, description: option.description } : null;
        }) : null;
    if (options?.some((o) => o === null)) return null;
    questions.push({
      id: q.id,
      header: typeof q.header === 'string' ? q.header : '',
      question: q.question,
      isOther: q.isOther === true,
      isSecret: q.isSecret === true,
      options: options as Question['options'],
    });
  }
  if (new Set(questions.map((q) => q.id)).size !== questions.length) return null;
  return questions;
}

/** Map a Feishu form to Codex's native question-id keyed response. */
export function userInputResponse(questions: Question[], values: Record<string, unknown>): { answers: Record<string, { answers: string[] }> } | null {
  const answers: Record<string, { answers: string[] }> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const rawCustom = values[`custom_${i}`];
    const rawSelected = values[`choice_${i}`];
    const custom = typeof rawCustom === 'string' ? rawCustom.trim() : '';
    const selected = typeof rawSelected === 'string' ? rawSelected.trim() : '';
    if (custom && !q.isOther && q.options !== null) return null;
    if (selected && !q.options?.some((o) => o.label === selected)) return null;
    const answer = custom || selected;
    if (!answer) return null;
    answers[q.id] = { answers: [answer] };
  }
  return { answers };
}

function questionCard(p: Pending): object {
  const elements: CardElement[] = [md(`**会话** ${p.request.threadId}\n**问题来自当前 Codex turn**`)];
  if (p.status !== 'pending') {
    elements.push(md(p.status === 'answered' ? '✅ 已回答，原任务继续执行。' : '⏰ 此请求已失效。'));
    return card(elements, { header: { title: 'Codex · 原生提问', template: p.status === 'answered' ? 'green' : 'grey' }, forward: false });
  }
  const fields: CardElement[] = [];
  for (const [i, q] of (p.questions ?? []).entries()) {
    fields.push(md(`**${q.header || `问题 ${i + 1}`}**\n${q.question}`));
    if (q.options?.length) {
      fields.push(selectMenu({ name: `choice_${i}`, placeholder: '请选择', options: q.options.map((o) => ({ label: o.label, value: o.label })) }));
      for (const option of q.options) fields.push(note(`• ${option.label}：${option.description}`));
    }
    if (q.isOther || q.options === null) {
      fields.push(input({ name: `custom_${i}`, placeholder: '自定义回答', maxLength: 1000, width: 'fill' }));
    }
  }
  fields.push(actions([submitButton('提交回答', { a: ACTION_ANSWER, token: p.token })]));
  elements.push(form(`native_${p.token}`, fields));
  return card(elements, { header: { title: 'Codex · 原生提问', template: 'blue' }, forward: false, widthMode: 'fill' });
}

function approvalCard(p: Pending): object {
  const x = p.request.params;
  const command = typeof x.command === 'string' ? x.command : '';
  const reason = typeof x.reason === 'string' ? x.reason : '';
  const label = p.request.method === 'item/commandExecution/requestApproval' ? '执行命令'
    : p.request.method === 'item/fileChange/requestApproval' ? '修改文件' : '请求额外权限';
  const detail = (command || JSON.stringify(x.permissions ?? x.grantRoot ?? '')).replaceAll('```', '` ` `');
  const elements: CardElement[] = [md(`**操作** ${label}\n**目录** ${p.cwd}\n**详情**\n\`\`\`\n${detail.slice(0, 1400)}\n\`\`\`${reason ? `\n**原因** ${reason}` : ''}`)];
  if (p.status === 'pending') {
    const choices = [button('允许一次', { a: ACTION_APPROVE, token: p.token, decision: 'once' }, 'primary')];
    const available = x.availableDecisions;
    if (p.request.method !== 'item/commandExecution/requestApproval' ||
      (Array.isArray(available) && available.includes('acceptForSession'))) {
      choices.push(button('本会话允许', { a: ACTION_APPROVE, token: p.token, decision: 'session' }));
    }
    choices.push(button('拒绝', { a: ACTION_APPROVE, token: p.token, decision: 'deny' }, 'danger'));
    elements.push(actions(choices));
  } else {
    elements.push(note(p.status === 'answered' ? '此请求已处理。' : '此请求已失效。'));
  }
  return card(elements, { header: { title: 'Codex · 原生审批', template: p.status === 'pending' ? 'orange' : 'grey' }, forward: false });
}

function approvalResponse(p: Pending, decision: string): unknown {
  if (p.request.method === 'item/permissions/requestApproval') {
    const requested = p.request.params.permissions;
    const profile = requested && typeof requested === 'object' ? requested as Record<string, unknown> : {};
    const permissions = decision === 'deny' ? {} : {
      ...(profile.network ? { network: profile.network } : {}),
      ...(profile.fileSystem ? { fileSystem: profile.fileSystem } : {}),
    };
    return { permissions, scope: decision === 'session' ? 'session' : 'turn' };
  }
  return { decision: decision === 'deny' ? 'decline' : decision === 'session' ? 'acceptForSession' : 'accept' };
}

/** One in-process router for Codex server requests and Feishu card actions. */
export class NativeRequestBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly channel: LarkChannel,
    dispatcher: CardDispatcher,
    private readonly authorize: (evt: CardActionEvent, pending: { chatId: string; cwd: string; requesterOpenId: string }) => Promise<boolean>,
  ) {
    dispatcher.on(ACTION_ANSWER, ({ evt, value, formValue }) => this.answer(evt, value.token, formValue ?? {}));
    dispatcher.on(ACTION_APPROVE, ({ evt, value }) => this.approve(evt, value.token, value.decision));
  }

  async receive(request: NativeRequest, context: { chatId: string; cwd: string; requesterOpenId: string; replyTo?: string; replyInThread?: boolean }): Promise<void> {
    const known = request.method === 'item/tool/requestUserInput' ||
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval' ||
      request.method === 'item/permissions/requestApproval';
    if (!known || !context.requesterOpenId) { request.reject(); return; }
    const questions = request.method === 'item/tool/requestUserInput' ? questionsFrom(request.params) : undefined;
    if (questions === null || questions?.some((q) => q.isSecret)) {
      request.reject();
      await this.channel.send(context.chatId, { markdown: '此 Codex 问题包含无法安全转发的输入，原请求已拒绝。请重新发起任务并改用安全的输入方式。' }, { replyTo: context.replyTo, replyInThread: context.replyInThread }).catch(() => undefined);
      return;
    }
    for (const existing of this.pending.values()) {
      if (existing.request.threadId === request.threadId && existing.request.requestId === request.requestId) {
        request.reject();
        return;
      }
    }
    const token = randomUUID();
    const pending: Pending = { token, request, chatId: context.chatId, cwd: context.cwd, requesterOpenId: context.requesterOpenId,
      questions, status: 'pending', createdAt: Date.now() };
    this.pending.set(token, pending);
    try {
      const result = await sendManagedCard(this.channel, context.chatId,
        questions ? questionCard(pending) : approvalCard(pending), context.replyTo, context.replyInThread);
      pending.messageId = result.messageId;
      if (!this.pending.has(token)) this.refresh(pending);
    } catch (err) {
      this.pending.delete(token);
      request.reject();
      log.fail('card', err, { phase: 'native-request-send', method: request.method });
    }
  }

  /** Closing a turn invalidates every pending card for it. */
  closeTurn(threadId: string, turnId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.request.threadId !== threadId || pending.request.turnId !== turnId || pending.status !== 'pending') continue;
      pending.status = 'expired';
      pending.request.reject();
      this.refresh(pending);
      this.pending.delete(pending.token);
    }
  }

  closeThread(threadId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.request.threadId !== threadId || pending.status !== 'pending') continue;
      pending.status = 'expired';
      pending.request.reject();
      this.refresh(pending);
      this.pending.delete(pending.token);
    }
  }

  closeRequest(threadId: string, requestId: number | string): void {
    for (const pending of this.pending.values()) {
      if (pending.request.threadId !== threadId || pending.request.requestId !== requestId) continue;
      pending.status = 'expired';
      this.refresh(pending);
      this.pending.delete(pending.token);
    }
  }

  private async claim(evt: CardActionEvent, rawToken: unknown): Promise<Pending | null> {
    if (typeof rawToken !== 'string') return null;
    const pending = this.pending.get(rawToken);
    if (!pending || pending.status !== 'pending') return null;
    if (Date.now() - pending.createdAt > MAX_AGE_MS) {
      pending.status = 'expired';
      pending.request.reject();
      this.refresh(pending);
      this.pending.delete(pending.token);
      return null;
    }
    if (evt.chatId !== pending.chatId || evt.messageId !== pending.messageId) return null;
    if (!(await this.authorize(evt, pending))) return null;
    // A second callback cannot pass once the first has claimed the request.
    if (pending.status !== 'pending') return null;
    pending.status = 'answering';
    return pending;
  }

  private async answer(evt: CardActionEvent, token: unknown, values: Record<string, unknown>): Promise<void> {
    const pending = await this.claim(evt, token);
    if (!pending) return;
    const result = pending.questions && userInputResponse(pending.questions, values);
    if (!result) { pending.status = 'pending'; return; }
    try {
      pending.request.respond(result);
      pending.status = 'answered';
      this.refresh(pending);
      this.pending.delete(pending.token);
    } catch (err) {
      pending.status = 'expired';
      this.refresh(pending);
      this.pending.delete(pending.token);
      log.fail('agent', err, { phase: 'native-user-input-answer' });
    }
  }

  private async approve(evt: CardActionEvent, token: unknown, rawDecision: unknown): Promise<void> {
    if (rawDecision !== 'once' && rawDecision !== 'session' && rawDecision !== 'deny') return;
    const pending = await this.claim(evt, token);
    if (!pending) return;
    if (pending.questions) { pending.status = 'pending'; return; }
    try {
      pending.request.respond(approvalResponse(pending, rawDecision));
      pending.status = 'answered';
      this.refresh(pending);
      this.pending.delete(pending.token);
    } catch (err) {
      pending.status = 'expired';
      this.refresh(pending);
      this.pending.delete(pending.token);
      log.fail('agent', err, { phase: 'native-approval-answer' });
    }
  }

  private refresh(pending: Pending): void {
    if (!pending.messageId) return;
    const messageId = pending.messageId;
    setTimeout(() => {
      void updateManagedCard(this.channel, messageId, pending.questions ? questionCard(pending) : approvalCard(pending))
        .catch((err: unknown) => log.fail('card', err, { phase: 'native-request-close' }));
    }, 500);
  }
}
