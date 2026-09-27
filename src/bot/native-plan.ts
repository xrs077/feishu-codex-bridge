import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentEvent } from '../agent/types';
import { card, md, note } from '../card/cards';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { log } from '../core/logger';

/** One Feishu card per Codex turn. Deltas are provisional; the completed plan item wins. */
export class NativePlanCard {
  private readonly drafts = new Map<string, string>();
  private readonly complete = new Map<string, string>();
  private steps: Array<{ step: string; status: string }> = [];
  private explanation: string | null = null;
  private messageId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  private finished = false;

  constructor(
    private readonly channel: LarkChannel,
    private readonly chatId: string,
    private readonly replyTo: string,
    private readonly replyInThread: boolean,
  ) {}

  apply(event: AgentEvent): void {
    if (event.type === 'plan_delta') {
      this.drafts.set(event.itemId, (this.drafts.get(event.itemId) ?? '') + event.delta);
    } else if (event.type === 'plan') {
      this.complete.set(event.itemId, event.text);
    } else if (event.type === 'plan_steps') {
      this.steps = event.steps;
      this.explanation = event.explanation;
    } else return;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.enqueue(); }, 400);
  }

  async finish(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.finished = true;
    if (this.drafts.size || this.complete.size || this.steps.length) this.enqueue();
    await this.chain;
  }

  private enqueue(): void {
    const body = this.render();
    this.chain = this.chain.then(async () => {
      if (this.messageId) await updateManagedCard(this.channel, this.messageId, body);
      else this.messageId = (await sendManagedCard(this.channel, this.chatId, body, this.replyTo, this.replyInThread)).messageId;
    }).catch((err: unknown) => log.fail('card', err, { phase: 'native-plan' }));
  }

  private render(): object {
    const latest = [...this.complete.entries()].at(-1) ?? [...this.drafts.entries()].at(-1);
    const text = latest ? (this.complete.get(latest[0]) ?? latest[1]) : '';
    const stepLines = this.steps.map((s, i) => `${s.status === 'completed' ? '✓' : s.status === 'inProgress' ? '→' : '○'} ${i + 1}. ${s.step}`);
    const elements = [
      md(text || stepLines.join('\n') || '正在规划…'),
      ...(text && stepLines.length ? [md(`**执行进度**\n${stepLines.join('\n')}`)] : []),
      ...(this.explanation ? [note(this.explanation)] : []),
      note(this.finished ? 'Plan turn 已结束。若要执行，请回复具体指令。' : '正在更新原生 Plan；提问会以单独卡片显示。'),
    ];
    return card(elements, { header: { title: 'Codex · Plan Mode', template: this.finished ? 'green' : 'blue' }, forward: false, widthMode: 'fill' });
  }
}
