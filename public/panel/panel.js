'use strict';

// Panel de configuración del bot — sección Horarios.
// Todo lo que viene de personas (nombres, notas, feriados) se inserta como TEXTO, nunca como HTML.
(() => {
  const SESION = document.querySelector('meta[name="panel-sesion"]')?.content ?? '';
  const SECCION = 'horarios';
  const TZ = 'America/Santiago';
  // Lunes primero, como se lee una semana de trabajo; el valor es el de JavaScript (0 = domingo).
  const DIAS = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];

  const $ = (id) => document.getElementById(id);
  let datos = null; // lo que devolvió el servidor
  let feriados = []; // feriados en pantalla
  let sucio = false; // hay cambios en pantalla sin guardar
  let ocupado = false;
  let temporizadorVista = null;

  function el(tag, props = {}, ...hijos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const h of hijos.flat()) if (h != null && h !== false) n.append(h instanceof Node ? h : document.createTextNode(String(h)));
    return n;
  }

  const hoyEnChile = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  // Mayúscula solo en la primera letra ("Lunes, 2 de noviembre"); en CSS, capitalize la ponía en cada palabra.
  const inicial = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const fechaLarga = (iso) => inicial(new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
  const fechaCorta = (iso) => inicial(new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }));
  const fechaHora = (iso) => new Date(iso).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ });

  // ── Comunicación con el servidor ────────────────────────────────────────────────────────────
  async function api(metodo, ruta, cuerpo) {
    const r = await fetch(`/panel/api/seccion/${SECCION}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${SESION}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    let j = {};
    try {
      j = await r.json();
    } catch {
      j = { ok: false, error: 'El servidor respondió algo inesperado. Intenta de nuevo.' };
    }
    if (r.status === 401) {
      bloquear(j.error || 'Tu sesión venció. Vuelve a abrir el panel desde Bitrix24.');
      throw new Error('sesion');
    }
    return { status: r.status, ...j };
  }

  async function conEspera(fn) {
    if (ocupado) return;
    ocupado = true;
    actualizarBotones();
    try {
      return await fn();
    } catch (e) {
      if (e?.message !== 'sesion') mostrarError('No pudimos comunicarnos con el servidor. Revisa tu conexión e intenta de nuevo.');
    } finally {
      ocupado = false;
      actualizarBotones();
    }
  }

  // ── Formulario ──────────────────────────────────────────────────────────────────────────────
  function construirControles() {
    const dias = $('dias');
    for (const [valor, nombre] of DIAS) {
      dias.append(el('label', {}, el('input', { type: 'checkbox', value: valor, name: 'asesoresDias' }), nombre));
    }
    for (const id of ['automaticosHoraInicio', 'automaticosHoraFin']) {
      const sel = $(id);
      for (let h = 0; h <= 24; h++) sel.append(el('option', { value: h, text: h === 24 ? '24:00 (medianoche)' : `${h}:00` }));
    }
  }

  const numero = (v) => (v === '' ? null : Number(v));

  function leerFormulario() {
    return {
      asesoresActivo: $('asesoresActivo').checked,
      asesoresDias: [...document.querySelectorAll('#dias input:checked')].map((i) => Number(i.value)),
      asesoresInicio: $('asesoresInicio').value,
      asesoresFin: $('asesoresFin').value,
      feriados: feriados.map((f) => ({ fecha: f.fecha, nombre: f.nombre })),
      ritmoMinS: numero($('ritmoMinS').value),
      ritmoMaxS: numero($('ritmoMaxS').value),
      automaticosHoraInicio: Number($('automaticosHoraInicio').value),
      automaticosHoraFin: Number($('automaticosHoraFin').value),
    };
  }

  function escribirFormulario(h) {
    $('asesoresActivo').checked = Boolean(h.asesoresActivo);
    for (const i of document.querySelectorAll('#dias input')) i.checked = h.asesoresDias.includes(Number(i.value));
    // Un <input type="time"> no admite 24:00: se muestra como 23:59, que en la práctica es lo mismo.
    $('asesoresInicio').value = h.asesoresInicio === '24:00' ? '23:59' : h.asesoresInicio;
    $('asesoresFin').value = h.asesoresFin === '24:00' ? '23:59' : h.asesoresFin;
    feriados = (h.feriados ?? []).map((f) => ({ fecha: f.fecha, nombre: f.nombre ?? '' }));
    $('ritmoMinS').value = h.ritmoMinS;
    $('ritmoMaxS').value = h.ritmoMaxS;
    $('automaticosHoraInicio').value = String(h.automaticosHoraInicio);
    $('automaticosHoraFin').value = String(h.automaticosHoraFin);
    renderFeriados();
    actualizarActivo();
  }

  function actualizarActivo() {
    const activo = $('asesoresActivo').checked;
    $('grupo-asesores').disabled = !activo;
    $('nota-inactivo').hidden = activo;
  }

  function cambio() {
    sucio = true;
    limpiarMensajes();
    actualizarBotones();
    programarVista();
  }

  // ── Feriados ────────────────────────────────────────────────────────────────────────────────
  function renderFeriados() {
    const ul = $('lista-feriados');
    ul.replaceChildren();
    if (!feriados.length) {
      ul.append(el('li', { class: 'vacio', text: 'No hay feriados cargados.' }));
      return;
    }
    feriados.sort((a, b) => a.fecha.localeCompare(b.fecha));
    const hoy = hoyEnChile();
    for (const f of feriados) {
      ul.append(
        el(
          'li',
          {},
          el('span', {}, el('strong', { text: fechaLarga(f.fecha) }), f.nombre ? ` — ${f.nombre}` : '', f.fecha < hoy ? ' (ya pasó)' : ''),
          el('button', {
            type: 'button',
            class: 'quitar',
            'aria-label': `Quitar el feriado del ${fechaLarga(f.fecha)}`,
            text: 'Quitar',
            onclick: () => {
              feriados = feriados.filter((x) => x !== f);
              renderFeriados();
              cambio();
            },
          }),
        ),
      );
    }
  }

  function agregarFeriado() {
    const fecha = $('nuevo-feriado-fecha').value;
    const nombre = $('nuevo-feriado-nombre').value.trim();
    const error = document.querySelector('[data-campo="feriados"]');
    if (!fecha) {
      error.textContent = 'Elige la fecha del feriado.';
      $('nuevo-feriado-fecha').focus();
      return;
    }
    if (feriados.some((f) => f.fecha === fecha)) {
      error.textContent = 'Esa fecha ya está en la lista.';
      return;
    }
    feriados.push({ fecha, nombre });
    $('nuevo-feriado-fecha').value = '';
    $('nuevo-feriado-nombre').value = '';
    renderFeriados();
    cambio();
  }

  // ── Vista previa de la semana ───────────────────────────────────────────────────────────────
  function programarVista(ms = 350) {
    clearTimeout(temporizadorVista);
    temporizadorVista = setTimeout(actualizarVista, ms);
  }

  async function actualizarVista() {
    let r;
    try {
      r = await api('POST', '/vista', { contenido: leerFormulario() });
    } catch {
      return;
    }
    if (!r.ok) {
      mostrarErroresCampos(r.errores ?? []);
      $('vista').classList.add('desactualizada');
      return;
    }
    mostrarErroresCampos([]);
    renderVista(r.dias);
  }

  function renderVista(dias) {
    const ol = $('vista');
    ol.classList.remove('desactualizada');
    ol.replaceChildren();
    for (const d of dias) {
      let detalle;
      if (d.feriado) {
        detalle = [el('span', { class: 'etiqueta feriado', text: 'Feriado' }), `${d.feriado}: el bot atiende todo el día.`];
      } else if (d.asesores) {
        detalle = [
          el('span', { class: 'etiqueta asesores', text: `Asesores ${d.asesores.inicio}–${d.asesores.fin}` }),
          `El bot responde antes de las ${d.asesores.inicio} y desde las ${d.asesores.fin}.`,
        ];
      } else {
        detalle = [el('span', { class: 'etiqueta bot', text: 'Sin asesores' }), 'El bot atiende todo el día.'];
      }
      ol.append(el('li', {}, el('span', { class: 'dia', text: fechaCorta(d.fecha) }), el('span', {}, ...detalle)));
    }
  }

  // ── Qué cambió entre dos versiones (para el diálogo de publicar y el historial) ──────────────
  const nombresDias = (lista) =>
    DIAS.filter(([v]) => lista.includes(v))
      .map(([, n]) => n)
      .join(', ') || 'Ninguno';
  const hora = (h) => (h === 24 ? '24:00' : `${h}:00`);

  function diferencias(a, b) {
    const out = [];
    const comparar = (etiqueta, fa, fb) => {
      if (fa !== fb) out.push({ etiqueta, antes: fa, despues: fb });
    };
    comparar('Horario de asesores', a.asesoresActivo ? 'Activo' : 'Desactivado', b.asesoresActivo ? 'Activo' : 'Desactivado');
    comparar('Días con asesores', nombresDias(a.asesoresDias), nombresDias(b.asesoresDias));
    comparar('Asesores desde', a.asesoresInicio, b.asesoresInicio);
    comparar('Asesores hasta', a.asesoresFin, b.asesoresFin);
    const fa = new Map((a.feriados ?? []).map((f) => [f.fecha, f.nombre]));
    const fb = new Map((b.feriados ?? []).map((f) => [f.fecha, f.nombre]));
    const agregados = [...fb.keys()].filter((k) => !fa.has(k));
    const quitados = [...fa.keys()].filter((k) => !fb.has(k));
    const describe = (k, m) => `${fechaCorta(k)}${m.get(k) ? ` (${m.get(k)})` : ''}`;
    if (agregados.length) out.push({ etiqueta: 'Feriados agregados', despues: agregados.map((k) => describe(k, fb)).join('; ') });
    if (quitados.length) out.push({ etiqueta: 'Feriados quitados', despues: quitados.map((k) => describe(k, fa)).join('; ') });
    comparar('Espera mínima', `${a.ritmoMinS} s`, `${b.ritmoMinS} s`);
    comparar('Espera máxima', `${a.ritmoMaxS} s`, `${b.ritmoMaxS} s`);
    comparar('Mensajes automáticos desde', hora(a.automaticosHoraInicio), hora(b.automaticosHoraInicio));
    comparar('Mensajes automáticos hasta', hora(a.automaticosHoraFin), hora(b.automaticosHoraFin));
    return out;
  }

  function listaCambios(cambios) {
    const ul = el('ul', { class: 'cambios' });
    if (!cambios.length) ul.append(el('li', { text: 'Sin diferencias.' }));
    for (const c of cambios) {
      ul.append(
        el('li', {}, `${c.etiqueta}: `, c.antes != null ? [el('span', { class: 'antes', text: c.antes }), ' → '] : null, el('strong', { text: c.despues })),
      );
    }
    return ul;
  }

  // ── Estado, mensajes y botones ──────────────────────────────────────────────────────────────
  function renderEstado(exito) {
    const e = $('estado');
    e.className = 'estado';
    if (exito) {
      e.classList.add('ok');
      e.textContent = exito;
      return;
    }
    if (!datos.baseDisponible) {
      e.classList.add('aviso');
      e.textContent = 'La base de datos no está disponible en este momento: puedes revisar la configuración, pero no guardar ni publicar.';
      return;
    }
    const partes = [
      datos.publicada
        ? `Vigente: publicada por ${datos.publicada.publicadaPor} el ${fechaHora(datos.publicada.publicadaEn)}.`
        : 'Vigente: la configuración original. Todavía no se ha publicado nada desde este panel.',
    ];
    if (datos.borrador) {
      e.classList.add('aviso');
      partes.push(`Hay un borrador sin publicar, guardado por ${datos.borrador.autorNombre} el ${fechaHora(datos.borrador.creadaEn)}.`);
    }
    e.textContent = partes.join(' ');
  }

  function mostrarError(texto, conRecarga = false) {
    const caja = $('errores');
    caja.replaceChildren(texto);
    if (conRecarga) {
      caja.append(' ', el('button', { type: 'button', class: 'secundario', text: 'Recargar', onclick: () => conEspera(cargar) }));
    }
    caja.hidden = false;
    caja.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function mostrarErroresCampos(errores) {
    for (const p of document.querySelectorAll('.error-campo')) p.textContent = '';
    for (const i of document.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
    for (const { campo, mensaje } of errores) {
      const p = document.querySelector(`.error-campo[data-campo="${campo}"]`);
      if (p) p.textContent = p.textContent ? `${p.textContent} ${mensaje}` : mensaje;
      $(campo)?.setAttribute('aria-invalid', 'true');
    }
  }

  function limpiarMensajes() {
    $('errores').hidden = true;
    if ($('estado').classList.contains('ok')) renderEstado();
  }

  function manejarFallo(r) {
    if (r.errores?.length) {
      mostrarErroresCampos(r.errores);
      mostrarError(`${r.error ?? 'Hay datos que corregir.'} Revisa los campos marcados en rojo.`);
      return;
    }
    mostrarError(r.error ?? 'Algo salió mal. Intenta de nuevo.', r.motivo === 'conflicto');
  }

  function actualizarBotones() {
    const base = Boolean(datos?.baseDisponible);
    $('guardar').disabled = ocupado || !base || !sucio;
    $('publicar').disabled = ocupado || !base || !(sucio || datos?.borrador);
    $('descartar').hidden = !datos?.borrador;
    $('descartar').disabled = ocupado;
    $('indicador').textContent = sucio ? 'Tienes cambios sin guardar.' : datos?.borrador ? 'Borrador guardado, sin publicar.' : 'Sin cambios pendientes.';
  }

  function bloquear(texto) {
    sucio = false;
    for (const b of document.querySelectorAll('button, input, select, textarea')) b.disabled = true;
    mostrarError(texto);
  }

  // ── Historial ───────────────────────────────────────────────────────────────────────────────
  function renderHistorial() {
    const ol = $('historial');
    ol.replaceChildren();
    if (!datos.historial.length) {
      ol.append(el('li', { class: 'vacio', text: 'Todavía no hay publicaciones desde este panel.' }));
      return;
    }
    datos.historial.forEach((v, i) => {
      const anterior = datos.historial[i + 1]?.contenido ?? datos.porDefecto;
      const vigenteAhora = v.estado === 'publicada';
      ol.append(
        el(
          'li',
          {},
          el(
            'div',
            { class: 'cabecera' },
            el('span', { class: 'quien-cuando' }, `${fechaHora(v.publicadaEn)} · ${v.publicadaPor ?? v.autorNombre}`, vigenteAhora ? el('span', { class: 'insignia', text: 'Vigente' }) : null),
            vigenteAhora ? null : el('button', { type: 'button', class: 'secundario', text: 'Cargar en borrador', onclick: () => conEspera(() => restaurar(v)) }),
          ),
          v.nota ? el('p', { class: 'texto-nota', text: `«${v.nota}»` }) : null,
          el('details', {}, el('summary', { text: i + 1 < datos.historial.length ? 'Ver qué cambió' : 'Ver qué cambió respecto de la configuración original' }), listaCambios(diferencias(anterior, v.contenido))),
        ),
      );
    });
  }

  // ── Acciones ────────────────────────────────────────────────────────────────────────────────
  function aplicar(r, exito) {
    datos = r;
    escribirFormulario(datos.borrador?.contenido ?? datos.vigente);
    sucio = false;
    mostrarErroresCampos([]);
    $('errores').hidden = true;
    renderEstado(exito);
    renderHistorial();
    actualizarBotones();
    programarVista(0);
  }

  async function cargar() {
    const r = await api('GET', '');
    if (!r.ok) return mostrarError(r.error ?? 'No pudimos cargar la configuración.');
    aplicar(r);
  }

  async function guardar() {
    const r = await api('PUT', '/borrador', { contenido: leerFormulario(), borradorId: datos.borrador?.id ?? null });
    if (!r.ok) {
      manejarFallo(r);
      return false;
    }
    aplicar(r, 'Borrador guardado. Todavía no rige: publícalo cuando esté listo.');
    return true;
  }

  async function descartar() {
    if (!datos.borrador) return;
    if (!confirm('¿Descartar el borrador? Se pierden los cambios que no se han publicado.')) return;
    const r = await api('DELETE', `/borrador/${datos.borrador.id}`);
    if (!r.ok) return manejarFallo(r);
    aplicar(r, 'Borrador descartado. En pantalla está la configuración vigente.');
  }

  async function abrirPublicar() {
    if (sucio && !(await guardar())) return;
    if (!datos.borrador) return;
    $('resumen-cambios').replaceWith(Object.assign(listaCambios(diferencias(datos.vigente, datos.borrador.contenido)), { id: 'resumen-cambios' }));
    $('nota-publicacion').value = '';
    $('dialogo-publicar').showModal();
  }

  async function publicar() {
    const r = await api('POST', '/publicar', { borradorId: datos.borrador.id, nota: $('nota-publicacion').value });
    if (!r.ok) return manejarFallo(r);
    aplicar(r, 'Publicado. El bot ya está usando esta configuración.');
  }

  async function restaurar(v) {
    if (sucio && !confirm('Tienes cambios sin guardar en pantalla. ¿Reemplazarlos por esta versión anterior?')) return;
    if (!sucio && datos.borrador && !confirm('Esto reemplaza el borrador actual por la versión anterior. ¿Continuar?')) return;
    const r = await api('POST', '/restaurar', { versionId: v.id, borradorId: datos.borrador?.id ?? null });
    if (!r.ok) return manejarFallo(r);
    aplicar(r, `Cargaste en el borrador la versión del ${fechaHora(v.publicadaEn)}. Revísala y publícala para que vuelva a regir.`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Arranque ────────────────────────────────────────────────────────────────────────────────
  construirControles();
  $('formulario').addEventListener('input', (e) => {
    if (e.target.id?.startsWith('nuevo-feriado')) return; // escribir un feriado nuevo no es un cambio hasta agregarlo
    if (e.target.id === 'asesoresActivo') actualizarActivo();
    cambio();
  });
  $('agregar-feriado').addEventListener('click', agregarFeriado);
  $('nuevo-feriado-nombre').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      agregarFeriado();
    }
  });
  $('guardar').addEventListener('click', () => conEspera(guardar));
  $('descartar').addEventListener('click', () => conEspera(descartar));
  $('publicar').addEventListener('click', () => conEspera(abrirPublicar));
  $('dialogo-publicar').addEventListener('close', () => {
    if ($('dialogo-publicar').returnValue === 'publicar') conEspera(publicar);
  });
  window.addEventListener('beforeunload', (e) => {
    if (sucio) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  if (!SESION) bloquear('Abre este panel desde Bitrix24.');
  else conEspera(cargar);
})();
