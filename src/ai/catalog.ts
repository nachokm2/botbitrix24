// Catálogo de programas (DATOS DE EJEMPLO para el PoC).
// En producción se reemplaza por la fuente real (SPA de Bitrix o API académica).
export type Programa = {
  nombre: string;
  area: 'negocios' | 'salud' | 'educacion' | 'ingenieria' | 'derecho';
  modalidad: 'online' | 'presencial' | 'semipresencial';
  duracion: string;
  descripcion: string;
};

export const PROGRAMAS: Programa[] = [
  {
    nombre: 'MBA - Magíster en Administración de Empresas',
    area: 'negocios',
    modalidad: 'semipresencial',
    duracion: '18 meses',
    descripcion: 'Formación en gestión, finanzas, estrategia y liderazgo para profesionales.',
  },
  {
    nombre: 'Diplomado en Gestión de Proyectos',
    area: 'negocios',
    modalidad: 'online',
    duracion: '6 meses',
    descripcion: 'Metodologías ágiles y tradicionales para la dirección de proyectos.',
  },
  {
    nombre: 'Magíster en Gestión en Salud',
    area: 'salud',
    modalidad: 'semipresencial',
    duracion: '24 meses',
    descripcion: 'Administración de instituciones y servicios de salud.',
  },
  {
    nombre: 'Magíster en Educación',
    area: 'educacion',
    modalidad: 'online',
    duracion: '18 meses',
    descripcion: 'Innovación curricular, evaluación y liderazgo educativo.',
  },
  {
    nombre: 'Magíster en Derecho Laboral',
    area: 'derecho',
    modalidad: 'presencial',
    duracion: '24 meses',
    descripcion: 'Relaciones laborales, seguridad social y litigación laboral.',
  },
  {
    nombre: 'Magíster en Ingeniería Informática',
    area: 'ingenieria',
    modalidad: 'online',
    duracion: '24 meses',
    descripcion: 'Arquitectura de software, datos e inteligencia artificial aplicada.',
  },
];

export function buscarProgramas(filtros: { area?: string; modalidad?: string; texto?: string }): Programa[] {
  const { area, modalidad, texto } = filtros ?? {};
  const t = (texto ?? '').toLowerCase();
  return PROGRAMAS.filter(
    (p) =>
      (!area || p.area === area) &&
      (!modalidad || p.modalidad === modalidad) &&
      (!t || `${p.nombre} ${p.descripcion} ${p.area}`.toLowerCase().includes(t)),
  );
}
