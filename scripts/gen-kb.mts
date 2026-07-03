import { writeFileSync } from 'node:fs';
import { PROGRAMAS } from '../src/ai/catalog.ts';
import { DETALLES } from '../src/ai/detalles.ts';

// Genera la base de conocimiento (Markdown) para el asistente de voz de Vapi (RAG).
// Una sección por programa; el arancel repite el nombre del programa para minimizar
// que el RAG mezcle precios entre programas de nombre parecido.

const slugOf = (u: string) => u.replace(/\/+$/, '').split('/').pop() ?? u;
const tipoLabel: Record<string, string> = { magister: 'Magíster', diplomado: 'Diplomado', especialidad: 'Especialidad' };

let out =
  `# Catálogo de Postgrados — Universidad Autónoma de Chile\n\n` +
  `Fuente oficial: postgrados.uautonoma.cl. Usa SOLO estos datos para responder sobre programas, aranceles y requisitos. ` +
  `Si un dato no está aquí, dilo y ofrece derivar a un asesor; nunca inventes precios ni fechas.\n\n`;

const byTipo: Record<string, typeof PROGRAMAS> = { magister: [], diplomado: [], especialidad: [] };
for (const p of PROGRAMAS) (byTipo[p.tipo] ??= []).push(p);

for (const tipo of ['magister', 'diplomado', 'especialidad'] as const) {
  const lista = byTipo[tipo] ?? [];
  out += `\n# ${tipoLabel[tipo]}es (${lista.length})\n\n`;
  for (const p of lista) {
    const d: any = DETALLES[slugOf(p.url)] ?? {};
    out += `## ${p.nombre}\n`;
    out += `- Tipo: ${tipoLabel[p.tipo]}\n`;
    if (p.facultad) out += `- Facultad: ${p.facultad}\n`;
    if (p.modalidad) out += `- Modalidad: ${p.modalidad}\n`;
    const dur = d.duracion || p.duracion;
    if (dur) out += `- Duración: ${dur}\n`;
    out += `- Arancel del ${p.nombre}: ${d.arancel ?? 'no publicado (consultar con un asesor)'}\n`;
    out += `- Matrícula del ${p.nombre}: ${d.matricula ?? 'no publicada (consultar con un asesor)'}\n`;
    if (d.requisitos) out += `- Requisitos / dirigido a: ${d.requisitos}\n`;
    if (d.descripcion) out += `- Descripción: ${d.descripcion}\n`;
    if (d.objetivoGeneral) out += `- Objetivo: ${d.objetivoGeneral}\n`;
    if (Array.isArray(d.malla) && d.malla.length) {
      const mods = d.malla.map((s: any) => `${s.semestre}: ${(s.modulos ?? []).join(', ')}`).join(' | ');
      out += `- Malla: ${mods}\n`;
    }
    out += `\n`;
  }
}

const path = new URL('../voice/base-conocimiento-programas.md', import.meta.url);
writeFileSync(path, out, 'utf8');
const n = PROGRAMAS.length;
const conArancel = PROGRAMAS.filter((p) => (DETALLES[slugOf(p.url)] as any)?.arancel).length;
console.log(`OK · ${n} programas escritos · ${conArancel} con arancel · ${out.length} caracteres`);
