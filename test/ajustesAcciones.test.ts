import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Sección "Acciones" del panel de configuración (Carver): enlaces de PayPal y portal de Flywire. Lo
// importante: sin nada publicado se usan los del documento de la dirección, y un enlace publicado solo
// se entrega si su monto coincide EXACTO con lo que corresponde pagar.
process.env.MARCA = 'carver';
process.env.REDIS_URL = '';
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';

const aa = await import('../src/core/ajustesAcciones');
const { _fijarPublicadaParaPruebas, seccionesDisponibles } = await import('../src/core/ajustes');
const { enlaceDePago } = await import('../src/core/mediosPago');
const { consultarInformacionInstitucional, BASE_CONOCIMIENTO } = await import('../src/core/conocimientoComercial');
const { panelVistaAcciones } = await import('../src/routes/panelConfig');

const MBA = 'Maestría en Administración de Empresas MBA';
const PSICO = 'Maestría en Psicología';
const HOY = { hoy: new Date('2026-10-30T12:00:00Z') };

beforeEach(() => _fijarPublicadaParaPruebas('acciones', null));

const publicar = (contenido: unknown) => {
  const v = aa.validarAcciones(contenido);
  assert.ok(v.ok, `la versión de prueba debe ser válida: ${JSON.stringify(!v.ok && v.errores)}`);
  _fijarPublicadaParaPruebas('acciones', v.valor);
};
const errores = (x: unknown) => {
  const v = aa.validarAcciones(x);
  return v.ok ? [] : v.errores;
};
const conEnlaces = (enlaces: any[]) => ({ ...aa.accionesPorDefecto(), enlacesPayPal: enlaces });

test('los enlaces del documento de la dirección son los valores por defecto y pasan las reglas', () => {
  const d = aa.accionesPorDefecto();
  assert.equal(d.enlacesPayPal.length, 6);
  assert.ok(d.portalFlywire.startsWith('https://carver.university/'));
  assert.ok(aa.validarAcciones(d).ok);
  assert.ok(seccionesDisponibles().includes('acciones'));
});

test('sin publicar, los enlaces son los de siempre: PayPal con monto exacto, si no Flywire', () => {
  const cuota = enlaceDePago(PSICO, 'cuota_mensual');
  assert.ok(cuota.ok && cuota.medio === 'paypal' && cuota.montoUsd === 150);
  const contadoMba = enlaceDePago(MBA, 'pago_contado');
  assert.ok(contadoMba.ok && contadoMba.medio === 'flywire', 'no hay enlace por USD 1.123');
});

test('solo se aceptan dominios de PayPal y un portal de carver.university o Flywire', () => {
  const d = aa.accionesPorDefecto();
  assert.ok(errores({ ...d, portalFlywire: 'https://pagos-carver.com/' }).some((e) => e.campo === 'portalFlywire'));
  assert.ok(errores({ ...d, portalFlywire: 'https://carver.flywire.com/pay' }).length === 0);
  assert.ok(errores(conEnlaces([{ concepto: 'contado', montoUsd: 900, url: 'https://paypa1.com/pago' }])).some((e) => e.campo === 'enlacesPayPal.0.url'));
  assert.ok(errores(conEnlaces([{ concepto: 'contado', montoUsd: 900, url: 'http://www.paypal.com/ncp/payment/X' }])).some((e) => e.campo === 'enlacesPayPal.0.url'));
});

test('no puede haber dos enlaces para el mismo concepto y monto, ni montos inválidos', () => {
  const dup = errores(
    conEnlaces([
      { concepto: 'contado', montoUsd: 900, url: 'https://www.paypal.com/ncp/payment/A' },
      { concepto: 'contado', montoUsd: 900, url: 'https://www.paypal.com/ncp/payment/B' },
    ]),
  );
  assert.ok(dup.some((e) => e.campo === 'enlacesPayPal.1.montoUsd'));
  assert.ok(errores(conEnlaces([{ concepto: 'contado', montoUsd: 0, url: 'https://www.paypal.com/ncp/payment/A' }])).some((e) => e.campo === 'enlacesPayPal.0.montoUsd'));
  assert.ok(errores(conEnlaces([{ concepto: 'otro', montoUsd: 10, url: 'https://www.paypal.com/ncp/payment/A' }])).some((e) => e.campo === 'enlacesPayPal.0.concepto'));
});

test('un enlace nuevo publicado se entrega cuando el monto coincide', () => {
  const d = aa.accionesPorDefecto();
  publicar({ ...d, enlacesPayPal: [...d.enlacesPayPal, { concepto: 'contado', montoUsd: 1123, url: 'https://www.paypal.com/ncp/payment/CONTADO-MBA' }] });
  const r = enlaceDePago(MBA, 'pago_contado');
  assert.ok(r.ok && r.medio === 'paypal');
  assert.equal(r.ok && r.url, 'https://www.paypal.com/ncp/payment/CONTADO-MBA');
});

test('sin el enlace de un monto, ese pago pasa a Flywire', () => {
  const d = aa.accionesPorDefecto();
  publicar({ ...d, enlacesPayPal: d.enlacesPayPal.filter((e) => e.montoUsd !== 150) });
  const r = enlaceDePago(PSICO, 'cuota_mensual');
  assert.ok(r.ok && r.medio === 'flywire');
});

test('un portal nuevo llega al enlace de pago y también a la ficha de medios de pago', () => {
  publicar({ ...aa.accionesPorDefecto(), portalFlywire: 'https://carver.flywire.com/portal' });
  const r = enlaceDePago(MBA, 'pago_contado');
  assert.ok(r.ok && r.medio === 'flywire' && r.url === 'https://carver.flywire.com/portal');
  const ficha = consultarInformacionInstitucional('medios_de_pago', HOY);
  assert.ok(ficha.ok && ficha.disponible);
  assert.ok(ficha.contenido.some((e) => e.url === 'https://carver.flywire.com/portal'));
  const anterior = (BASE_CONOCIMIENTO.temas.medios_de_pago as any).portalFlywire;
  assert.ok(!ficha.contenido.some((e) => e.url === anterior), 'no queda el portal viejo');
});

test('la vista muestra qué recibe cada programa y qué enlace no usa nadie', async () => {
  const d = aa.accionesPorDefecto();
  const contenido = { ...d, enlacesPayPal: [...d.enlacesPayPal, { concepto: 'contado', montoUsd: 777, url: 'https://www.paypal.com/ncp/payment/NADIE' }] };
  const res: any = { statusCode: 200 };
  res.status = (c: number) => ((res.statusCode = c), res);
  res.json = (b: any) => ((res.cuerpo = b), res);
  await panelVistaAcciones({ body: { contenido } } as any, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cuerpo.programas.length, 16);
  const psico = res.cuerpo.programas.find((p: any) => p.nombre === PSICO);
  assert.deepEqual(psico.pagos.find((x: any) => x.etiqueta === 'Cuota mensual'), { etiqueta: 'Cuota mensual', montoUsd: 150, medio: 'paypal' });
  // Los seis del documento los usa algún programa; solo el de USD 777 no le corresponde a nadie.
  assert.deepEqual(res.cuerpo.enlacesSinUso, [contenido.enlacesPayPal.length - 1]);
});
