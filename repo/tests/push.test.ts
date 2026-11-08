import { describe, it, expect } from 'vitest';
import { parseSheet } from '../src/lib/sheetParse';
import { DEFAULT_SHEET_CONFIG, type ClinicRef } from '../src/lib/config';

const clinics: ClinicRef[] = [
  { id: 'heliopolis', name_ar: 'عيادة مصر الجديدة', name_en: 'Heliopolis Clinic', sheet_aliases: ['مصر الجديدة', 'مصر الجديده'], active: true, sort: 1 },
  { id: 'toukh', name_ar: 'عيادة طوخ', name_en: 'Toukh Clinic', sheet_aliases: ['طوخ'], active: true, sort: 2 },
];
const HEADERS = ['رقم النداء', 'رقم الحجز', 'التاريخ', 'العيادة', 'اسم المريض', 'التليفون', 'نوع الكشف', 'الحالة', 'كود المريض'];

describe('pushed desktop rows', () => {
  it('route to the right clinic with call numbers and seen flags', () => {
    const values = [HEADERS,
      ['1', '28838', '08/11/2026', 'مصر الجديدة', 'أحمد على عاشور', '013/2700883', 'استشارة', 'تم الكشف', '2'],
      ['2', '28839', '08/11/2026', 'مصر الجديدة', 'أحمد السيد على علام', '', 'استشارة', '', '10']];
    const p = parseSheet(values, { ...DEFAULT_SHEET_CONFIG, headerRow: 1, mapping: {} }, clinics, '2026-11-08');
    const h = p.rowsByClinic.heliopolis;
    expect(h.map((r) => [r.booking_id, r.call_no, !!r.seen])).toEqual([['28838', 1, true], ['28839', 2, false]]);
    expect(p.rowsByClinic.toukh).toBeUndefined();
  });
});
