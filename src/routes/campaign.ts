import type { Request, Response } from 'express';
import { getProgram } from '../campaign/programRegistry';
import { enrolarPrograma } from '../campaign/orchestrator';
import { dbCampaignCounts } from '../store/db';
import { getState, EMPTY_AUTH } from '../store';
import { log } from '../log';

// Rutas admin de la campaña de voz saliente (montadas bajo requireAdminToken en index.ts).

/** POST /campaign/enroll?program=MMD — enrola los deals del embudo del programa en la campaña. */
export async function campaignEnroll(req: Request, res: Response) {
  const code = String((req.query.program as string) ?? (req.body as any)?.program ?? 'MMD');
  const pc = getProgram(code);
  if (!pc) return res.status(400).json({ ok: false, error: `programa desconocido: ${code}` });
  const st = await getState();
  const auth = st.auth ?? EMPTY_AUTH;
  try {
    const r = await enrolarPrograma(pc, auth);
    return res.json({ ok: true, program: pc.code, activo: pc.activo, ...r });
  } catch (e) {
    log.error('campaignEnroll error', { err: String(e) });
    return res.status(502).json({ ok: false, error: String(e) });
  }
}

/** GET /campaign/status?program=MMD — conteo de targets por estado (para monitoreo). */
export async function campaignStatus(req: Request, res: Response) {
  const code = String((req.query.program as string) ?? 'MMD');
  const pc = getProgram(code);
  if (!pc) return res.status(400).json({ ok: false, error: `programa desconocido: ${code}` });
  const counts = await dbCampaignCounts(pc.code);
  return res.json({
    ok: true,
    program: pc.code,
    nombre: pc.nombre,
    activo: pc.activo,
    categoryId: pc.bitrix.categoryId,
    agenda: { waves: pc.agenda.waves, maxPorDia: pc.agenda.maxPorDia, maxDias: pc.agenda.maxDias, maxTotal: pc.agenda.maxTotal, tz: pc.agenda.tz },
    counts,
  });
}
