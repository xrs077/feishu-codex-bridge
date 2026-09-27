import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { writeNodeExecutable } from './helpers/node-executable';

const SERVER = `#!/usr/bin/env node
const readline = require('node:readline');
const send = (m) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let turns=0;
readline.createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if(m.method==='initialize') return send({id:m.id,result:{}});
  if(m.method==='thread/start') return send({id:m.id,result:{thread:{id:'host'}}});
  if(m.method==='turn/start') {
    turns++;
    if(m.params.collaborationMode?.mode!=='plan') return send({id:m.id,error:{code:-32000,message:'missing Plan Mode'}});
    send({id:76,method:'item/tool/requestUserInput',params:{threadId:'host',turnId:'stale-turn',itemId:'stale',questions:[]}});
    send({id:77,method:'item/tool/requestUserInput',params:{threadId:'host',turnId:'turn-1',itemId:'ask-1',questions:[{id:'q1',header:'Choice',question:'Which?',isOther:true,isSecret:false,options:null}],isBlocking:true}});
    send({id:m.id,result:{turn:{id:'turn-1'}}});
    send({method:'turn/started',params:{threadId:'host',turn:{id:'turn-1'}}});
    return;
  }
  if(m.id===77 && m.result) {
    const answer=m.result.answers.q1.answers[0];
    send({method:'item/plan/delta',params:{threadId:'host',turnId:'turn-1',itemId:'plan-1',delta:'draft'}});
    send({method:'item/completed',params:{threadId:'host',turnId:'turn-1',item:{type:'plan',id:'plan-1',text:'Plan for '+answer}}});
    send({method:'item/completed',params:{threadId:'host',turnId:'turn-1',item:{type:'agentMessage',id:'answer',text:'continued; turns='+turns,phase:null,memoryCitation:null}}});
    send({method:'turn/completed',params:{threadId:'host',turn:{id:'turn-1'}}});
  }
});`;
const dir = mkdtempSync(join(tmpdir(), 'native-turn-'));
const { bin } = writeNodeExecutable(dir, 'codex', SERVER);
afterAll(async () => { await shutdownResidentClients(); rmSync(dir, { recursive: true, force: true }); });

describe('native request continuation', () => {
  it('answers the original server request and continues the same turn', async () => {
    const prev = process.env.CODEX_BIN;
    process.env.CODEX_BIN = bin;
    const thread = await new CodexAppServerBackend().startThread({ cwd: dir, model: 'gpt-5.5' });
    try {
      const requests: string[] = [];
      thread.setNativeRequestHandler?.((request) => {
        requests.push(`${request.threadId}/${request.turnId}/${request.itemId}/${request.requestId}`);
        request.respond({ answers: { q1: { answers: ['A'] } } });
      });
      const events = [];
      for await (const event of thread.runStreamed({ text: 'plan' }, { collaborationMode: 'plan' }).events) events.push(event);
      expect(requests).toEqual(['host/turn-1/ask-1/77']);
      expect(events).toContainEqual({ type: 'plan_delta', itemId: 'plan-1', delta: 'draft' });
      expect(events).toContainEqual({ type: 'plan', itemId: 'plan-1', text: 'Plan for A' });
      expect(events).toContainEqual({ type: 'text', itemId: 'answer', text: 'continued; turns=1' });
      expect(events.at(-1)).toEqual({ type: 'done', turnId: 'turn-1' });
    } finally {
      await thread.close();
      if (prev === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prev;
    }
  });
});
