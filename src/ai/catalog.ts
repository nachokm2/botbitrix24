// Catálogo REAL de programas de postgrado de la Universidad Autónoma de Chile.
// Fuente: https://postgrados.uautonoma.cl/programas/magisteres/ (paginado) y /programas/doctorados/
// Extraído el 2026-06-28. Para refrescar: volver a leer esos listados y regenerar este arreglo.
export type Programa = {
  nombre: string;
  tipo: 'magister' | 'doctorado';
  facultad: string;
  modalidad: string; // 'online' | 'presencial' | '' (no especificada)
  duracion: string;
  url: string;
};

const M = 'https://postgrados.uautonoma.cl/programas/magisteres/';

export const PROGRAMAS: Programa[] = [
  // ── Magísteres ──
  { nombre: 'Magíster en Gestión de la Inclusión y Convivencia Educativa', tipo: 'magister', facultad: 'Educación', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-gestion-de-la-inclusion-y-convivencia-educativa/` },
  { nombre: 'Máster Formación Permanente en Sexología', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'presencial', duracion: '4 semestres', url: `${M}master-formacion-permanente-en-sexologia/` },
  { nombre: 'Magíster en Derecho del Trabajo, Procedimiento y Litigación Laboral', tipo: 'magister', facultad: 'Derecho', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-derecho-del-trabajo-procedimiento-y-litigacion-laboral/` },
  { nombre: 'Magíster en Administración en la Construcción', tipo: 'magister', facultad: 'Arquitectura, Construcción y Medio Ambiente', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-administracion-en-la-construccion/` },
  { nombre: 'Magíster en Gobierno Corporativo y Compliance', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-gobierno-corporativo-y-compliance/` },
  { nombre: 'Magíster en Derecho de Familia, Infancia y Adolescencia', tipo: 'magister', facultad: 'Derecho', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-derecho-de-familia-infancia-y-adolescencia/` },
  { nombre: 'Magíster en Desarrollo Organizacional: Innovación y Bienestar Laboral', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-desarrollo-organizacional-innovacion-y-bienestar-laboral/` },
  { nombre: 'Magíster en Gerontología para un Envejecimiento Activo', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-gerontologia-para-un-envejecimiento-activo/` },
  { nombre: 'Máster en Investigación y Gestión de Emergencia y Desastre', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '3 semestres', url: `${M}master-en-investigacion-y-gestion-de-emergencia-y-desastre/` },
  { nombre: 'Magíster en Ciencias Farmacéuticas Aplicadas', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-ciencias-farmaceuticas-aplicadas/` },
  { nombre: 'Magíster en Gestión y Desarrollo Municipal', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-gestion-y-desarrollo-municipal/` },
  { nombre: 'Magíster en Ingeniería Industrial', tipo: 'magister', facultad: 'Ingeniería', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-ingenieria-industrial/` },
  { nombre: 'Magíster en Analítica para los Negocios', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-analitica-para-los-negocios/` },
  { nombre: 'Magíster en Derecho Público: Transparencia, Regulaciones y Control', tipo: 'magister', facultad: 'Derecho', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-derecho-publico-transparencia-regulaciones-y-control/` },
  { nombre: 'Magíster en Neurorrehabilitación', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-neurorrehabilitacion/` },
  { nombre: 'Magíster en Intervención Musculoesquelética con Enfoque en el Razonamiento Clínico', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-intervencion-musculoesqueletica-con-enfoque-en-el-razonamiento-clinico/` },
  { nombre: 'Magíster en Intervención con Familias e Infancia', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-intervencion-con-familias-e-infancia/` },
  { nombre: 'Magíster en Inteligencia Artificial', tipo: 'magister', facultad: 'Ingeniería', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-inteligencia-artificial/` },
  { nombre: 'Magíster en Docencia en Educación Superior', tipo: 'magister', facultad: 'Educación', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-docencia-en-educacion-superior/` },
  { nombre: 'Magíster en Dirección y Gestión Escolar de la Calidad', tipo: 'magister', facultad: 'Educación', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-direccion-y-gestion-escolar-de-la-calidad/` },
  { nombre: 'Magíster en Derecho Penal y Procesal Penal', tipo: 'magister', facultad: 'Derecho', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-derecho-penal-y-procesal-penal/` },
  { nombre: 'Magíster en Neurodivergencia', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-neurodivergencia/` },
  { nombre: 'Magíster en Educación en Ciencias de la Salud y Simulación Clínica', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-educacion-en-ciencias-de-la-salud-y-simulacion-clinica/` },
  { nombre: 'Magíster en Creatividad Estratégica y Comunicación basadas en Inteligencia Artificial', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-creatividad-estrategica-y-comunicacion-basadas-en-inteligencia-artificial/` },
  { nombre: 'Magíster en Innovación', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-innovacion/` },
  { nombre: 'Magíster en Marketing Digital', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-marketing-digital/` },
  { nombre: 'Magíster en Finanzas y Gestión Financiera', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-finanzas-y-gestion-financiera/` },
  { nombre: 'Magíster en Desarrollo Económico, Social y Políticas Públicas', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-desarrollo-economico-social-y-politicas-publicas/` },
  { nombre: 'Magíster en Educación mención Diseño e Innovación Curricular', tipo: 'magister', facultad: 'Educación', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-educacion-mencion-diseno-e-innovacion-curricular/` },
  { nombre: 'Magíster en Economía Circular Industrial', tipo: 'magister', facultad: 'Arquitectura, Construcción y Medio Ambiente', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-economia-circular-industrial/` },
  { nombre: 'Magíster en Didáctica de la Lengua y la Literatura', tipo: 'magister', facultad: 'Educación', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-didactica-de-la-lengua-y-la-literatura/` },
  { nombre: 'Magíster en Deportes y Actividad Física', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-deportes-y-actividad-fisica/` },
  { nombre: 'Magíster en Justicia Constitucional y Derechos Humanos', tipo: 'magister', facultad: 'Derecho', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-justicia-constitucional-y-derechos-humanos/` },
  { nombre: 'Magíster en Derecho de Consumo y Comercio Electrónico', tipo: 'magister', facultad: 'Derecho', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-derecho-de-consumo-y-comercio-electronico/` },
  { nombre: 'Magíster en Psicología Clínica', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-psicologia-clinica/` },
  { nombre: 'Magíster en Investigación en Diversidad e Inclusión', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-investigacion-en-diversidad-e-inclusion/` },
  { nombre: 'Magíster en Gobierno y Dirección Pública', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-gobierno-y-direccion-publica/` },
  { nombre: 'Magíster en Trabajo Social', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-trabajo-social/` },
  { nombre: 'Magíster en Gestión Estratégica de Organizaciones de Salud', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-gestion-estrategica-de-organizaciones-de-salud/` },
  { nombre: 'Magíster en Neurociencias', tipo: 'magister', facultad: 'Ciencias de la Salud', modalidad: 'presencial', duracion: '4 semestres', url: `${M}magister-en-neurociencias/` },
  { nombre: 'Magíster en Tecnologías Aplicadas a la Construcción', tipo: 'magister', facultad: 'Arquitectura, Construcción y Medio Ambiente', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-tecnologias-aplicadas-a-la-construccion/` },
  { nombre: 'Magíster en Patrimonio y Turismo', tipo: 'magister', facultad: 'Ciencias Sociales y Humanidades', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-patrimonio-y-turismo/` },
  { nombre: 'Magíster en Formulación y Evaluación de Proyectos', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-formulacion-y-evaluacion-de-proyectos/` },
  { nombre: 'Magíster en Dirección de Operaciones, Logística y Cadena de Suministro', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-direccion-de-operaciones-logistica-y-cadena-de-suministro/` },
  { nombre: 'Magíster en Dirección de Personas y Gestión del Talento', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-direccion-de-personas-y-gestion-del-talento/` },
  { nombre: 'Magíster en Dirección de Empresas - MBA - Online', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'online', duracion: '4 semestres', url: `${M}magister-en-direccion-de-empresas-mba-online/` },
  { nombre: 'Magíster en Dirección de Empresas - MBA', tipo: 'magister', facultad: 'Administración y Negocios', modalidad: 'presencial', duracion: '4 semestres', url: `${M}magister-en-direccion-de-empresas-mba/` },

  // ── Doctorados ── (el listado no especifica facultad ni modalidad)
  { nombre: 'Doctorado en Ciencias Sociales', tipo: 'doctorado', facultad: 'Ciencias Sociales y Humanidades', modalidad: '', duracion: '8 semestres', url: 'https://www.uautonoma.cl/doctorado-en-ciencias-sociales/' },
  { nombre: 'Doctorado en Ciencias Aplicadas', tipo: 'doctorado', facultad: '', modalidad: '', duracion: '8 semestres', url: 'https://www.uautonoma.cl/doctorado-en-ciencias-aplicadas/' },
  { nombre: 'Doctorado en Ciencias Biomédicas', tipo: 'doctorado', facultad: 'Ciencias de la Salud', modalidad: '', duracion: '8 semestres', url: 'https://www.uautonoma.cl/doctorado-en-ciencias-biomedicas/' },
  { nombre: 'Doctorado en Derecho', tipo: 'doctorado', facultad: 'Derecho', modalidad: '', duracion: '8 semestres', url: 'https://www.uautonoma.cl/doctorado-en-derecho/' },
];

export const FACULTADES = [
  'Administración y Negocios',
  'Arquitectura, Construcción y Medio Ambiente',
  'Ciencias de la Salud',
  'Ciencias Sociales y Humanidades',
  'Derecho',
  'Educación',
  'Ingeniería',
] as const;

export function buscarProgramas(filtros: {
  tipo?: string;
  facultad?: string;
  modalidad?: string;
  texto?: string;
}): Programa[] {
  const { tipo, facultad, modalidad, texto } = filtros ?? {};
  const t = (texto ?? '').toLowerCase().trim();
  const norm = (s: string) => (s ?? '').toLowerCase();
  return PROGRAMAS.filter(
    (p) =>
      (!tipo || p.tipo === tipo) &&
      (!facultad || norm(p.facultad).includes(norm(facultad))) &&
      (!modalidad || norm(p.modalidad) === norm(modalidad)) &&
      (!t || norm(`${p.nombre} ${p.facultad}`).includes(t)),
  );
}
