import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';
import { config } from '../config';
import { marca } from '../marca';
import { log } from '../log';
import { callBitrix } from '../bitrix/client';
import {
  SECCIONES,
  esSeccion,
  refrescarAjustes,
  vigente,
  seccionesDisponibles,
  ajustesProgramas,
  conAjustesDePrueba,
  type NombreSeccion,
  type Horarios,
} from '../core/ajustes';
import { programasBase, precioACondicion, motivoEnlaceInvalido, type AjustesPrecios } from '../core/ajustesProgramas';
import { vistaSemanal } from '../core/horarioAsesores';
import { BECA_CARVER, type ProgramaCarver } from '../core/condicionesCarver';
import { elegirMedio, type Concepto } from '../core/mediosPago';
import { verificarEnlace, archivoCorrespondeAPrograma } from '../core/brochures';
import { ESQUEMA_CONOCIMIENTO, aplicarAjustesAConocimiento, type AjustesConocimiento } from '../core/ajustesConocimiento';
import { BASE_CONOCIMIENTO, consultarInformacionInstitucional } from '../core/conocimientoComercial';
import {
  dbConfigPublicadas,
  dbConfigSeccion,
  dbConfigVersion,
  dbConfigGuardarBorrador,
  dbConfigDescartarBorrador,
  dbConfigPublicar,
  dbInsertAudit,
  type ResultadoConfig,
} from '../store/db';
import { editoresPanel, esEditor, firmarSesion, type Editor } from './panelSesion';
import { escaparHtml } from '../util/html';

/**
 * Panel de configuración del bot: lo abren dentro de Bitrix24 personas que no programan, para cambiar
 * el comportamiento del bot sin pasar por código ni por Railway. Qué se edita está en core/ajustes.ts;
 * acá está quién puede y cómo: entrar con su usuario de Bitrix, editar un borrador, probarlo y
 * publicarlo, con historial.
 */

const PANEL_HTML = readFileSync(fileURLToPath(new URL('../../public/panel/index.html', import.meta.url)), 'utf8');
const VERSION_ASSETS = String(Date.now());

function paginaAviso(mensaje: string): string {
  return (
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Configuración del bot</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;color:#1f2937;line-height:1.5">` +
    `<h1 style="font-size:1.25rem">Configuración del bot</h1><p>${escaparHtml(mensaje)}</p></body></html>`
  );
}

/**
 * La página. Bitrix24 la abre por POST con el token del usuario que hizo clic (AUTH_ID) y el portal en
 * ?DOMAIN=. Se valida el portal ANTES de llamar a nada: si no, alguien podría mandar su propio portal y
 * un token suyo, y user.current respondería lo que él quisiera.
 */
export async function panelPagina(req: Request, res: Response) {
  if (!editoresPanel().length) return res.status(404).send(paginaAviso('No encontrado.'));
  const cuerpo: any = req.body ?? {};
  const token = typeof cuerpo.AUTH_ID === 'string' ? cuerpo.AUTH_ID : '';
  const dominioCrudo = req.query.DOMAIN ?? cuerpo.DOMAIN;
  const dominio = typeof dominioCrudo === 'string' ? dominioCrudo.trim().toLowerCase() : '';

  if (!token) {
    return res.status(401).send(paginaAviso('Abre este panel desde Bitrix24: es ahí donde se verifica quién eres.'));
  }
  if (!config.bitrixPortalDomain || dominio !== config.bitrixPortalDomain) {
    log.warn('panel: portal no autorizado', { dominio });
    return res.status(403).send(paginaAviso('Portal no autorizado.'));
  }

  let usuario: any;
  try {
    // Sin refresh_token a propósito: si el token del usuario venciera, callBitrix lo renovaría y lo
    // GUARDARÍA como el token del app, y el bot quedaría operando con las credenciales de quien abrió
    // el panel. Un token vencido acá solo significa "vuelve a abrir la pestaña".
    usuario = await callBitrix('user.current', {}, { domain: dominio, access_token: token });
  } catch (e) {
    const err = String(e);
    log.warn('panel: no se pudo verificar al usuario con Bitrix', { err: err.slice(0, 200) });
    if (/user_access_error/.test(err)) {
      return res.status(403).send(
        paginaAviso('Tu usuario no tiene acceso a la aplicación del bot en Bitrix24. Pide a un administrador del portal que te lo habilite.'),
      );
    }
    if (/expired_token|invalid_token/.test(err)) {
      return res.status(401).send(paginaAviso('Tu sesión de Bitrix24 venció. Cierra y vuelve a abrir esta pestaña.'));
    }
    return res.status(502).send(paginaAviso('No pudimos verificar tu usuario con Bitrix24. Intenta de nuevo en unos minutos.'));
  }

  const id = Number(usuario?.ID);
  const nombre = `${usuario?.NAME ?? ''} ${usuario?.LAST_NAME ?? ''}`.trim() || `Usuario ${id}`;
  if (!esEditor(id)) {
    log.info('panel: usuario sin permiso de edición', { id });
    return res.status(403).send(
      paginaAviso(`${nombre}, tu usuario no está habilitado para editar la configuración del bot. Si lo necesitas, pídele acceso a quien administra el bot.`),
    );
  }
  const sesion = firmarSesion({ id, nombre });
  if (!sesion) {
    log.error('panel: sin clave para firmar sesiones (PANEL_SECRETO, TOKEN_ENC_KEY o ADMIN_TOKEN)');
    return res.status(503).send(paginaAviso('El panel no está configurado todavía. Avísale a quien administra el bot.'));
  }

  log.info('panel: ingreso', { id });
  const html = PANEL_HTML.replaceAll('{{SESION}}', escaparHtml(sesion))
    .replaceAll('{{EDITOR}}', escaparHtml(nombre))
    .replaceAll('{{ORGANIZACION}}', escaparHtml(marca.etiquetaPanel))
    .replaceAll('{{SECCIONES}}', escaparHtml(seccionesDisponibles().join(',')))
    .replaceAll('{{V}}', VERSION_ASSETS);
  res.set('Content-Type', 'text/html; charset=utf-8');
  // Que nadie cachee una página que lleva una credencial adentro.
  res.set('Cache-Control', 'no-store');
  return res.send(html);
}

const MENSAJES: Record<Exclude<ResultadoConfig, { ok: true }>['motivo'], [number, string]> = {
  sin_db: [503, 'La base de datos no está disponible en este momento. Intenta de nuevo en unos minutos; el bot sigue funcionando con la configuración publicada.'],
  conflicto: [409, 'Otra persona cambió esta sección mientras la editabas. Recarga para ver la última versión antes de seguir.'],
  sin_borrador: [409, 'No hay un borrador para publicar. Guarda tus cambios primero.'],
  no_existe: [404, 'Esa versión no existe.'],
};

function responderFallo(res: Response, r: Exclude<ResultadoConfig, { ok: true }>) {
  const [status, error] = MENSAJES[r.motivo];
  return res.status(status).json({ ok: false, motivo: r.motivo, error });
}

function seccionDe(req: Request, res: Response): NombreSeccion | null {
  const s = req.params.seccion;
  if (esSeccion(s)) return s;
  res.status(404).json({ ok: false, error: 'Esa sección no existe.' });
  return null;
}

const idDe = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function estadoSeccion(seccion: NombreSeccion) {
  const datos = await dbConfigSeccion(seccion);
  return {
    ok: true,
    seccion,
    titulo: SECCIONES[seccion].titulo,
    // Lo que el bot usa ahora mismo, y el valor de fábrica (Railway) por si se quiere volver a él.
    vigente: vigente(seccion),
    porDefecto: SECCIONES[seccion].porDefecto(),
    esquema: (SECCIONES[seccion] as { esquema?: () => unknown }).esquema?.() ?? null,
    baseDisponible: datos !== null,
    publicada: datos?.publicada ?? null,
    borrador: datos?.borrador ?? null,
    historial: datos?.historial ?? [],
  };
}

/** GET /panel/api/seccion/:seccion */
export async function panelLeerSeccion(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  return res.json({ ...(await estadoSeccion(seccion)), editor: res.locals.editor as Editor });
}

/** PUT /panel/api/seccion/:seccion/borrador { contenido, borradorId } */
export async function panelGuardarBorrador(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const v = SECCIONES[seccion].validar(req.body?.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores, error: 'Hay datos que corregir antes de guardar.' });
  const r = await dbConfigGuardarBorrador(seccion, v.valor, res.locals.editor as Editor, idDe(req.body?.borradorId));
  if (!r.ok) return responderFallo(res, r);
  return res.json(await estadoSeccion(seccion));
}

/** DELETE /panel/api/seccion/:seccion/borrador/:id */
export async function panelDescartarBorrador(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const id = idDe(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'Falta el borrador a descartar.' });
  const r = await dbConfigDescartarBorrador(seccion, id);
  if (!r.ok) return responderFallo(res, r);
  return res.json(await estadoSeccion(seccion));
}

/** POST /panel/api/seccion/:seccion/publicar { borradorId, nota } */
export async function panelPublicar(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const borradorId = idDe(req.body?.borradorId);
  if (!borradorId) return res.status(400).json({ ok: false, error: 'Falta el borrador a publicar.' });
  const nota = String(req.body?.nota ?? '').trim().slice(0, 300);

  // Se vuelve a validar lo que está guardado, no lo que diga la página: las reglas pueden haber
  // cambiado desde que se guardó el borrador, y lo publicado es lo que el bot va a obedecer.
  const datos = await dbConfigSeccion(seccion);
  if (!datos) return responderFallo(res, { ok: false, motivo: 'sin_db' });
  if (!datos.borrador) return responderFallo(res, { ok: false, motivo: 'sin_borrador' });
  if (datos.borrador.id !== borradorId) return responderFallo(res, { ok: false, motivo: 'conflicto' });
  const v = SECCIONES[seccion].validar(datos.borrador.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores, error: 'El borrador tiene datos que corregir antes de publicar.' });

  const editor = res.locals.editor as Editor;
  const r = await dbConfigPublicar(seccion, borradorId, nota, editor);
  if (!r.ok) return responderFallo(res, r);
  await refrescarAjustes(dbConfigPublicadas); // el bot de esta instancia lo toma ya, sin esperar el próximo refresco
  void dbInsertAudit({ type: 'config_publicada', detail: { seccion, versionId: r.version.id, editorId: editor.id, editor: editor.nombre, nota } });
  log.info('panel: configuración publicada', { seccion, versionId: r.version.id, editorId: editor.id });
  return res.json(await estadoSeccion(seccion));
}

/** POST /panel/api/seccion/:seccion/restaurar { versionId, borradorId } — copia una versión anterior
 *  al borrador. No publica: se revisa y se publica como cualquier otro cambio. */
export async function panelRestaurar(req: Request, res: Response) {
  const seccion = seccionDe(req, res);
  if (!seccion) return;
  const versionId = idDe(req.body?.versionId);
  if (!versionId) return res.status(400).json({ ok: false, error: 'Falta la versión a restaurar.' });
  const version = await dbConfigVersion(seccion, versionId);
  if (!version) return responderFallo(res, { ok: false, motivo: 'no_existe' });
  const v = SECCIONES[seccion].validar({ ...(SECCIONES[seccion].porDefecto() as object), ...(version.contenido as object) });
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores, error: 'Esa versión ya no cumple las reglas actuales y no se puede restaurar tal cual.' });
  const r = await dbConfigGuardarBorrador(seccion, v.valor, res.locals.editor as Editor, idDe(req.body?.borradorId));
  if (!r.ok) return responderFallo(res, r);
  return res.json(await estadoSeccion(seccion));
}

/** POST /panel/api/seccion/horarios/vista { contenido } — cómo se vería la semana con esos horarios. */
export async function panelVistaHorarios(req: Request, res: Response) {
  const v = SECCIONES.horarios.validar(req.body?.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores });
  return res.json({ ok: true, dias: vistaSemanal(v.valor as Horarios) });
}

const usd = (n: number) => `USD ${n.toLocaleString('es-CL', { maximumFractionDigits: 2 })}`;

// Los mismos conceptos que cobra el bot con enlace (core/mediosPago.ts). El abono inicial queda fuera:
// tiene el mismo importe que la matrícula, así que mostrarlo repetiría la misma fila.
const CONCEPTOS: Array<[Concepto, string]> = [
  ['matricula', 'Matrícula'],
  ['cuota_mensual', 'Cuota mensual'],
  ['pago_semestral', 'Pago semestral'],
  ['pago_contado', 'Pago al contado'],
];

/**
 * POST /panel/api/seccion/precios/vista { contenido } — cómo cotizaría el bot cada programa con esos
 * precios, y con qué medio se pagaría cada monto. Lo segundo es lo que más importa al cambiar un
 * precio: los enlaces de PayPal son de importe fijo, así que un monto nuevo sin enlace pasa a Flywire.
 */
export async function panelVistaPrecios(req: Request, res: Response) {
  const v = SECCIONES.precios.validar(req.body?.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores });
  const disponibilidad = ajustesProgramas().programas;
  const programas: Record<string, { resumen: string[]; pagos: Array<{ concepto: Concepto; etiqueta: string; montoUsd: number; medio: string }> }> = {};
  for (const [slug, precio] of Object.entries((v.valor as AjustesPrecios).programas)) {
    const c = { nombre: precio.nombre, tipo: precio.tipo, cotizable: true, ...precioACondicion(precio) } as ProgramaCarver;
    const resumen: string[] = [];
    const prog = disponibilidad[slug];
    if (prog?.disponibilidad === 'cupos_completos') {
      resumen.push(`Tiene cupos completos: antes del precio, el bot avisa que la matrícula reabre en ${prog.reabre}.`);
    }
    resumen.push(`Arancel de lista ${usd(c.arancelLista!)}; con la ${BECA_CARVER} (${c.becaPct}%) queda en ${usd(c.arancelConBeca!)}.`);
    resumen.push(
      `En cuotas: ${c.mensualidades!.n} cuotas de ${usd(c.mensualidades!.monto)}, más matrícula de ${usd(c.matricula!)} (valor regular ${usd(c.matriculaRegular!)}).`,
    );
    resumen.push(`Semestral: ${c.semestral!.n} pagos de ${usd(c.semestral!.monto)} (total ${usd(c.semestral!.n * c.semestral!.monto)}), sin matrícula.`);
    resumen.push(
      c.contado!.anios
        ? `Al contado: ${usd(c.contado!.total)}, en ${c.contado!.anios} pagos anuales de ${usd(c.contado!.porAnio!)}, sin matrícula.`
        : `Al contado: ${usd(c.contado!.total)} en un solo pago, sin matrícula.`,
    );
    const pagos = CONCEPTOS.flatMap(([concepto, etiqueta]) => {
      const m = elegirMedio(c, concepto);
      return m ? [{ concepto, etiqueta, montoUsd: m.montoUsd, medio: m.medio }] : [];
    });
    programas[slug] = { resumen, pagos };
  }
  return res.json({ ok: true, programas });
}

const fechaEnPalabras = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// Por qué el bot no usaría un tema (core/conocimientoComercial.ts), dicho para quien lo edita.
const TEMA_NO_DISPONIBLE: Record<string, string> = {
  pendiente_de_validacion: 'Está desactivado: el bot dice que no tiene ese dato y ofrece confirmarlo.',
  sin_fuente: 'No tiene fuente: el bot no lo usa.',
  vencido: 'Venció: el bot no lo usa y ofrece confirmar el dato.',
  incompleto: 'No tiene filas completas: el bot no lo usa.',
  contradictorio: 'Tiene fechas contradictorias para un mismo ciclo: el bot no lo usa.',
  sin_definicion: 'No existe en la base: el bot no lo usa.',
};

/**
 * POST /panel/api/seccion/conocimiento/vista { contenido } — si el bot podrá usar cada tema con lo que
 * hay en pantalla, y si no, por qué. Pasa por la misma función que la herramienta del bot, así que un
 * tema vencido o sin fuente se ve acá antes de publicarlo.
 */
export async function panelVistaConocimiento(req: Request, res: Response) {
  const v = SECCIONES.conocimiento.validar(req.body?.contenido);
  if (!v.ok) return res.status(400).json({ ok: false, errores: v.errores });
  const base = aplicarAjustesAConocimiento(BASE_CONOCIMIENTO, v.valor as AjustesConocimiento);
  const temas: Record<string, { disponible: boolean; texto: string }> = {};
  for (const e of ESQUEMA_CONOCIMIENTO) {
    const r = consultarInformacionInstitucional(e.tema, {}, base);
    if (!r.ok) continue;
    if (!r.disponible) {
      temas[e.tema] = { disponible: false, texto: TEMA_NO_DISPONIBLE[r.motivo] ?? 'El bot no lo usa.' };
      continue;
    }
    const hasta = r.vigenteHasta ? ` Vigente hasta el ${fechaEnPalabras(r.vigenteHasta)}.` : '';
    if (e.tema === 'calendario_ingresos') {
      const proximo = r.contenido.map((x) => String(x.inicioClases)).sort()[0];
      temas[e.tema] = {
        disponible: true,
        texto: `El bot ofrece ${r.contenido.length === 1 ? '1 ciclo' : `${r.contenido.length} ciclos`}; el próximo inicio es el ${fechaEnPalabras(proximo)}.${hasta}`,
      };
    } else {
      temas[e.tema] = { disponible: true, texto: `El bot usa ${r.contenido.length === 1 ? '1 fila' : `${r.contenido.length} filas`}.${hasta}` };
    }
  }
  return res.json({ ok: true, temas });
}

// Cada mensaje de prueba usa el modelo real: un tope por persona evita que una pestaña olvidada o un
// error en la página se conviertan en gasto.
const TURNOS_SIMULADOR = 40;
const VENTANA_SIMULADOR_MS = 10 * 60_000;
const usoSimulador = new Map<number, number[]>();

/** Solo para pruebas: olvida los turnos usados. */
export function _reiniciarTopeSimulador(): void {
  usoSimulador.clear();
}

const mensajeValido = (m: any) =>
  m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content));

/**
 * POST /panel/api/simulador { historial, mensaje, conBorradores } — un turno del chat de prueba (ver
 * ai/simulador.ts). Con `conBorradores`, el bot usa los borradores guardados de cada sección en lugar de
 * lo publicado, solo para esta respuesta: así se prueba un cambio antes de que llegue a un cliente.
 */
export async function panelSimular(req: Request, res: Response) {
  const editor = res.locals.editor as Editor;
  const mensaje = String(req.body?.mensaje ?? '').trim();
  if (!mensaje) return res.status(400).json({ ok: false, error: 'Escribe un mensaje.' });
  if (mensaje.length > 1500) return res.status(400).json({ ok: false, error: 'El mensaje es demasiado largo (hasta 1500 letras).' });
  const historial = req.body?.historial ?? [];
  if (!Array.isArray(historial) || historial.length > 80 || !historial.every(mensajeValido)) {
    return res.status(400).json({ ok: false, error: 'La conversación de prueba no es válida. Empieza de nuevo.' });
  }

  const ahora = Date.now();
  const recientes = (usoSimulador.get(editor.id) ?? []).filter((t) => ahora - t < VENTANA_SIMULADOR_MS);
  if (recientes.length >= TURNOS_SIMULADOR) {
    return res.status(429).json({ ok: false, error: 'Llegaste al máximo de mensajes de prueba por ahora. Espera unos minutos y sigue.' });
  }
  usoSimulador.set(editor.id, [...recientes, ahora]);

  const valores: Partial<Record<NombreSeccion, unknown>> = {};
  const borradoresUsados: string[] = [];
  if (req.body?.conBorradores) {
    for (const s of seccionesDisponibles()) {
      const datos = await dbConfigSeccion(s);
      if (!datos?.borrador) continue;
      const v = SECCIONES[s].validar(datos.borrador.contenido);
      if (!v.ok) continue; // un borrador que ya no cumple las reglas no se prueba: rige lo publicado
      valores[s] = v.valor;
      borradoresUsados.push(SECCIONES[s].titulo);
    }
  }

  try {
    // Se carga recién acá: el simulador arrastra el motor del bot completo (herramientas, CRM), que el
    // resto del panel no necesita.
    const { simularTurno } = await import('../ai/simulador');
    const r = await conAjustesDePrueba(valores, () => simularTurno(historial, mensaje));
    log.info('panel: turno de prueba', { editorId: editor.id, borradores: borradoresUsados.length, herramientas: r.herramientas.length });
    return res.json({ ok: true, respuesta: r.texto, historial: r.historial, herramientas: r.herramientas, borradoresUsados });
  } catch (e) {
    log.warn('panel: el turno de prueba falló', { err: String(e).slice(0, 200) });
    return res.status(502).json({ ok: false, error: 'El bot no pudo responder en la prueba. Intenta de nuevo en un momento.' });
  }
}

const FALLAS_BROCHURE: Record<string, string> = {
  http_404: 'El enlace no existe (error 404). Revisa que esté bien copiado.',
  pdf_corrupto: 'El archivo dice ser un PDF, pero no se puede abrir.',
  no_es_pdf: 'El enlace no lleva a un PDF. El bot solo entrega brochures en PDF.',
  formato_desconocido: 'El enlace no lleva a un PDF. El bot solo entrega brochures en PDF.',
  timeout: 'El sitio tardó demasiado en responder. Intenta de nuevo en un momento.',
  error_red: 'No pudimos conectarnos con ese sitio.',
};

/**
 * POST /panel/api/brochure/verificar { programa, url } — la misma comprobación que hace el bot antes de
 * entregar un brochure (core/brochures.ts): que abra, que sea un PDF y que sea el de ese programa.
 * Así quien pega un enlace sabe en el momento si el bot lo va a poder usar.
 */
export async function panelVerificarBrochure(req: Request, res: Response) {
  const base = programasBase().find((b) => b.slug === String(req.body?.programa ?? ''));
  if (!base) return res.status(404).json({ ok: false, error: 'Ese programa no existe.' });
  const url = String(req.body?.url ?? '').trim();
  if (!url) return res.status(400).json({ ok: false, error: 'Pega el enlace del brochure.' });
  const motivo = motivoEnlaceInvalido(url);
  if (motivo) return res.status(400).json({ ok: false, error: motivo });

  const v = await verificarEnlace(url);
  if (!v.ok) {
    const mensaje = FALLAS_BROCHURE[v.motivo] ?? (v.motivo.startsWith('http_') ? `El sitio respondió con un error (${v.motivo.slice(5)}).` : 'No pudimos abrir el enlace.');
    return res.json({ ok: true, valido: false, mensaje });
  }
  if (v.formato === 'visor_pdf' && v.archivo && !archivoCorrespondeAPrograma(v.archivo, base.nombre)) {
    return res.json({ ok: true, valido: false, mensaje: `El enlace abre «${v.archivo}», que no parece ser el brochure de este programa. El bot no lo entregaría.` });
  }
  return res.json({
    ok: true,
    valido: true,
    mensaje: v.archivo ? `El enlace abre «${v.archivo}». El bot lo podrá entregar.` : 'El enlace abre un PDF. El bot lo podrá entregar.',
  });
}
