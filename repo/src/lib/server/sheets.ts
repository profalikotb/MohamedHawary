// Google Sheets source. Three modes (SHEET_SOURCE):
//   google     – Sheets API v4 with a service account (recommended; read-only scope)
//   appsscript – your own Apps Script web app returning {values:[[…]]} (no GCP setup)
//   demo       – generated sample data (DEMO_MODE=1 implies this)
//   push       – nothing is pulled: the clinic desktop pushes Oracle rows to /api/integrations/push
import { clean } from '../envClean';
import { SignJWT, importPKCS8 } from 'jose';
import { demoValues } from './demo';

let token: { v: string; exp: number } | null = null;
const valuesCache = new Map<string, { at: number; v: unknown[][] }>();

export function sheetSource(): 'google' | 'appsscript' | 'demo' | 'push' {
  if (process.env.DEMO_MODE === '1') return 'demo';
  return (process.env.SHEET_SOURCE as any) || 'google';
}

async function accessToken(): Promise<string> {
  if (token && token.exp - 60 > Date.now() / 1000) return token.v;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const pk = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !pk) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY missing');
  const key = await importPKCS8(pk, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/spreadsheets.readonly' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(email).setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!r.ok) throw new Error(`Google auth failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  token = { v: j.access_token, exp: now + j.expires_in };
  return token.v;
}

async function withTimeout(url: string, init: RequestInit, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' }); } finally { clearTimeout(t); }
}

export async function readSheetValues(tab: string, maxAgeMs = 3000): Promise<unknown[][]> {
  const src = sheetSource();
  const ck = `${src}:${tab}`;
  const c = valuesCache.get(ck);
  if (c && Date.now() - c.at < maxAgeMs) return c.v;
  let values: unknown[][];
  if (src === 'demo') values = demoValues();
  else if (src === 'push') throw new Error('SHEET_SOURCE=push: data arrives from the clinic desktop (Queue-Push), nothing to read');
  else if (src === 'appsscript') {
    const rawUrl = clean(process.env.APPS_SCRIPT_FEED_URL);
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec$/.test(rawUrl))
      throw new Error(`APPS_SCRIPT_FEED_URL is not a Web App URL (got "${rawUrl.slice(0, 40)}${rawUrl.length > 40 ? '…' : ''}"). ` +
        'It must look like https://script.google.com/macros/s/…/exec');
    const u = new URL(rawUrl);
    u.searchParams.set('token', clean(process.env.APPS_SCRIPT_FEED_TOKEN));
    if (tab) u.searchParams.set('tab', tab);
    const r = await withTimeout(u.toString(), { redirect: 'follow' });
    if (!r.ok) throw new Error(`Apps Script feed ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error(`Apps Script feed: ${j.error || 'error'}`);
    values = j.values;
  } else {
    const id = process.env.GOOGLE_SHEET_ID;
    if (!id) throw new Error('GOOGLE_SHEET_ID missing');
    const range = tab ? `'${tab.replace(/'/g, "''")}'!A1:AZ` : 'A1:AZ';
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}` +
      `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS`;
    const r = await withTimeout(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (!r.ok) throw new Error(`Sheets API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    values = (await r.json()).values ?? [];
  }
  valuesCache.set(ck, { at: Date.now(), v: values });
  return values;
}
