import { rpc } from './db';
import { getClinics, getSheetConfig } from './settings';
import { readSheetValues, sheetSource } from './sheets';
import { parseSheet } from '../sheetParse';
import { cairoDate } from '../time';
import type { ClinicRef, SheetConfig } from '../config';

export interface SyncReport { ok: boolean; skipped?: boolean; clinics: Record<string, any>; stats?: any; missing?: string[]; error?: string; source?: string }

/** Apply one table of booking rows (header row + data) to the given clinics' queues for `today`. */
export async function applyValues(values: unknown[][], cfg: SheetConfig, clinics: ClinicRef[], targets: string[], today: string) {
  const parsed = parseSheet(values, cfg, clinics, today);
  if (parsed.map.date < 0 || parsed.map.name < 0) throw new Error(`لم يتم التعرف على أعمدة: ${parsed.missing.join(', ')}`);
  const out: Record<string, any> = {};
  for (const id of targets) {
    const rows = parsed.rowsByClinic[id] ?? [];
    out[id] = await rpc('queue_sync', { p_clinic: id, p_date: today, p_rows: rows, p_complete: true });
    // already examined in Oracle → done in the queue (migration 003)
    const seenKeys = rows.filter((r: any) => r.seen).map((r: any) => r.booking_key);
    if (seenKeys.length) {
      try { out[id].seen_done = await rpc('queue_mark_seen', { p_clinic: id, p_date: today, p_keys: seenKeys }); }
      catch (e: any) { out[id].seen_error = String(e?.message || e); }
    }
    // Oracle = source of truth for numbers and list (migration 004)
    try { out[id].mirrored = await rpc('queue_mirror_sheet', { p_clinic: id, p_date: today }); }
    catch (e: any) { out[id].mirror_error = String(e?.message || e); }
  }
  return { out, parsed };
}

/** One sheet read feeds every clinic. Throttled per clinic in the DB so N open dashboards ≠ N reads.
 *  SHEET_SOURCE=push → nothing to pull: the clinic desktop pushes to /api/integrations/push. */
export async function syncAll(force = false): Promise<SyncReport> {
  if (sheetSource() === 'push') return { ok: true, skipped: true, clinics: {}, source: 'push' };
  const today = cairoDate();
  const clinics = (await getClinics()).filter((c) => c.active);
  const claimed: string[] = [];
  for (const c of clinics) {
    if (await rpc<boolean>('sync_claim', { p_clinic: c.id, p_date: today, p_min_seconds: force ? 2 : 8 })) claimed.push(c.id);
  }
  if (!claimed.length) return { ok: true, skipped: true, clinics: {} };
  try {
    const cfg = await getSheetConfig();
    const values = await readSheetValues(cfg.tab, force ? 0 : 3000);
    const { out, parsed } = await applyValues(values, cfg, clinics, claimed, today);
    return { ok: true, clinics: out, stats: parsed.stats, missing: parsed.missing };
  } catch (e: any) {
    const msg = String(e?.message || e);
    await Promise.all(claimed.map((id) => rpc('sync_fail', { p_clinic: id, p_date: today, p_error: msg }).catch(() => {})));
    return { ok: false, clinics: {}, error: msg };
  }
}
