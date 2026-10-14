import { test } from 'node:test';
import assert from 'node:assert/strict';

// Qué enlace de pago sale para cada programa y forma de pago.
//
// Carver tiene seis enlaces de PayPal de IMPORTE FIJO. El riesgo no es técnico: si sale el
// equivocado, la persona paga una cifra que no le corresponde. Por eso el monto lo calcula el código
// desde la planilla validada y el enlace solo sale si COINCIDE EXACTAMENTE; cuando no hay
// coincidencia se entrega el portal de Flywire, que no lleva importe, en vez de aproximar.
process.env.MARCA = 'carver';
process.env.NODE_ENV = 'test';
process.env.REDIS_URL = '';

const { enlaceDePago } = await import('../src/core/mediosPago');

const PORTAL = 'https://carver.university/es/portal-de-pagos/';

test('la matrícula son USD 50 en cualquier programa, y tiene enlace de PayPal', () => {
  for (const p of ['Maestría en Psicología', 'Licenciatura en Psicología', 'Maestría en Inteligencia Artificial']) {
    const r: any = enlaceDePago(p, 'matricula');
    assert.equal(r.ok, true, p);
    assert.equal(r.montoUsd, 50, p);
    assert.equal(r.medio, 'paypal', p);
    assert.match(r.url, /^https:\/\/www\.paypal\.com\/ncp\/payment\//);
    assert.match(r.avisoComision, /comisión/i, 'la comisión se avisa siempre');
  }
});

test('la cuota mensual distingue licenciatura (100) de maestría (150)', () => {
  const lic: any = enlaceDePago('Licenciatura en Ingeniería Informática', 'cuota_mensual');
  assert.equal(lic.montoUsd, 100);
  assert.equal(lic.medio, 'paypal');

  const mae: any = enlaceDePago('Maestría en Neurodivergencia', 'cuota_mensual');
  assert.equal(mae.montoUsd, 150);
  assert.equal(mae.medio, 'paypal');

  assert.notEqual(lic.url, mae.url, 'no pueden compartir enlace: son montos distintos');
});

test('EL CASO DE PEDRO: el contado del MBA son USD 1.123 y NO tiene enlace de PayPal', () => {
  // Es el caso que destapó el problema. El enlace más parecido es "contado USD 900", que es el de
  // las otras doce maestrías: mandarlo habría cobrado 223 dólares de menos.
  const r: any = enlaceDePago('Maestría en Administración de Empresas MBA', 'pago_contado');
  assert.equal(r.ok, true);
  assert.equal(r.montoUsd, 1123);
  assert.equal(r.medio, 'flywire', 'sin coincidencia exacta se va a Flywire');
  assert.equal(r.url, PORTAL);
  assert.equal(r.avisoComision, undefined, 'Flywire no cobra comisión de PayPal');
  assert.match(r.nota, /NO ofrezcas PayPal/, 'y se le prohíbe prometer otro enlace');
});

test('el contado de las otras maestrías sí son USD 900 y sí tiene enlace', () => {
  const r: any = enlaceDePago('Maestría en Administración Pública', 'pago_contado');
  assert.equal(r.montoUsd, 900);
  assert.equal(r.medio, 'paypal');
});

test('los pagos semestrales no tienen enlace de PayPal: ninguno de los seis los cubre', () => {
  // 410 (licenciatura), 630 (maestría) y 786 (MBA) no están entre los seis importes.
  for (const [p, monto] of [
    ['Licenciatura en Psicología', 410],
    ['Maestría en Psicología', 630],
    ['Maestría en Administración de Empresas MBA', 786],
  ] as const) {
    const r: any = enlaceDePago(p, 'pago_semestral');
    assert.equal(r.montoUsd, monto, p);
    assert.equal(r.medio, 'flywire', p);
  }
});

test('ningún enlace de PayPal sale con un monto que no sea el suyo', () => {
  // La red de seguridad de todo esto: sea cual sea el programa y el concepto, si el medio es PayPal
  // el importe tiene que ser uno de los seis que existen.
  const DISPONIBLES = new Set([50, 100, 150, 585, 900]);
  const programas = [
    'Licenciatura en Psicología',
    'Licenciatura en Ingeniería Informática',
    'Licenciatura en Administración de Empresas',
    'Maestría en Psicología',
    'Maestría en Administración de Empresas MBA',
    'Maestría en Inteligencia Artificial',
    'Maestría en Salud Mental',
  ];
  const conceptos = ['matricula', 'abono_inicial', 'cuota_mensual', 'pago_semestral', 'pago_contado'] as const;
  let paypal = 0;
  for (const p of programas) {
    for (const c of conceptos) {
      const r: any = enlaceDePago(p, c);
      if (!r.ok) continue;
      if (r.medio === 'paypal') {
        paypal++;
        assert.ok(DISPONIBLES.has(r.montoUsd), `${p} / ${c}: PayPal por USD ${r.montoUsd}, que no existe`);
      } else {
        assert.equal(r.url, PORTAL, `${p} / ${c}`);
      }
    }
  }
  assert.ok(paypal > 0, 'alguno tiene que resolver a PayPal, si no la prueba no prueba nada');
});

test('el contado anual de una licenciatura son USD 585, no el total de los 4 años', () => {
  // El total es USD 2.340 y no tiene enlace; lo que se paga de una vez es el año: USD 585.
  const r: any = enlaceDePago('Licenciatura en Psicología', 'pago_contado');
  assert.equal(r.montoUsd, 585);
  assert.equal(r.medio, 'paypal');
});

test('la matrícula NO se cobra en contado ni semestral, así que no se entrega enlace', () => {
  // Es el error caro al revés: cobrar una matrícula que esa forma de pago no lleva.
  const r: any = enlaceDePago('Maestría en Psicología', 'matricula');
  assert.equal(r.ok, true, 'sí existe en mensualidades');
  assert.equal(r.montoUsd, 50);
});

test('un programa que no existe, o ambiguo, no entrega ningún enlace', () => {
  const noExiste: any = enlaceDePago('Doctorado en Astrofísica', 'matricula');
  assert.equal(noExiste.ok, false);
  assert.equal(noExiste.motivo, 'programa_no_encontrado');

  const vacio: any = enlaceDePago('', 'matricula');
  assert.equal(vacio.ok, false);

  const ambiguo: any = enlaceDePago('Maestría', 'pago_contado');
  assert.equal(ambiguo.ok, false, 'hay 13 maestrías: no se elige una');
  assert.equal(ambiguo.motivo, 'programa_ambiguo');
  assert.ok((ambiguo.opciones?.length ?? 0) > 1);
});

test('un curso de educación continua no entra por acá', () => {
  const r: any = enlaceDePago('Hacking ético', 'matricula');
  assert.equal(r.ok, false, 'no se cotiza ni se cobra por este canal');
});
