// Detalle enriquecido por programa (descripción, objetivos, malla, requisitos,
// becas, brochure y VALORES reales). Se llena desde la página de cada programa.
// Datos reales extraídos de postgrados.uautonoma.cl el 2026-06-28.
export type DetallePrograma = {
  nombre: string;
  url: string;
  arancel?: string;
  matricula?: string;
  duracion?: string;
  modalidad?: string;
  grado?: string;
  requisitos?: string;
  descripcion?: string;
  objetivoGeneral?: string;
  objetivosEspecificos?: string[];
  dirigidoA?: string[];
  becas?: string;
  malla?: { semestre: string; modulos: string[] }[];
  brochureUrl?: string;
};

export const DETALLES: Record<string, DetallePrograma> = {
  'magister-en-gestion-de-la-inclusion-y-convivencia-educativa': {
    nombre: 'Magíster en Gestión de la Inclusión y Convivencia Educativa',
    url: 'https://postgrados.uautonoma.cl/programas/magisteres/magister-en-gestion-de-la-inclusion-y-convivencia-educativa/',
    arancel: '$5.490.000',
    matricula: '$250.000',
    duracion: '4 semestres',
    modalidad: 'Online (Campus Virtual)',
    grado: 'Magíster en Gestión de la Inclusión y Convivencia Educativa',
    requisitos:
      'Licenciatura de carrera profesional universitaria (mínimo 8 semestres) y experiencia profesional de al menos 3 años.',
    descripcion:
      'Programa orientado a la gestión de la inclusión y la convivencia en instituciones educativas, frente a ' +
      'entornos cada vez más diversos, desiguales y cambiantes. Aborda cómo interactúan estudiantes, docentes, ' +
      'equipos directivos y familias y cómo configuran el clima escolar, desde enfoques basados en derechos, ' +
      'justicia educativa y ética profesional. Forma profesionales capaces de diagnosticar dinámicas internas, ' +
      'diseñar estrategias de inclusión y prevención de la violencia escolar, y fortalecer comunidades educativas ' +
      'más justas, democráticas y sostenibles.',
    objetivoGeneral:
      'Formar profesionales capaces de liderar procesos de gestión institucional orientados a la inclusión y la ' +
      'convivencia educativas, mediante el diseño, implementación y evaluación de estrategias basadas en evidencia, ' +
      'marcos normativos y enfoques interdisciplinarios.',
    objetivosEspecificos: [
      'Analizar los marcos conceptuales, normativos y de políticas públicas de inclusión y convivencia educativa.',
      'Diagnosticar las dinámicas de convivencia y los niveles de inclusión con herramientas e indicadores basados en evidencia.',
      'Diseñar e implementar estrategias y programas para promover la inclusión, prevenir la violencia escolar y fortalecer el clima institucional.',
      'Evaluar el impacto de políticas y prácticas, proponiendo mejoras continuas con criterios éticos y evidencia empírica.',
    ],
    dirigidoA: [
      'Profesionales de la Educación',
      'Docentes',
      'Orientadores',
      'Directivos',
      'Psicólogos y Trabajadores Sociales',
      'Investigadores y Académicos',
      'Funcionarios Públicos',
    ],
    becas:
      'Dirigido a profesionales de la educación (docentes, directivos, orientadores), psicólogos, trabajadores ' +
      'sociales y otros licenciados interesados en liderar procesos de inclusión y convivencia educativa. ' +
      'Consultar becas y beneficios vigentes con un asesor.',
    malla: [
      {
        semestre: 'I Semestre',
        modulos: [
          'Aprendizaje en ambientes virtuales',
          'Políticas Públicas en Inclusión Educativa',
          'Teorías de la Convivencia Educativa',
          'Diversidad, Equidad e Inclusión',
          'Metodología de la Investigación en Educación',
        ],
      },
      {
        semestre: 'II Semestre',
        modulos: [
          'Gestión de la Convivencia Educativa',
          'Diagnóstico Institucional y Clima Educativo',
          'Marco Normativo y Legislación Educativa',
          'Diseño de Programas de Inclusión',
          'Educación socioemocional y convivencia educativa',
        ],
      },
      {
        semestre: 'III Semestre',
        modulos: [
          'Liderazgo Educativo para la Inclusión',
          'Métodos Cuantitativos y Cualitativos aplicados',
          'Evaluación de Programas en Convivencia Educativa',
          'Gestión del Cambio en Instituciones Educativas',
          'Actividad de Graduación I',
        ],
      },
      { semestre: 'IV Semestre', modulos: ['Actividad de Graduación II'] },
    ],
    brochureUrl:
      'https://postgrados.uautonoma.cl/content/uploads/2026/05/Magister-en-Gestion-de-la-Inclusion-y-Convivencia-Educativa.pdf',
  },
};

const slugFromUrl = (u: string) => u.replace(/\/+$/, '').split('/').pop() ?? u;

export function getDetalle(opts: { url?: string; nombre?: string }): DetallePrograma | undefined {
  if (opts.url) {
    const d = DETALLES[slugFromUrl(opts.url)];
    if (d) return d;
  }
  if (opts.nombre) {
    const n = opts.nombre.toLowerCase().trim();
    return Object.values(DETALLES).find(
      (d) => d.nombre.toLowerCase().includes(n) || n.includes(d.nombre.toLowerCase()),
    );
  }
  return undefined;
}
