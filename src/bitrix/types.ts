// Formas mínimas de las respuestas de Bitrix24 REST que el backend consume.
// No mapean toda la API: solo los campos usados. Bitrix devuelve MAYÚSCULAS; se incluyen
// alias en minúscula donde alguna ruta/versión los ha devuelto así (defensa histórica).
// Todos los campos son opcionales: las respuestas varían por método, permisos y versión del portal.

export interface BitrixMultifield {
  ID?: string | number;
  VALUE?: string;
  VALUE_TYPE?: string;
}

export interface BitrixDeal {
  CATEGORY_ID?: string | number;
  categoryId?: string | number;
  ASSIGNED_BY_ID?: string | number;
  assignedById?: string | number;
  OBSERVER_IDS?: string | string[] | number[];
  observerIds?: string | string[] | number[];
  TITLE?: string;
  STAGE_ID?: string;
}

export interface BitrixContact {
  ID?: string | number;
  NAME?: string;
  LAST_NAME?: string;
  EMAIL?: BitrixMultifield[];
  PHONE?: BitrixMultifield[];
}

export interface BitrixLead extends BitrixContact {
  TITLE?: string;
}

export interface BitrixUser {
  ID?: string | number;
  NAME?: string;
  LAST_NAME?: string;
  EMAIL?: string | BitrixMultifield[];
  ACTIVE?: boolean;
}

/** imopenlines.dialog.get / payload de instalación: trae la vinculación CRM del chat. */
export interface BitrixDialog {
  entity_data_2?: string;
}

/** crm.timeline.comment.list */
export interface BitrixTimelineComment {
  ID?: string | number;
  CREATED?: string;
  COMMENT?: string;
}
export type BitrixTimelineCommentResponse = BitrixTimelineComment[] | { comments?: BitrixTimelineComment[] };

/** crm.duplicate.findbycomm */
export interface BitrixDuplicateResult {
  CONTACT?: (string | number)[];
  LEAD?: (string | number)[];
  COMPANY?: (string | number)[];
}

/** crm.deal.list (con select ['ID']) */
export interface BitrixDealListItem {
  ID?: string | number;
}

/** tasks.task.add */
export interface BitrixTaskAddResult {
  task?: { id?: string | number };
  id?: string | number;
}

/** Ítem de crm.{contact,company,lead}.list usado para resolver nombres. */
export interface BitrixCrmListItem {
  ID?: string | number;
  NAME?: string;
  LAST_NAME?: string;
  COMPANY_TITLE?: string;
  TITLE?: string;
}
export type BitrixCrmListResponse = BitrixCrmListItem[] | { items?: BitrixCrmListItem[] };

/** crm.category.list / crm.status.list (diagnóstico de etapas de deal). */
export interface BitrixCategory {
  id?: string | number;
  name?: string;
}
export type BitrixCategoryListResponse = { categories?: BitrixCategory[] } | BitrixCategory[];
export interface BitrixStatus {
  STATUS_ID?: string;
  NAME?: string;
}
export type BitrixStatusListResponse = BitrixStatus[] | { result?: BitrixStatus[] };

/** telephony.externalCall.searchCrmEntities (ítem del array). */
export interface BitrixTelephonyEntity {
  CRM_ENTITY_TYPE?: string;
  CRM_ENTITY_ID?: string | number;
}

/** telephony.externalCall.register (respuesta). */
export interface BitrixCallRegisterResult {
  CALL_ID?: string;
  CRM_ENTITY_TYPE?: string;
  CRM_ENTITY_ID?: string | number;
  CRM_CREATED_LEAD?: string | number;
}

/** Fila cruda de voximplant.statistic.get. */
export interface VoximplantCall {
  ID?: string | number;
  CALL_START_DATE?: string;
  CALL_TYPE?: string | number;
  PHONE_NUMBER?: string;
  CALL_DURATION?: string | number;
  PORTAL_USER_ID?: string | number;
  CALL_FAILED_CODE?: string | number;
  CALL_RECORD_URL?: string;
  CRM_ENTITY_TYPE?: string;
  CRM_ENTITY_ID?: string | number;
}

/** oauth.bitrix.info/oauth/token (respuesta del grant). */
export interface BitrixOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  domain?: string;
  member_id?: string;
  expires?: string | number;
  error?: string;
  error_description?: string;
}
