import { anthropic } from '../ai/client';
import { tools as chatTools } from '../ai/tools';
import { buscarProgramas } from '../ai/catalog';
import { getDetalle } from '../ai/detalles';
import { getHistory, setHistory } from '../ai/memory';
import { actualizarDatosCliente, getDealAsesores, type CrmEntities } from '../crm/openlinesCrm';
import type { CrmRef } from '../crm/telephony';
import { config } from '../config';
import { inc } from '../obs/metrics';
import { log } from '../log';
import type { Auth } from '../store';

const MAX_STEPS = 5;

export type VoiceSession = { callId: string; phone?: string; userId: number; crm?: CrmRef | null };
export type VoiceAction = 'continue' | 'transfer' | 'end';
export type VoiceTurnResult = { reply: string; action: VoiceAction; transferTo?: { asesor?: string; destino?: string } };

// Prompt adaptado a VOZ: frases cortas, sin URLs, una pregunta a la vez.
const VOICE_SYSTEM_PROMPT = `Eres el asistente telefónico de voz de la Universidad Autónoma de Chile (Postgrados). Hablas por TELÉFONO en español de Chile, con tono cercano y profesional.

REGLAS DE VOZ:
- Respuestas MUY breves (1 a 3 frases), naturales para ser escuchadas, no leídas. Una sola pregunta a la vez.
- Nunca leas URLs, correos largos ni listas numeradas extensas. Si hay muchos programas, menciona 2 o 3 y ofrece afinar.
- Usa SIEMPRE "consultar_programas" y "detalle_programa" para datos de programas/precios; nunca inventes nombres, aranceles ni fechas.

OBJETIVO Y FLUJO:
1. Saluda e identifica qué programa o área le interesa.
2. Informa con las herramientas. Comparte arancel/matrícula solo si están disponibles.
3. Captura datos por voz, en este orden y uno a la vez: nombre, luego correo, luego teléfono; confírmalos deletreando si hace falta. Regístralos con "registrar_interes_crm" apenas los tengas. Mantén el "programa de interés" actualizado si cambia.
4. Si la persona quiere hablar con un asesor, muestra intención alta, o pide algo fuera de tu alcance, usa "transferir_a_asesor" (se transfiere la llamada). Si la herramienta devuelve el nombre del asesor, menciónalo con calidez; nunca inventes un nombre.
5. Cuando la conversación termine (se despidió, no necesita más), usa "finalizar_llamada" y despídete brevemente.`;

// Herramientas de voz = catálogo/detalle/registro (reusadas) + transferir/finalizar.
const baseTools = chatTools.filter((t) =>
  ['consultar_programas', 'detalle_programa', 'registrar_interes_crm'].includes(t.name),
);
const voiceTools = [
  ...baseTools,
  {
    name: 'transferir_a_asesor',
    description:
      'Transfiere la llamada en vivo a un asesor humano. Úsala si la persona lo pide, muestra intención alta de ' +
      'matricularse, o la consulta excede tu alcance. La telefonía hará el desvío.',
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: ['motivo'] },
  },
  {
    name: 'finalizar_llamada',
    description: 'Finaliza la llamada cuando la conversación terminó (la persona se despidió o no necesita más).',
    input_schema: { type: 'object', properties: { motivo: { type: 'string' } }, required: [] },
  },
];

function mapCrm(ref: CrmRef | null | undefined): CrmEntities {
  if (!ref) return {};
  const key = ref.type.toLowerCase() as keyof CrmEntities; // CONTACT->contact, LEAD->lead, DEAL->deal, COMPANY->company
  return { [key]: ref.id } as CrmEntities;
}

type TurnState = { action: VoiceAction; transferTo?: { asesor?: string; destino?: string } };

async function execVoiceTool(name: string, input: any, session: VoiceSession, auth: Auth, state: TurnState): Promise<any> {
  try {
    switch (name) {
      case 'consultar_programas': {
        const all = buscarProgramas(input ?? {});
        return { ok: true, total: all.length, programas: all.slice(0, 5) };
      }
      case 'detalle_programa': {
        const d = getDetalle({ url: input?.url, nombre: input?.nombre });
        if (!d) return { ok: false, error: 'SIN_DETALLE' };
        return {
          ok: true,
          detalle: { nombre: d.nombre, arancel: d.arancel, matricula: d.matricula, requisitos: d.requisitos, descripcion: d.descripcion },
        };
      }
      case 'registrar_interes_crm': {
        const r = await actualizarDatosCliente(mapCrm(session.crm), undefined, input ?? {}, auth);
        return { ok: r.ok, actualizado: r.actualizado, error: r.error };
      }
      case 'transferir_a_asesor': {
        state.action = 'transfer';
        let asesor: string | undefined;
        if (session.crm?.type === 'DEAL') {
          try {
            const { responsable } = await getDealAsesores(session.crm.id, auth);
            if (responsable && !responsable.nombre.startsWith('Usuario ')) asesor = responsable.nombre;
          } catch (e) {
            log.warn('voz: no se pudo traer responsable', { err: String(e) });
          }
        }
        state.transferTo = { asesor, destino: config.voiceTransferFallback || undefined };
        return { ok: true, transfiriendo: true, asesor: asesor ?? null };
      }
      case 'finalizar_llamada': {
        state.action = 'end';
        return { ok: true, finalizando: true };
      }
      default:
        return { ok: false, error: 'UNKNOWN_TOOL' };
    }
  } catch (e) {
    log.error('voice tool error', { name, err: String(e) });
    return { ok: false, error: String(e) };
  }
}

/** Ejecuta un turno del agente de VOZ: Claude + tool-calling, devuelve texto + acción (continuar/transferir/colgar). */
export async function runVoiceTurn(session: VoiceSession, userText: string, auth: Auth): Promise<VoiceTurnResult> {
  const dialogId = `voice:${session.callId}`;
  const messages: any[] = [...(await getHistory(dialogId)), { role: 'user', content: userText }];
  const state: TurnState = { action: 'continue' };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const resp = await anthropic.messages.create({
        model: config.voiceModel,
        max_tokens: 512,
        temperature: 0.4,
        system: VOICE_SYSTEM_PROMPT,
        messages,
        tools: voiceTools as any,
      });
      inc('voice_llm_calls');
      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = (resp.content as any[]).filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        await setHistory(dialogId, messages);
        return { reply: textOf(resp), action: state.action, transferTo: state.transferTo };
      }

      const results: any[] = [];
      for (const tu of toolUses) {
        inc(`voice_tool:${tu.name}`);
        const result = await execVoiceTool(tu.name, tu.input, session, auth, state);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
    }

    await setHistory(dialogId, messages);
    return { reply: 'Permíteme derivarte con un asesor para ayudarte mejor.', action: 'transfer', transferTo: state.transferTo };
  } catch (e) {
    inc('errors');
    log.error('voiceAgent error', { err: String(e) });
    return { reply: 'Disculpa, tuve un inconveniente técnico. ¿Puedes repetir, por favor?', action: 'continue' };
  }
}

function textOf(resp: any): string {
  const text = (resp.content as any[])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .trim();
  return text || '¿En qué puedo ayudarte con nuestros postgrados?';
}
