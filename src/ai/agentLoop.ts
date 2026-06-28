import { anthropic, REASONER } from './client';
import { tools } from './tools';
import { executeTool, type AgentCtx } from './toolRunner';
import { getHistory, setHistory } from './memory';
import { SYSTEM_PROMPT } from './prompt';
import { log } from '../log';

const MAX_STEPS = 5; // guardrail anti-bucle

/** Ejecuta un turno del agente: razona con Claude + tool-calling y devuelve el texto a enviar. */
export async function runAgentTurn(ctx: AgentCtx, userText: string): Promise<string> {
  const messages: any[] = [...getHistory(ctx.dialogId), { role: 'user', content: userText }];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const resp = await anthropic.messages.create({
        model: REASONER,
        max_tokens: 1024,
        temperature: 0.4,
        system: SYSTEM_PROMPT,
        messages,
        tools: tools as any,
      });

      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = (resp.content as any[]).filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        setHistory(ctx.dialogId, messages);
        return textOf(resp);
      }

      const results: any[] = [];
      for (const tu of toolUses) {
        log.info('tool_use', { name: tu.name });
        const result = await executeTool(tu.name, tu.input, ctx);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
    }

    setHistory(ctx.dialogId, messages);
    return 'Permíteme derivarte con un asesor para ayudarte mejor 🙌';
  } catch (e) {
    log.error('agentLoop error', { err: String(e) });
    return 'Disculpa, tuve un inconveniente técnico. ¿Puedes repetir tu consulta?';
  }
}

function textOf(resp: any): string {
  const text = (resp.content as any[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || '¿En qué puedo ayudarte con nuestros postgrados?';
}
