import { anthropic, REASONER } from './client';
import { tools } from './tools';
import { executeTool, type AgentCtx } from './toolRunner';
import { getHistory, setHistory } from './memory';
import { SYSTEM_PROMPT } from './prompt';
import { inc, recordLlmLatency, recordTokens } from '../obs/metrics';
import { audit } from '../obs/audit';
import { log } from '../log';

const MAX_STEPS = 5; // guardrail anti-bucle

/** Ejecuta un turno del agente: razona con Claude + tool-calling y devuelve el texto a enviar. */
export async function runAgentTurn(ctx: AgentCtx, userText: string, priorContext = ''): Promise<string> {
  const system = priorContext
    ? `${SYSTEM_PROMPT}\n\nCONTEXTO PREVIO DEL CLIENTE (notas de conversaciones anteriores registradas en el CRM; úsalo para dar continuidad, no lo repitas literal):\n${priorContext}`
    : SYSTEM_PROMPT;
  const messages: any[] = [...(await getHistory(ctx.dialogId)), { role: 'user', content: userText }];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const t0 = Date.now();
      const resp = await anthropic.messages.create({
        model: REASONER,
        max_tokens: 1024,
        temperature: 0.4,
        system,
        messages,
        tools: tools as any,
      });
      recordLlmLatency(Date.now() - t0);
      recordTokens((resp as any).usage);
      inc('llm_calls');

      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = (resp.content as any[]).filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        await setHistory(ctx.dialogId, messages);
        return textOf(resp);
      }

      const results: any[] = [];
      for (const tu of toolUses) {
        inc(`tool:${tu.name}`);
        const result = await executeTool(tu.name, tu.input, ctx);
        await audit({
          type: 'tool_call',
          dialogId: ctx.dialogId,
          crmEntity: ctx.crmEntity ? `${ctx.crmEntity.type}#${ctx.crmEntity.id}` : undefined,
          detail: { name: tu.name, input: tu.input, ok: result?.ok },
        });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
    }

    await setHistory(ctx.dialogId, messages);
    return 'Permíteme derivarte con un asesor para ayudarte mejor 🙌';
  } catch (e) {
    inc('errors');
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
