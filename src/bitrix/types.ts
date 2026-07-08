// Formas mínimas de las respuestas de Bitrix24 REST que el backend consume.
// No mapean toda la API: solo los campos usados. Bitrix devuelve MAYÚSCULAS; se incluyen
// alias en minúscula porque algunas rutas/versiones los han devuelto así (defensa histórica).

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
  EMAIL?: string | string[] | BitrixMultifield[];
  ACTIVE?: boolean;
}
