"""
Extrae de las páginas web de Carver los datos que la ficha del bot todavía no tiene: estructura del
plan de estudios, perfil de egreso y ámbitos de desempeño profesional.

    PYTHONIOENCODING=utf-8 python -I scripts/extraer-programas-carver.py <carpeta> <salida.json>

Las páginas son capturas del sitio (unos 650 KB cada una) con una plantilla común: se usan sus
títulos de sección como anclas. Si una página no calza con esa plantilla, se omite y se informa —
mejor perder un programa que cargarle al bot un plan de estudios inventado, porque lo va a citar
delante de alguien que está decidiendo dónde gastar varios miles de dólares.

El script NO escribe sobre los datos del bot: deja un JSON aparte para revisar y fusionar.
"""

import sys, re, io, html, json, os

# Las páginas vienen de una descarga: se leen como datos, nunca se ejecuta nada desde esa carpeta.
ASIGNATURA = re.compile(r'^[A-Z]{2,4} ?\d{3}$')
CREDITOS = re.compile(r'^(\d+)\s*Cr$', re.I)


def lineas_de(ruta):
    """Texto visible de la página, sin repetidos y en orden."""
    raw = io.open(ruta, encoding='utf-8', errors='replace').read()
    raw = re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>', ' ', raw)
    raw = re.sub(r'(?is)<!--.*?-->', ' ', raw)
    txt = html.unescape(re.sub(r'(?is)<[^>]+>', '\n', raw))
    # Solo se descartan repeticiones CONSECUTIVAS. Deduplicar la página entera parecía razonable
    # —quita menús y pies repetidos— pero borraba los "3 Cr" de todas las asignaturas salvo la
    # primera, porque son la misma cadena: el plan salía sin créditos y nadie lo habría notado.
    out = []
    for l in (x.strip() for x in txt.split('\n')):
        if len(l) < 3 or (out and out[-1] == l):
            continue
        out.append(l)
    return out


def entre(lineas, desde, hasta):
    """Tramo entre dos títulos de sección. Vacío si falta alguno: no se adivina."""
    try:
        i = lineas.index(desde)
    except ValueError:
        return []
    for j in range(i + 1, len(lineas)):
        if lineas[j] in hasta:
            return lineas[i + 1:j]
    return lineas[i + 1:]


def plan_de_estudios(lineas):
    """Asignaturas con su código, créditos, nombre y descripción, agrupadas por eje."""
    tramo = entre(lineas, '¿Cómo se estudia?', {'Inversión', 'Preguntas frecuentes', 'Dirección del programa'})
    if not tramo:
        return None, []
    resumen = tramo[0] if tramo else ''
    ejes, eje_actual, i = [], None, 1
    while i < len(tramo):
        l = tramo[i]
        if re.match(r'^Eje \d+$', l):
            # Al eje le siguen su nombre y, normalmente, una bajada.
            eje_actual = {'eje': tramo[i + 1] if i + 1 < len(tramo) else l, 'asignaturas': []}
            ejes.append(eje_actual)
            i += 2
            continue
        if ASIGNATURA.match(l):
            codigo, j = l, i + 1
            creditos = None
            if j < len(tramo) and CREDITOS.match(tramo[j]):
                creditos = int(CREDITOS.match(tramo[j]).group(1))
                j += 1
            nombre = tramo[j] if j < len(tramo) else ''
            j += 1
            descripcion = ''
            if j < len(tramo) and not ASIGNATURA.match(tramo[j]) and not re.match(r'^Eje \d+$', tramo[j]):
                descripcion = tramo[j]
                j += 1
            if eje_actual is None:
                eje_actual = {'eje': 'Plan de estudios', 'asignaturas': []}
                ejes.append(eje_actual)
            asig = {'codigo': codigo, 'nombre': nombre}
            if creditos:
                asig['creditos'] = creditos
            if descripcion:
                asig['descripcion'] = descripcion
            eje_actual['asignaturas'].append(asig)
            i = j
            continue
        i += 1
    return resumen, ejes


def extraer(ruta):
    lineas = lineas_de(ruta)
    nombre = lineas[0].split('|')[0].strip() if lineas else ''
    salidas = entre(lineas, 'Ámbitos de desempeño profesional', {'¿Cómo se estudia?'})
    # La primera línea del tramo es la bajada ("Dónde ejercerás tu liderazgo"), no una salida.
    salidas = [s for s in salidas[1:] if 3 < len(s) < 90]
    graduado = entre(lineas, 'Al graduarte podrás', {'Ámbitos de desempeño profesional'})
    graduado = [g for g in graduado[1:] if len(g) > 25]
    resumen, ejes = plan_de_estudios(lineas)
    return {
        'nombre': nombre,
        'resumenPlan': resumen,
        'planEstudios': ejes,
        'salidasLaborales': salidas,
        'alGraduarte': graduado,
    }


def main():
    carpeta, salida = sys.argv[1], sys.argv[2]
    rutas = []
    for base, _, archivos in os.walk(carpeta):
        for a in archivos:
            if a.lower().endswith('.html'):
                rutas.append(os.path.join(base, a))
    rutas.sort()

    datos, omitidos = {}, []
    for r in rutas:
        try:
            d = extraer(r)
        except Exception as e:
            omitidos.append((os.path.basename(r), f'error: {e}'))
            continue
        asignaturas = sum(len(e['asignaturas']) for e in d['planEstudios'])
        # Sin plan de estudios no aporta nada nuevo: la ficha ya tiene descripción y requisitos.
        if not asignaturas:
            omitidos.append((os.path.basename(r), 'sin plan de estudios reconocible'))
            continue
        d['asignaturas'] = asignaturas
        datos[d['nombre']] = d
        print(f"  {str(asignaturas).rjust(3)} asignaturas · {len(d['salidasLaborales'])} salidas · {d['nombre']}")

    json.dump(datos, io.open(salida, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f"\nExtraidos: {len(datos)} de {len(rutas)} archivos en {salida}")
    if omitidos:
        print('Omitidos:')
        for a, m in omitidos:
            print(f'  {a}: {m}')


if __name__ == '__main__':
    main()
