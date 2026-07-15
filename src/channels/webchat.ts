import { socialTextTurn, getLeadSession, type SocialTextChannel } from './socialText';
import { WEBCHAT_PROFILE } from '../core/channel';
import { crearLeadWeb } from '../crm/openlinesCrm';
import type { Auth } from '../store';

// M3 — Adaptador del canal WEB CHAT. Es la PRUEBA del patrón omnicanal: un canal nuevo = un PERFIL
// (core/channel.ts) + una IDENTIDAD (channels/socialText.ts, compartida con Meta) + un ADAPTADOR
// (este archivo, que solo declara CÓMO crea el lead este canal). No duplica el motor ni el ejecutor.

const CHANNEL: SocialTextChannel = {
  namespace: 'webchat',
  sessionTtlSec: 24 * 3600, // el chat de un visitante web se retoma típicamente el mismo día
  crearLead: crearLeadWeb,
  label: 'webchat',
};

export async function getWebchatSession(conversationId: string) {
  return getLeadSession(CHANNEL, conversationId);
}

/** Procesa un turno del chat web: mismo motor que WhatsApp, con el perfil y el ejecutor compartido. */
export async function webchatTurn(conversationId: string, message: string, auth: Auth): Promise<string> {
  return socialTextTurn(CHANNEL, conversationId, message, auth, WEBCHAT_PROFILE);
}
