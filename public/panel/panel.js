'use strict';

// Panel de configuración del bot: Horarios, Programas y modalidad, y Precios.
// La parte común (borrador, publicar, historial, mensajes) es la misma para todas las secciones; cada
// sección aporta su formulario: cómo se escribe, cómo se lee y cómo se describe lo que cambió.
// Todo lo que viene de personas o de otros sitios (nombres, notas, títulos de archivos) se inserta como
// TEXTO, nunca como HTML.
(() => {
  const SESION = document.querySelector('meta[name="panel-sesion"]')?.content ?? '';
  const DISPONIBLES = (document.querySelector('meta[name="panel-secciones"]')?.content || 'horarios').split(',').filter(Boolean);
  const TZ = 'America/Santiago';

  const $ = (id) => document.getElementById(id);
  let actual = null; // nombre de la sección en pantalla
  let modulo = null; // su formulario
  let datos = null; // lo que devolvió el servidor para esa sección
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
  const usd = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `USD ${Number(n).toLocaleString('es-CL', { maximumFractionDigits: 2 })}`);
  const numero = (v) => (v === '' || v == null ? null : Number(v));
  const recortar = (t, n = 110) => (String(t ?? '').length > n ? `${String(t).slice(0, n - 1)}…` : String(t ?? ''));
  const errorDe = (campo, tag = 'p') => el(tag, { class: 'error-campo', 'data-campo': campo });

  // ── Comunicación con el servidor ────────────────────────────────────────────────────────────
  async function pedir(metodo, url, cuerpo) {
    const r = await fetch(url, {
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
  const api = (metodo, ruta, cuerpo) => pedir(metodo, `/panel/api/seccion/${actual}${ruta}`, cuerpo);

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

  function cambio(e) {
    sucio = true;
    limpiarMensajes();
    actualizarBotones();
    modulo.alCambiar?.(e);
    programarVista();
  }

  function programarVista(ms = 350) {
    clearTimeout(temporizadorVista);
    if (!modulo?.vista) return;
    const seccion = actual;
    temporizadorVista = setTimeout(() => {
      if (seccion === actual) modulo.vista();
    }, ms);
  }

  /** Lista "antes → después" de los campos que difieren. */
  function comparador() {
    const out = [];
    const comparar = (etiqueta, antes, despues) => {
      if (antes !== despues) out.push({ etiqueta, antes, despues });
    };
    return { out, comparar };
  }

  // ── Sección Horarios ────────────────────────────────────────────────────────────────────────
  function crearHorarios() {
    const form = $('form-horarios');
    // Lunes primero, como se lee una semana de trabajo; el valor es el de JavaScript (0 = domingo).
    const DIAS = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];
    let feriados = []; // feriados en pantalla

    function iniciar() {
      const dias = $('dias');
      for (const [valor, nombre] of DIAS) {
        dias.append(el('label', {}, el('input', { type: 'checkbox', value: valor, name: 'asesoresDias' }), nombre));
      }
      for (const id of ['automaticosHoraInicio', 'automaticosHoraFin']) {
        const sel = $(id);
        for (let h = 0; h <= 24; h++) sel.append(el('option', { value: h, text: h === 24 ? '24:00 (medianoche)' : `${h}:00` }));
      }
      $('agregar-feriado').addEventListener('click', agregarFeriado);
      $('nuevo-feriado-nombre').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          agregarFeriado();
        }
      });
    }

    function leer() {
      return {
        asesoresActivo: $('asesoresActivo').checked,
        asesoresDias: [...form.querySelectorAll('#dias input:checked')].map((i) => Number(i.value)),
        asesoresInicio: $('asesoresInicio').value,
        asesoresFin: $('asesoresFin').value,
        feriados: feriados.map((f) => ({ fecha: f.fecha, nombre: f.nombre })),
        ritmoMinS: numero($('ritmoMinS').value),
        ritmoMaxS: numero($('ritmoMaxS').value),
        automaticosHoraInicio: Number($('automaticosHoraInicio').value),
        automaticosHoraFin: Number($('automaticosHoraFin').value),
      };
    }

    function escribir(h) {
      $('asesoresActivo').checked = Boolean(h.asesoresActivo);
      for (const i of form.querySelectorAll('#dias input')) i.checked = h.asesoresDias.includes(Number(i.value));
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

    function alCambiar(e) {
      if (e?.target?.id === 'asesoresActivo') actualizarActivo();
    }

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
      const error = form.querySelector('[data-campo="feriados"]');
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

    async function vista() {
      let r;
      try {
        r = await api('POST', '/vista', { contenido: leer() });
      } catch {
        return;
      }
      if (actual !== 'horarios') return;
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

    const nombresDias = (lista) =>
      DIAS.filter(([v]) => lista.includes(v))
        .map(([, n]) => n)
        .join(', ') || 'Ninguno';
    const hora = (h) => (h === 24 ? '24:00' : `${h}:00`);

    function diferencias(a, b) {
      const { out, comparar } = comparador();
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

    return { form, iniciar, leer, escribir, alCambiar, vista, diferencias };
  }

  // ── Lista de programas (común a Programas y Precios) ────────────────────────────────────────
  const TIPOS = [['licenciatura', 'Licenciaturas'], ['maestria', 'Maestrías']];
  const ordenTipo = (t) => {
    const i = TIPOS.findIndex(([k]) => k === t);
    return i < 0 ? TIPOS.length : i;
  };
  const ordenar = (programas) =>
    Object.entries(programas ?? {}).sort(([, a], [, b]) => ordenTipo(a.tipo) - ordenTipo(b.tipo) || a.nombre.localeCompare(b.nombre, 'es'));

  /** Pinta los programas agrupados por tipo, cada uno plegable, y recuerda cuáles estaban abiertos
   *  para que guardar o recargar no los cierre. */
  function listaDeProgramas(contenedor, abiertos, programas, tarjeta) {
    contenedor.replaceChildren();
    const entradas = ordenar(programas);
    for (const [tipo, titulo] of TIPOS) {
      const grupo = entradas.filter(([, p]) => p.tipo === tipo);
      if (!grupo.length) continue;
      contenedor.append(el('h3', { class: 'grupo', text: `${titulo} (${grupo.length})` }));
      for (const [slug, p] of grupo) {
        const det = tarjeta(slug, p);
        if (abiertos.has(slug)) det.open = true;
        det.addEventListener('toggle', () => (det.open ? abiertos.add(slug) : abiertos.delete(slug)));
        contenedor.append(det);
      }
    }
    return entradas.map(([s]) => s);
  }

  // ── Sección Programas y modalidad ───────────────────────────────────────────────────────────
  function crearProgramas() {
    const form = $('form-programas');
    const lista = $('programas-lista');
    const abiertos = new Set();
    let orden = [];
    let base = { programas: {} };
    const campo = (slug, c) => `programas.${slug}.${c}`;
    const control = (slug, c) => form.querySelector(`[name="${campo(slug, c)}"]`);
    const disponibilidad = (slug) => form.querySelector(`[name="${campo(slug, 'disponibilidad')}"]:checked`)?.value ?? '';

    function iniciar() {
      form.addEventListener('click', (e) => {
        const b = e.target.closest('[data-probar]');
        if (b) probarBrochure(b.dataset.probar, b);
      });
    }

    function tarjeta(slug, p) {
      const n = (c) => campo(slug, c);
      const det = el(
        'details',
        { class: 'programa', 'data-slug': slug },
        el('summary', {}, el('span', { class: 'nombre', text: p.nombre }), el('span', { class: 'chips' })),
        el(
          'div',
          { class: 'cuerpo' },
          el(
            'fieldset',
            {},
            el('legend', { text: 'Disponibilidad' }),
            el(
              'div',
              { class: 'opciones' },
              el('label', {}, el('input', { type: 'radio', name: n('disponibilidad'), value: 'abierto' }), 'Abierto a matrícula'),
              el('label', {}, el('input', { type: 'radio', name: n('disponibilidad'), value: 'cupos_completos' }), 'Cupos completos'),
            ),
            errorDe(n('disponibilidad')),
            el(
              'div',
              { class: 'solo-cupos' },
              el('div', { class: 'fila' }, el('label', { class: 'ancho' }, 'La matrícula reabre en', el('input', { type: 'text', name: n('reabre'), maxlength: 60, placeholder: 'Ej.: marzo de 2027' }))),
              errorDe(n('reabre')),
              el('p', { class: 'nota', text: 'Con cupos completos el bot igual presenta el programa y su precio, pero avisa primero que hoy no se puede matricular, dice cuándo reabre y registra el interés para avisarle.' }),
            ),
          ),
          el('label', { class: 'bloque' }, el('span', {}, 'Modalidad ', el('small', { text: '(cómo se dicta; el bot la usa tal cual para responder)' })), el('textarea', { name: n('modalidad'), rows: 3, maxlength: 600 })),
          errorDe(n('modalidad')),
          el('div', { class: 'fila' }, el('label', { class: 'ancho' }, 'Duración', el('input', { type: 'text', name: n('duracion'), maxlength: 80, placeholder: 'Ej.: 12 meses de clases' }))),
          errorDe(n('duracion')),
          el(
            'div',
            { class: 'fila' },
            el('label', { class: 'ancho' }, 'Brochure (enlace al PDF)', el('input', { type: 'url', name: n('brochureUrl'), placeholder: 'https://…', inputmode: 'url' })),
            el('button', { type: 'button', class: 'secundario', 'data-probar': slug, text: 'Probar enlace' }),
          ),
          el('p', { class: 'resultado-brochure', 'aria-live': 'polite' }),
          errorDe(n('brochureUrl')),
          el('p', { class: 'nota', text: 'Antes de entregarlo, el bot comprueba que el enlace abra un PDF de este programa. Si lo dejas vacío, dice que no tiene el brochure a mano, sin inventar un enlace.' }),
        ),
      );
      for (const r of det.querySelectorAll(`[name="${n('disponibilidad')}"]`)) r.checked = r.value === p.disponibilidad;
      det.querySelector(`[name="${n('reabre')}"]`).value = p.reabre ?? '';
      det.querySelector(`[name="${n('modalidad')}"]`).value = p.modalidad ?? '';
      det.querySelector(`[name="${n('duracion')}"]`).value = p.duracion ?? '';
      det.querySelector(`[name="${n('brochureUrl')}"]`).value = p.brochureUrl ?? '';
      return det;
    }

    function resumir(det) {
      const slug = det.dataset.slug;
      const cupos = disponibilidad(slug) === 'cupos_completos';
      const reabre = control(slug, 'reabre').value.trim();
      det.querySelector('.solo-cupos').hidden = !cupos;
      const brochure = control(slug, 'brochureUrl').value.trim();
      det.querySelector('.chips').replaceChildren(
        cupos
          ? el('span', { class: 'etiqueta feriado', text: reabre ? `Cupos completos · reabre ${reabre}` : 'Cupos completos' })
          : el('span', { class: 'etiqueta bot', text: 'Abierto a matrícula' }),
        el('span', { class: brochure ? 'etiqueta asesores' : 'etiqueta apagada', text: brochure ? 'Con brochure' : 'Sin brochure' }),
      );
    }

    function escribir(c) {
      base = c;
      orden = listaDeProgramas(lista, abiertos, c.programas, tarjeta);
      for (const det of lista.querySelectorAll('details.programa')) resumir(det);
    }

    function leer() {
      const programas = {};
      for (const slug of orden) {
        const p = base.programas[slug];
        programas[slug] = {
          nombre: p.nombre,
          tipo: p.tipo,
          disponibilidad: disponibilidad(slug),
          reabre: control(slug, 'reabre').value,
          modalidad: control(slug, 'modalidad').value,
          duracion: control(slug, 'duracion').value,
          brochureUrl: control(slug, 'brochureUrl').value.trim(),
        };
      }
      return { programas };
    }

    function alCambiar(e) {
      const det = e?.target?.closest?.('details.programa');
      if (!det) return;
      resumir(det);
      // Un resultado de "Probar enlace" ya no vale si el enlace cambió.
      if (e.target.name?.endsWith('.brochureUrl')) {
        const salida = det.querySelector('.resultado-brochure');
        salida.textContent = '';
        salida.className = 'resultado-brochure';
      }
    }

    async function probarBrochure(slug, boton) {
      const salida = boton.closest('.cuerpo').querySelector('.resultado-brochure');
      const url = control(slug, 'brochureUrl').value.trim();
      salida.className = 'resultado-brochure';
      salida.textContent = 'Probando el enlace…';
      boton.disabled = true;
      try {
        const r = await pedir('POST', '/panel/api/brochure/verificar', { programa: slug, url });
        salida.textContent = r.ok ? r.mensaje : r.error;
        salida.classList.add(r.ok && r.valido ? 'ok' : 'mal');
      } catch (e) {
        if (e?.message !== 'sesion') {
          salida.textContent = 'No pudimos probar el enlace. Intenta de nuevo.';
          salida.classList.add('mal');
        }
      } finally {
        boton.disabled = false;
      }
    }

    const disp = (x) => (x.disponibilidad === 'cupos_completos' ? `Cupos completos (reabre ${x.reabre})` : 'Abierto a matrícula');

    function diferencias(a, b) {
      const { out, comparar } = comparador();
      const anteriores = a?.programas ?? {};
      for (const [slug, q] of ordenar(b?.programas)) {
        const p = anteriores[slug];
        if (!p) continue;
        comparar(`${q.nombre} — disponibilidad`, disp(p), disp(q));
        if (p.modalidad !== q.modalidad) out.push({ etiqueta: `${q.nombre} — modalidad`, antes: recortar(p.modalidad), despues: recortar(q.modalidad) });
        comparar(`${q.nombre} — duración`, p.duracion, q.duracion);
        comparar(`${q.nombre} — brochure`, p.brochureUrl ? recortar(p.brochureUrl, 70) : 'Sin brochure', q.brochureUrl ? recortar(q.brochureUrl, 70) : 'Sin brochure');
      }
      return out;
    }

    return { form, iniciar, leer, escribir, alCambiar, diferencias };
  }

  // ── Sección Precios ─────────────────────────────────────────────────────────────────────────
  function crearPrecios() {
    const form = $('form-precios');
    const lista = $('precios-lista');
    const abiertos = new Set();
    let orden = [];
    let base = { programas: {} };
    const CAMPOS = [
      ['arancelLista', 'Arancel de lista', usd],
      ['becaPct', 'Beca', (v) => `${v}%`],
      ['cuotas', 'Cuotas mensuales', (v) => `${v} cuotas`],
      ['matricula', 'Matrícula con beca', usd],
      ['matriculaRegular', 'Matrícula regular', usd],
      ['semestralPagos', 'Pagos semestrales', (v) => `${v} pagos`],
      ['semestralMonto', 'Monto de cada pago semestral', usd],
      ['contadoTotal', 'Pago al contado', usd],
      ['contadoAnios', 'Años del pago al contado', (v) => (v > 1 ? `${v} años` : 'Un solo pago')],
    ];
    const campo = (slug, c) => `programas.${slug}.${c}`;
    const valor = (slug, c) => numero(form.querySelector(`[name="${campo(slug, c)}"]`).value);

    function tarjeta(slug, p) {
      const n = (c) => campo(slug, c);
      const num = (c, etiqueta, extra = {}) =>
        el('label', {}, etiqueta, el('input', { type: 'number', name: n(c), min: 0, step: '0.01', inputmode: 'decimal', ...extra }), errorDe(n(c), 'span'));
      const calculado = (clave) => el('p', { class: 'calculado', 'data-calc': clave });
      const det = el(
        'details',
        { class: 'programa', 'data-slug': slug },
        el('summary', {}, el('span', { class: 'nombre', text: p.nombre }), el('span', { class: 'chips' })),
        el(
          'div',
          { class: 'cuerpo' },
          el('h4', { text: 'Arancel' }),
          el('div', { class: 'grilla' }, num('arancelLista', 'Arancel de lista (USD)'), num('becaPct', 'Beca (%)', { step: 1, max: 95, inputmode: 'numeric' }), calculado('conBeca')),
          el('h4', { text: 'En cuotas mensuales' }),
          el(
            'div',
            { class: 'grilla' },
            num('cuotas', 'Cantidad de cuotas', { step: 1, min: 1, max: 60, inputmode: 'numeric' }),
            calculado('cuota'),
            num('matricula', 'Matrícula con beca (USD)'),
            num('matriculaRegular', 'Matrícula regular (USD)'),
          ),
          el('p', { class: 'nota', text: 'Es la única forma de pago que cobra matrícula.' }),
          el('h4', { text: 'Semestral' }),
          el('div', { class: 'grilla' }, num('semestralPagos', 'Cantidad de pagos', { step: 1, min: 1, max: 12, inputmode: 'numeric' }), num('semestralMonto', 'Monto de cada pago (USD)'), calculado('semestral')),
          el('p', { class: 'nota', text: 'Precio fijo, sin matrícula y con el beneficio ya aplicado.' }),
          el('h4', { text: 'Al contado' }),
          el('div', { class: 'grilla' }, num('contadoTotal', 'Total (USD)'), num('contadoAnios', 'Se paga en (años)', { step: 1, min: 1, max: 10, inputmode: 'numeric' }), calculado('contado')),
          el('p', { class: 'nota', text: 'La opción más barata, sin matrícula. Con más de un año, el total se paga en partes iguales, una por año (como en las licenciaturas).' }),
          el(
            'div',
            { class: 'vista-precio' },
            el('h4', { text: 'Así lo cotizará el bot' }),
            el('ul', { class: 'resumen' }),
            el('h4', { text: 'Cómo se paga cada monto' }),
            el('ul', { class: 'pagos' }),
          ),
        ),
      );
      for (const [c] of CAMPOS) det.querySelector(`[name="${n(c)}"]`).value = p[c] ?? '';
      return det;
    }

    /** Lo que se calcula solo, a la vista mientras se escribe (el servidor vuelve a validarlo). */
    function calcular(det) {
      const slug = det.dataset.slug;
      const v = (c) => valor(slug, c);
      const lista_ = v('arancelLista');
      const beca = v('becaPct');
      const conBeca = lista_ != null && beca != null ? (lista_ * (100 - beca)) / 100 : null;
      const cuotas = v('cuotas');
      const cuota = conBeca != null && cuotas ? conBeca / cuotas : null;
      const semPagos = v('semestralPagos');
      const semMonto = v('semestralMonto');
      const total = v('contadoTotal');
      const anios = v('contadoAnios');
      const pon = (clave, texto) => (det.querySelector(`[data-calc="${clave}"]`).textContent = texto);
      pon('conBeca', `Arancel con beca: ${usd(conBeca)}`);
      pon('cuota', `Cada cuota: ${usd(cuota)}`);
      pon('semestral', `Total semestral: ${usd(semPagos != null && semMonto != null ? semPagos * semMonto : null)}`);
      pon('contado', anios > 1 && total != null ? `${anios} pagos anuales de ${usd(total / anios)}` : 'En un solo pago');
      det.querySelector('.chips').replaceChildren(
        el('span', { class: 'etiqueta asesores', text: `${usd(conBeca)} con beca` }),
        cuotas && cuota != null ? el('span', { class: 'etiqueta apagada', text: `${cuotas} × ${usd(cuota)}` }) : null,
      );
    }

    function escribir(c) {
      base = c;
      $('vigenciaHasta').value = c.vigenciaHasta ?? '';
      orden = listaDeProgramas(lista, abiertos, c.programas, tarjeta);
      for (const det of lista.querySelectorAll('details.programa')) calcular(det);
    }

    function leer() {
      const programas = {};
      for (const slug of orden) {
        const p = base.programas[slug];
        programas[slug] = { nombre: p.nombre, tipo: p.tipo };
        for (const [c] of CAMPOS) programas[slug][c] = valor(slug, c);
      }
      return { vigenciaHasta: $('vigenciaHasta').value, programas };
    }

    function alCambiar(e) {
      const det = e?.target?.closest?.('details.programa');
      if (det) calcular(det);
    }

    async function vista() {
      let r;
      try {
        r = await api('POST', '/vista', { contenido: leer() });
      } catch {
        return;
      }
      if (actual !== 'precios') return;
      if (!r.ok) {
        mostrarErroresCampos(r.errores ?? []);
        lista.classList.add('desactualizada');
        return;
      }
      mostrarErroresCampos([]);
      lista.classList.remove('desactualizada');
      for (const [slug, v] of Object.entries(r.programas ?? {})) {
        const det = lista.querySelector(`details[data-slug="${slug}"]`);
        if (!det) continue;
        det.querySelector('.resumen').replaceChildren(...v.resumen.map((t) => el('li', { text: t })));
        det.querySelector('.pagos').replaceChildren(
          ...v.pagos.map((p) =>
            el(
              'li',
              {},
              `${p.etiqueta} ${usd(p.montoUsd)}: `,
              p.medio === 'paypal'
                ? el('span', { class: 'etiqueta bot', text: 'PayPal' })
                : [el('span', { class: 'etiqueta feriado', text: 'Flywire' }), ' no hay enlace de PayPal por ese monto.'],
            ),
          ),
        );
      }
    }

    function diferencias(a, b) {
      const { out, comparar } = comparador();
      const vig = (x) => (x?.vigenciaHasta ? fechaLarga(x.vigenciaHasta) : 'Sin fecha');
      comparar('Vigencia de los precios', vig(a), vig(b));
      const anteriores = a?.programas ?? {};
      for (const [slug, q] of ordenar(b?.programas)) {
        const p = anteriores[slug];
        if (!p) continue;
        for (const [c, etiqueta, formato] of CAMPOS) comparar(`${q.nombre} — ${etiqueta}`, formato(p[c]), formato(q[c]));
      }
      return out;
    }

    return { form, iniciar() {}, leer, escribir, alCambiar, vista, diferencias };
  }

  const FABRICAS = { horarios: crearHorarios, programas: crearProgramas, precios: crearPrecios };
  const modulos = {};
  function moduloDe(nombre) {
    if (!modulos[nombre]) {
      modulos[nombre] = FABRICAS[nombre]();
      modulos[nombre].iniciar();
    }
    return modulos[nombre];
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
    if (!datos) {
      e.textContent = 'Cargando…';
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

  /** Marca en rojo los campos con error de la sección en pantalla, y abre el programa que lo tenga. */
  function mostrarErroresCampos(errores) {
    const form = modulo?.form;
    if (!form) return;
    for (const p of form.querySelectorAll('.error-campo')) p.textContent = '';
    for (const i of form.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid');
    for (const { campo, mensaje } of errores) {
      const p = form.querySelector(`.error-campo[data-campo="${campo}"]`);
      if (p) {
        p.textContent = p.textContent ? `${p.textContent} ${mensaje}` : mensaje;
        const det = p.closest('details');
        if (det) det.open = true;
      }
      (form.querySelector(`[name="${campo}"]`) ?? document.getElementById(campo))?.setAttribute('aria-invalid', 'true');
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
          el('details', {}, el('summary', { text: i + 1 < datos.historial.length ? 'Ver qué cambió' : 'Ver qué cambió respecto de la configuración original' }), listaCambios(modulo.diferencias(anterior, v.contenido))),
        ),
      );
    });
  }

  // ── Acciones ────────────────────────────────────────────────────────────────────────────────
  function aplicar(r, exito) {
    datos = r;
    modulo.escribir(datos.borrador?.contenido ?? datos.vigente);
    sucio = false;
    mostrarErroresCampos([]);
    $('errores').hidden = true;
    renderEstado(exito);
    renderHistorial();
    $('acciones').hidden = false;
    $('tarjeta-historial').hidden = false;
    actualizarBotones();
    programarVista(0);
  }

  async function cargar() {
    const r = await api('GET', '');
    if (!r.ok) return mostrarError(r.error ?? 'No pudimos cargar la configuración.');
    aplicar(r);
  }

  async function guardar() {
    const r = await api('PUT', '/borrador', { contenido: modulo.leer(), borradorId: datos.borrador?.id ?? null });
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
    $('resumen-cambios').replaceWith(Object.assign(listaCambios(modulo.diferencias(datos.vigente, datos.borrador.contenido)), { id: 'resumen-cambios' }));
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

  // ── Navegación entre secciones ──────────────────────────────────────────────────────────────
  async function irA(nombre) {
    if (!DISPONIBLES.includes(nombre)) nombre = 'horarios';
    if (nombre === actual || ocupado) return;
    if (sucio && !confirm('Tienes cambios sin guardar en esta sección. ¿Salir sin guardarlos?')) {
      history.replaceState(null, '', `#${actual}`);
      return;
    }
    sucio = false;
    actual = nombre;
    modulo = moduloDe(nombre);
    clearTimeout(temporizadorVista);
    for (const f of document.querySelectorAll('form.seccion')) f.hidden = f !== modulo.form;
    for (const b of document.querySelectorAll('.menu [data-seccion]')) {
      const activo = b.dataset.seccion === nombre;
      b.classList.toggle('activo', activo);
      if (activo) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    if (location.hash !== `#${nombre}`) history.replaceState(null, '', `#${nombre}`);
    datos = null;
    $('errores').hidden = true;
    $('acciones').hidden = true;
    $('tarjeta-historial').hidden = true;
    renderEstado();
    await conEspera(cargar);
  }

  // ── Arranque ────────────────────────────────────────────────────────────────────────────────
  for (const b of document.querySelectorAll('.menu [data-seccion]')) {
    b.hidden = !DISPONIBLES.includes(b.dataset.seccion);
    b.addEventListener('click', () => irA(b.dataset.seccion));
  }
  for (const f of document.querySelectorAll('form.seccion')) {
    f.addEventListener('input', (e) => {
      if (f !== modulo?.form || e.target.hasAttribute('data-no-cambio')) return; // p. ej. escribir un feriado antes de agregarlo
      cambio(e);
    });
  }
  window.addEventListener('hashchange', () => irA(location.hash.slice(1)));
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
  else irA(location.hash.slice(1) || 'horarios');
})();
