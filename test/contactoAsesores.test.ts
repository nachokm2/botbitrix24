import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Contacto de cada asesor entregado por la coordinación de Carver (02-11-2026): WhatsApp, correo
// institucional y formulario de postulación. En Bitrix, cinco de los siete asesores tienen un Gmail
// personal como correo de la cuenta y los móviles están viejos: lo entregado manda sobre la ficha.
// Los ids y departamentos imitan los reales; los números y correos son sintéticos.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';
process.env.BITRIX_EMBUDOS_PROPIOS = '73,135';
process.env.ASESORES_CONTACTO = JSON.stringify([
  { id: 685357, whatsapp: '56 9 1111 2222', email: 'Asesora.Uno@Carver.University', formulario: 'https://carver.university/lp/forms/form-carver-uno/' },
  // Un "número" que no es número y un Gmail: se descartan esos dos, no el formulario.
  { id: 742023, whatsapp: 'no tiene', email: 'asesora.dos@gmail.com', formulario: 'https://b24-x.bitrix24.site/crm_form_abc/' },
]);

const usuarios: Record<number, any> = {
  685357: { NAME: 'Asesora', LAST_NAME: 'Uno', EMAIL: 'asesora.uno.personal@gmail.com', PERSONAL_MOBILE: '+56900000000', ACTIVE: true, UF_DEPARTMENT: [511] },
  742023: { NAME: 'Asesora', LAST_NAME: 'Dos', EMAIL: 'asesora.dos@carver.university', ACTIVE: true, UF_DEPARTMENT: [511] },
  166867: { NAME: 'Asesora', LAST_NAME: 'Tres', EMAIL: 'asesora.tres@gmail.com', PERSONAL_MOBILE: '+56900000001', ACTIVE: true, UF_DEPARTMENT: [193] },
};
const deals: Record<number, any> = {
  1: { CATEGORY_ID: '135', ASSIGNED_BY_ID: '685357' },
  3: { CATEGORY_ID: '135', ASSIGNED_BY_ID: '166867' },
};
async function crm(method: string, params: any) {
  if (method === 'user.get') return [usuarios[params.ID]].filter(Boolean);
  if (method === 'crm.deal.get') return deals[params.id] ?? {};
  return {};
}
mock.module('../src/bitrix/client.ts', {
  namedExports: {
    callBitrix: crm,
    callCrm: crm,
    callBitrixEnvelope: async () => ({ result: {} }),
    callCrmEnvelope: async () => ({ result: [], total: 0, next: null }),
    callWebhook: async () => ({}),
  },
});

const { leerContactoAsesores } = await import('../src/crm/contactoAsesores');
const { getUsuarios, getIdentidadAsesor } = await import('../src/crm/directory');
const { bloqueIdentidad, aplicarGuardian } = await import('../src/ai/agentLoop');
const auth = { domain: 'test.bitrix24.com', access_token: 'tok' } as any;

test('la lista se lee con el número en formato internacional y el correo en minúsculas', () => {
  const t = leerContactoAsesores(process.env.ASESORES_CONTACTO!);
  assert.deepEqual(t.get(685357), {
    whatsapp: '+56911112222',
    email: 'asesora.uno@carver.university',
    formulario: 'https://carver.university/lp/forms/form-carver-uno/',
  });
});

test('un dato inválido se descarta solo, sin arrastrar a los demás del mismo asesor', () => {
  const t = leerContactoAsesores(process.env.ASESORES_CONTACTO!);
  // Ni el "número" que no es número, ni un correo fuera del dominio institucional.
  assert.deepEqual(t.get(742023), { formulario: 'https://b24-x.bitrix24.site/crm_form_abc/' });
  assert.equal(leerContactoAsesores('[{"id":1,"formulario":"http://inseguro.com"}]').get(1)?.formulario, undefined, 'solo https');
});

test('una variable mal escrita no rompe nada: queda vacía', () => {
  assert.equal(leerContactoAsesores('{no es json').size, 0);
  assert.equal(leerContactoAsesores('{"id":1}').size, 0, 'tiene que ser una lista');
  assert.equal(leerContactoAsesores('').size, 0);
  assert.equal(leerContactoAsesores('[{"whatsapp":"+56911112222"}]').size, 0, 'sin id no hay a quién asignarlo');
});

test('getUsuarios: lo entregado manda sobre el Gmail y el móvil viejo de la ficha', async () => {
  const [u] = await getUsuarios([685357], auth);
  assert.equal(u.email, 'asesora.uno@carver.university');
  assert.equal(u.telefono, '+56911112222');
  assert.equal(u.formulario, 'https://carver.university/lp/forms/form-carver-uno/');
});

test('getUsuarios: sin dato entregado, queda lo de la ficha y el móvil de Bitrix sigue cortado', async () => {
  const [dos] = await getUsuarios([742023], auth);
  assert.equal(dos.email, 'asesora.dos@carver.university', 'el correo rechazado no reemplaza al de la ficha');
  assert.equal(dos.telefono, undefined);
  const [tres] = await getUsuarios([166867], auth);
  assert.equal(tres.telefono, undefined, 'un asesor fuera de la lista no entrega su PERSONAL_MOBILE');
  assert.equal(tres.formulario, undefined);
});

test('la identidad del turno trae el WhatsApp, el correo y el formulario del asesor', async () => {
  const id = await getIdentidadAsesor({ deal: 1 }, auth);
  assert.deepEqual(id, {
    nombre: 'Asesora Uno',
    email: 'asesora.uno@carver.university',
    telefono: '+56911112222',
    formulario: 'https://carver.university/lp/forms/form-carver-uno/',
  });
  const sinLista = await getIdentidadAsesor({ deal: 3 }, auth);
  assert.equal(sinLista?.formulario, undefined);
});

test('el bloque de identidad ofrece el formulario junto a la ficha en el chat', () => {
  const b = bloqueIdentidad({ nombre: 'Asesora Uno', formulario: 'https://carver.university/lp/forms/form-carver-uno/' }, true);
  assert.match(b, /Tu formulario de postulación es https:\/\/carver\.university\/lp\/forms\/form-carver-uno\//);
  assert.match(b, /las dos vías/);
  assert.doesNotMatch(bloqueIdentidad({ nombre: 'Asesora Tres' }, true), /formulario/, 'sin formulario no se menciona');
});

test('el guardián deja pasar el formulario del asesor, y solo ese', async () => {
  const form = 'https://carver.university/lp/forms/form-carver-uno/';
  const ajeno = 'https://carver.university/lp/forms/form-carver-otro/';
  const t = { mensajeCliente: 'quiero postular', history: [], mensajesDelTurno: [], simulacion: true, urlsDelAsesor: [form] };
  assert.match(await aplicarGuardian(`Perfecto. Puede completar su postulación aquí:\n${form}\n\n¿Le ayudo con algo más?`, t), /form-carver-uno/);
  assert.doesNotMatch(await aplicarGuardian(`Perfecto. Puede completar su postulación aquí:\n${ajeno}\n\n¿Le ayudo con algo más?`, t), /form-carver-otro/);
});
