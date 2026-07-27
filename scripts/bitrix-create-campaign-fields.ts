import 'dotenv/config';

// Crea los campos personalizados (UF) en el DEAL que necesita la campaña de voz saliente (Fase 0):
//   - Clasificación (8 categorías de cierre)   → enumeration
//   - Prioridad (alta/media/baja)              → enumeration
//   - Próximo seguimiento (fecha)              → datetime
//   - Intentos de llamada (0..9)               → integer
// El SCORE ya existe (BITRIX_UF_SCORE del módulo de scoring): NO se recrea aquí.
// Idempotente: si un campo ya existe (por XML_ID) NO lo duplica. Imprime los códigos + variables de entorno.
//
// AUTO-CONTENIDO a propósito: llama al webhook admin (BITRIX_WEBHOOK_URL) con fetch DIRECTO y timeout,
// SIN importar el cliente de la app (evita arrastrar Redis/limiter/refresh, que colgaban el proceso).
// Uso: en la carpeta del repo, con BITRIX_WEBHOOK_URL en .env → npx tsx scripts/bitrix-create-campaign-fields.ts

const WEBHOOK = (process.env.BITRIX_WEBHOOK_URL ?? '').replace(/\/$/, '');
const TIMEOUT_MS = 20_000;

/** POST JSON al webhook con timeout (AbortController). Devuelve el JSON; lanza si hay error de Bitrix. */
async function call(method: string, params: Record<string, unknown>): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${WEBHOOK}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => ({ error: `HTTP ${res.status}: respuesta no-JSON` }));
    if (json.error) throw new Error(`${method}: ${json.error} ${json.error_description ?? ''}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

type Desired = {
  fieldName: string; // Bitrix crea UF_CRM_<fieldName>
  xmlId: string; // identificador estable para detectar duplicados
  userType: 'enumeration' | 'datetime' | 'integer' | 'double';
  labelEs: string;
  labelEn: string;
  list?: string[]; // valores para enumeration
};

const DESIRED: Desired[] = [
  {
    fieldName: 'CAMP_CLASIFICACION', xmlId: 'UF_CAMP_CLASIFICACION', userType: 'enumeration',
    labelEs: 'Clasificación (IA voz)', labelEn: 'Classification (AI voice)',
    list: ['Muy interesado', 'Interesado', 'Requiere seguimiento', 'Más adelante', 'No interesado', 'No contesta', 'Número incorrecto', 'No es el titular'],
  },
  {
    fieldName: 'CAMP_PRIORIDAD', xmlId: 'UF_CAMP_PRIORIDAD', userType: 'enumeration',
    labelEs: 'Prioridad (IA voz)', labelEn: 'Priority (AI voice)', list: ['alta', 'media', 'baja'],
  },
  {
    fieldName: 'CAMP_PROX_SEGUIMIENTO', xmlId: 'UF_CAMP_PROX_SEGUIMIENTO', userType: 'datetime',
    labelEs: 'Próximo seguimiento', labelEn: 'Next follow-up',
  },
  {
    fieldName: 'CAMP_INTENTOS', xmlId: 'UF_CAMP_INTENTOS', userType: 'integer',
    labelEs: 'Intentos de llamada', labelEn: 'Call attempts',
  },
];

const ENV_VAR: Record<string, string> = {
  CAMP_CLASIFICACION: 'BITRIX_UF_CLASIFICACION',
  CAMP_PRIORIDAD: 'BITRIX_UF_PRIORIDAD',
  CAMP_PROX_SEGUIMIENTO: 'BITRIX_UF_PROX_SEGUIMIENTO',
  CAMP_INTENTOS: 'BITRIX_UF_INTENTOS',
};

async function crear(d: Desired): Promise<string | null> {
  const fields: any = {
    FIELD_NAME: d.fieldName,
    XML_ID: d.xmlId,
    USER_TYPE_ID: d.userType,
    EDIT_FORM_LABEL: { es: d.labelEs, en: d.labelEn },
    LIST_COLUMN_LABEL: { es: d.labelEs, en: d.labelEn },
    LIST_FILTER_LABEL: { es: d.labelEs, en: d.labelEn },
    MULTIPLE: 'N', MANDATORY: 'N', SHOW_IN_LIST: 'Y', EDIT_IN_LIST: 'Y',
    IS_SEARCHABLE: d.userType === 'integer' || d.userType === 'enumeration' ? 'Y' : 'N',
  };
  if (d.list) fields.LIST = d.list.map((VALUE) => ({ VALUE }));

  const r = await call('crm.deal.userfield.add', { fields });
  const id = r.result;
  const created = await call('crm.deal.userfield.list', { filter: { ID: id } });
  return created?.result?.[0]?.FIELD_NAME ?? null;
}

async function main() {
  if (!WEBHOOK) throw new Error('Falta BITRIX_WEBHOOK_URL en .env (webhook admin con scope crm).');
  console.log(`Webhook: ${WEBHOOK.replace(/\/[^/]+\/[^/]+$/, '/****/****')}`); // enmascara user/code

  const list = await call('crm.deal.userfield.list', {});
  const all: any[] = list.result ?? [];
  const existentes = new Map<string, string>();
  for (const f of all) if (f.XML_ID) existentes.set(String(f.XML_ID), String(f.FIELD_NAME));
  console.log(`Total campos UF del Deal: ${all.length}\n`);

  const resultado: { campo: string; code: string; env: string; estado: string }[] = [];
  for (const d of DESIRED) {
    const ya = existentes.get(d.xmlId);
    if (ya) {
      console.log(`  · ${d.fieldName}: ya existía (${ya})`);
      resultado.push({ campo: d.fieldName, code: ya, env: ENV_VAR[d.fieldName], estado: 'ya existía' });
      continue;
    }
    process.stdout.write(`  · ${d.fieldName}: creando… `);
    try {
      const code = await crear(d);
      console.log(`✅ ${code}`);
      resultado.push({ campo: d.fieldName, code: code ?? '(desconocido)', env: ENV_VAR[d.fieldName], estado: 'creado' });
    } catch (e) {
      console.log(`❌ ${String(e)}`);
      resultado.push({ campo: d.fieldName, code: '—', env: ENV_VAR[d.fieldName], estado: 'error' });
    }
  }

  console.log('\n── Variables para Railway (env) ──');
  for (const r of resultado) if (r.code && r.code !== '—') console.log(`${r.env}=${r.code}`);
  console.log('\nNota: el SCORE ya existe (BITRIX_UF_SCORE del módulo de scoring); no se recrea aquí.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
