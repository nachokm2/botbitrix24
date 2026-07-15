import { socialTextTurn, type SocialTextChannel } from './socialText';
import { INSTAGRAM_PROFILE, MESSENGER_PROFILE } from '../core/channel';
import { crearLeadSocial } from '../crm/openlinesCrm';
import type { Auth } from '../store';

// M4 — Adaptador de los canales INSTAGRAM y MESSENGER (Meta Graph API). Misma identidad que Web
// Chat (channels/socialText.ts, ver ALT-Alta-1 de la auditoría): sesión + lead perezoso. Este
// archivo solo declara CÓMO se namespacea el PSID por canal y cómo crea el lead cada uno.
//
// Identidad: cada usuario tiene un PSID (Page-Scoped ID) que Meta asigna por página/cuenta IG. El
// adaptador namespacea el conversationId con el prefijo del canal ("ig-"/"msgr-") — Instagram y
// Messenger usan espacios de PSID distintos igualmente, pero el prefijo deja la memoria (Redis) y
// el lead namespaced de forma explícita, igual que "wc-" en Web Chat.

export type MetaChannel = 'instagram' | 'messenger';

const CHANNELS: Record<MetaChannel, SocialTextChannel> = {
  instagram: {
    namespace: 'meta',
    sessionTtlSec: 30 * 24 * 3600, // el DM de una red social suele retomarse días después
    crearLead: (data, auth) => crearLeadSocial(data, auth, 'instagram'),
    label: 'instagram',
  },
  messenger: {
    namespace: 'meta',
    sessionTtlSec: 30 * 24 * 3600,
    crearLead: (data, auth) => crearLeadSocial(data, auth, 'messenger'),
    label: 'messenger',
  },
};

/** Namespacea el PSID por canal: evita que un mismo id numérico choque entre Instagram y Messenger. */
export function metaConversationId(canal: MetaChannel, psid: string): string {
  return `${canal === 'instagram' ? 'ig' : 'msgr'}-${psid}`;
}

/** Procesa un turno de Instagram/Messenger: mismo motor que WhatsApp/Web Chat, ejecutor compartido. */
export async function metaTurn(psid: string, message: string, auth: Auth, canal: MetaChannel): Promise<string> {
  const conversationId = metaConversationId(canal, psid);
  const profile = canal === 'instagram' ? INSTAGRAM_PROFILE : MESSENGER_PROFILE;
  return socialTextTurn(CHANNELS[canal], conversationId, message, auth, profile);
}
