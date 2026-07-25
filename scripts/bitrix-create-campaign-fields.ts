import { callCrm } from '../src/bitrix/client';

// Crea los campos personalizados (UF) en el DEAL que necesita la campaña de voz saliente (Fase 0):
//   - Clasificación (8 categorías de cierre)   → enumeration
//   - Prioridad (alta/media/baja)              → enumeration
//   - Próximo seguimiento (fecha)              → datetime
//   - Intentos de llamada (0..9)               → integer
// El SCORE ya existe (config.ufScore / BITRIX_UF_SCORE del módulo de scoring): NO se recrea aquí.
// Idempotente: si un campo ya existe (por XML_ID) NO lo duplica. Usa el webhook admin (BITRIX_WEBHOOK_URL),
// con scope `crm`. No importa '../src/store' (evita levantar Redis, que cuelga en un shell local).
// Uso: railway run -- npx tsx scripts/bitrix-create-campaign-fields.ts

const AUTH = { domain: '', access_token: '' } as any;

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
    fieldName: 'CAMP_CLASIFICACION',
    xmlId: 'UF_CAMP_CLASIFICACION',
    userType: 'enumeration',
    labelEs: 'Clasificación (IA voz)',
    labelEn: 'Classification (AI voice)',
    list: [
      'Muy interesado',
      'Interesado',
      'Requiere seguimiento',
      'Más adelante',
      'No interesado',
      'No contesta',
      'Número incorrecto',
      'No es el titular',
    ],
  },
  {
    fieldName: 'CAMP_PRIORIDAD',
    xmlId: 'UF_CAMP_PRIORIDAD',
    userType: 'enumeration',
    labelEs: 'Prioridad (IA voz)',
    labelEn: 'Priority (AI voice)',
    list: ['alta', 'media', 'baja'],
  },
  {
    fieldName: 'CAMP_PROX_SEGUIMIENTO',
    xmlId: 'UF_CAMP_PROX_SEGUIMIENTO',
    userType: 'datetime',
    labelEs: 'Próximo seguimiento',
    labelEn: 'Next follow-up',
  },
  {
    fieldName: 'CAMP_INTENTOS',
    xmlId: 'UF_CAMP_INTENTOS',
    userType: 'integer',
    labelEs: 'Intentos de llamada',
    labelEn: 'Call attempts',
  },
];

// Mapea cada campo creado a la variable de entorno que lo consume (programRegistry.ts).
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
    MULTIPLE: 'N',
    MANDATORY: 'N',
    SHOW_IN_LIST: 'Y',
    EDIT_IN_LIST: 'Y',
    IS_SEARCHABLE: d.userType === 'integer' || d.userType === 'enumeration' ? 'Y' : 'N',
  };
  if (d.list) fields.LIST = d.list.map((VALUE) => ({ VALUE }));

  const id: any = await callCrm('crm.deal.userfield.add', { fields }, AUTH);
  const created: any[] = await callCrm('crm.deal.userfield.list', { filter: { ID: id } }, AUTH);
  const code = created?.[0]?.FIELD_NAME ?? null;
  return code;
}

async function main() {
  const all: any[] = await callCrm('crm.deal.userfield.list', {}, AUTH);
  const existentes = new Map<string, string>(); // XML_ID -> FIELD_NAME
  for (const f of all) if (f.XML_ID) existentes.set(String(f.XML_ID), String(f.FIELD_NAME));

  console.log(`Total campos UF del Deal: ${all.length}\n`);
  const resultado: { campo: string; code: string; env: string; estado: string }[] = [];

  for (const d of DESIRED) {
    const ya = existentes.get(d.xmlId);
    if (ya) {
      resultado.push({ campo: d.fieldName, code: ya, env: ENV_VAR[d.fieldName], estado: 'ya existía' });
      continue;
    }
    try {
      const code = await crear(d);
      resultado.push({ campo: d.fieldName, code: code ?? '(desconocido)', env: ENV_VAR[d.fieldName], estado: '✅ creado' });
    } catch (e) {
      resultado.push({ campo: d.fieldName, code: '—', env: ENV_VAR[d.fieldName], estado: `❌ ${String(e)}` });
    }
  }

  console.log('Resultado:');
  for (const r of resultado) console.log(`  ${r.estado.padEnd(12)} ${r.campo}  →  ${r.code}   (${r.env})`);

  console.log('\nAgrega a Railway (env) las variables con el CÓDIGO real de cada campo:');
  for (const r of resultado) if (r.code && r.code !== '—') console.log(`  ${r.env}=${r.code}`);
  console.log('\nNota: el SCORE ya existe (BITRIX_UF_SCORE del módulo de scoring); no se recrea aquí.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
