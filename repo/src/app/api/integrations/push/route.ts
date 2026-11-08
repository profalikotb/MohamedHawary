// Clinic desktop → queue. The Windows task "Queue-Push" reads today's list from the LOCAL Oracle
// and posts it here (outbound HTTPS only: no router ports, no public IP, Oracle never exposed).
//
// POST /api/integrations/push      header  X-Queue-Token: <QUEUE_API_TOKEN>
// { "source": "DRALIKOTB", "date": "2026-11-08",
//   "rows": [ { "call_no":1, "booking_id":"28838", "date":"08/11/2026", "clinic":"مصر الجديدة",
//               "name":"…", "phone":"…", "kind":"استشارة", "seen":true, "patient_code":"2" }, … ] }
import { timingSafeEqual } from 'node:crypto';
import { handle, json, HttpError } from '@/lib/server/http';
import { rpc } from '@/lib/server/db';
import { getClinics, getSheetConfig } from '@/lib/server/settings';
import { applyValues } from '@/lib/server/sync';
import { parseSheet } from '@/lib/sheetParse';
import { cairoDate } from '@/lib/time';
import { clean } from '@/lib/envClean';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = ['رقم النداء', 'رقم الحجز', 'التاريخ', 'العيادة', 'اسم المريض', 'التليفون', 'نوع الكشف', 'الحالة', 'كود المريض'];
const S = (v: unknown, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));

function checkToken(req: Request) {
  const want = clean(process.env.QUEUE_API_TOKEN);
  if (!want || want.length < 16) throw new HttpError(500, 'QUEUE_API_TOKEN not configured (16+ characters)');
  const got = Buffer.from(clean(req.headers.get('x-queue-token'))), exp = Buffer.from(want);
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) throw new HttpError(401, 'bad_token');
}

export const POST = handle(async (req) => {
  checkToken(req);
  const b = await req.json().catch(() => null);
  if (!b || !Array.isArray(b.rows)) throw new HttpError(400, 'bad_json');
  if (b.rows.length > 2000) throw new HttpError(413, 'too_many_rows');

  const today = cairoDate();
  if (b.date && String(b.date) !== today) {
    // the desktop clock disagrees with Cairo time → refuse, never write another day's list into today
    return json({ ok: false, error: 'wrong_date', detail: `desktop date ${b.date} ≠ Cairo date ${today} – fix the PC clock` }, 409);
  }

  const values: unknown[][] = [HEADERS, ...b.rows.map((r: any) => [
    S(r.call_no, 6), S(r.booking_id, 30), S(r.date, 10), S(r.clinic, 60), S(r.name, 120),
    S(r.phone, 40), S(r.kind, 40), r.seen ? 'تم الكشف' : '', S(r.patient_code, 30),
  ])];

  const clinics = (await getClinics()).filter((c) => c.active);
  const cfg = { ...(await getSheetConfig()), headerRow: 1, mapping: {} };   // fixed layout → auto-detect
  // only clinics that actually have rows in this push are touched (a Friday push never empties Heliopolis)
  const pre = parseSheet(values, cfg, clinics, today);
  const targets = Object.entries(pre.rowsByClinic).filter(([, rows]) => (rows as any[]).length > 0).map(([id]) => id);
  if (!targets.length) return json({ ok: true, source: S(b.source, 40) || 'desktop', date: today, rows: b.rows.length,
    clinics: {}, note: 'no rows for a queue clinic today (e.g. Monday / Wadi El Nil, or no bookings yet)' });

  for (const id of targets) await rpc('sync_claim', { p_clinic: id, p_date: today, p_min_seconds: 0 });
  try {
    const { out, parsed } = await applyValues(values, cfg, clinics, targets, today);
    return json({ ok: true, source: S(b.source, 40) || 'desktop', date: today, rows: b.rows.length,
      clinics: Object.fromEntries(Object.entries(out).map(([k, v]: any) => [k, {
        inserted: v.inserted, updated: v.updated, removed: v.removed, seen_done: v.seen_done ?? 0, mirrored: v.mirrored ?? 0 }])),
      unknown_clinic: parsed.stats?.unknownClinic ?? 0 });
  } catch (e: any) {
    const msg = String(e?.message || e);
    await Promise.all(targets.map((id) => rpc('sync_fail', { p_clinic: id, p_date: today, p_error: msg }).catch(() => {})));
    throw new HttpError(422, msg);
  }
});
