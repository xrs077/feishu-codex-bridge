import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';

const live = process.env.RUN_CODEX_NATIVE_LIVE === '1' ? it : it.skip;
afterAll(shutdownResidentClients);

live('current Codex app-server asks and resumes within a native Plan turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'codex-native-live-'));
  const backend = new CodexAppServerBackend();
  const models = await backend.listModels();
  const selected = models.find((m) => m.isDefault) ?? models[0];
  if (!selected) throw new Error('Codex model/list returned no model');
  const thread = await backend.startThread({ cwd, model: selected.id, effort: selected.defaultEffort, mode: 'write' });
  try {
    const requests: string[] = [];
    thread.setNativeRequestHandler?.((request) => {
      requests.push(request.method);
      if (request.method === 'item/tool/requestUserInput') {
        const questions = request.params.questions as Array<{ id: string; options: Array<{ label: string }> | null }>;
        const answers = Object.fromEntries(questions.map((q) => [q.id, { answers: [q.options?.[0]?.label ?? 'A'] }]));
        request.respond({ answers });
      } else request.reject();
    });
    const events: string[] = [];
    const consume = (async () => {
      for await (const event of thread.runStreamed({ text:
        '只规划，不修改文件或运行命令。请先用原生 request_user_input 工具问我选 A 还是 B；收到选择后输出一个两步计划。' },
      { collaborationMode: 'plan' }).events) events.push(event.type);
    })();
    await Promise.race([consume, new Promise((_, reject) => setTimeout(() =>
      reject(new Error(`live Plan timeout; requests=${requests.join(',')}; events=${events.join(',')}`)), 30_000))]);
    expect(requests).toContain('item/tool/requestUserInput');
    expect(events).toContain('done');
  } finally {
    await thread.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 40_000);
