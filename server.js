// Option Radar server: polls option chains in the background, scores contracts, serves a JSON API and the static UI,
// and sends Telegram alerts. Dependencies: yahoo-finance2 only (HTTP server, gzip and auth use Node built-ins).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { finish } from './lib/score.js';
import { isMarketOpen } from './lib/market.js';
import { makeTelegram } from './lib/telegram.js';

const DEFAULT_SYMBOLS = 'NVDA,AAPL,MSFT,AMZN,GOOGL,META,TSLA,AMD,AVGO,NFLX,ORCL,CRM,PLTR,COIN,MU,INTC,ARM,UBER,JPM,BAC,V,LLY,COST,WMT,BA,SPY,QQQ';
const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

const cfg = {
  port: num(env.PORT, 8080),
  provider: env.PROVIDER || 'yahoo',
  password: env.ACCESS_PASSWORD || '',
  publicUrl: env.PUBLIC_URL || '',
  symbols: (env.SYMBOLS || DEFAULT_SYMBOLS).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean),
  maxSymbols: num(env.MAX_SYMBOLS, 60),
  refreshSec: num(env.REFRESH_SEC, 180),
  closedRefreshSec: num(env.CLOSED_REFRESH_SEC, 1800),
  delayMs: num(env.REQUEST_DELAY_MS, 350),
  maxDte: num(env.SCAN_MAX_DTE, 45),
  maxExpiries: num(env.SCAN_MAX_EXPIRIES, 6),
  alert: {
    score: num(env.ALERT_SCORE, 80), ratio: num(env.ALERT_RATIO, 1.5), minVol: num(env.ALERT_MIN_VOL, 1000),
    maxDist: num(env.ALERT_MAX_DIST, 8), maxDte: num(env.ALERT_MAX_DTE, 30), maxPerCycle: num(env.ALERT_MAX_PER_CYCLE, 8),
  },
};

const log = (level, msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
const provider = await import(cfg.provider === 'demo' ? './providers/demo.js' : './providers/yahoo.js');
const telegram = makeTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

// ---------- state ----------
const universe = new Set(cfg.symbols.filter((s) => SYM_RE.test(s)).slice(0, cfg.maxSymbols));
const store = new Map(); // sym -> { ts, spot, rows (scored), err }
const seen = new Set();
let seenDay = '';
let firstCycle = true;
let lastCycleAt = 0;
let backoffMs = 0;
let stopping = false;

// All provider calls run one at a time so background cycles and on-demand fetches never overlap.
let queue = Promise.resolve();
const enqueue = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

async function refreshSymbol(sym) {
  try {
    const { spot, rows } = await provider.fetchSymbol(sym, { maxDte: cfg.maxDte, maxExpiries: cfg.maxExpiries });
    const scored = rows.filter((r) => r.vol > 0 && r.strike > 0).map((r) => finish(r, spot));
    store.set(sym, { ts: Date.now(), spot, rows: scored, err: null });
    backoffMs = 0;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 160);
    const prev = store.get(sym);
    store.set(sym, { ts: prev?.ts || 0, spot: prev?.spot || 0, rows: prev?.rows || [], err: msg });
    log('warn', 'fetch_failed', { sym, err: msg });
    if (/429|too many|rate/i.test(msg)) { backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), 300_000); log('warn', 'backoff', { ms: backoffMs }); }
  }
}

async function cycle() {
  for (const sym of [...universe]) {
    if (stopping) return;
    await enqueue(() => refreshSymbol(sym));
    await sleep(cfg.delayMs + backoffMs);
  }
  lastCycleAt = Date.now();
  await evaluateAlerts();
  log('info', 'cycle_done', { symbols: universe.size, contracts: [...store.values()].reduce((a, s) => a + s.rows.length, 0) });
}

let wake = null;
async function loop() {
  while (!stopping) {
    try { await cycle(); } catch (e) { log('error', 'cycle_error', { err: String(e?.message || e) }); }
    const secs = isMarketOpen() ? cfg.refreshSec : cfg.closedRefreshSec;
    await new Promise((r) => { wake = r; setTimeout(r, secs * 1000); });
  }
}

// ---------- alerts ----------
async function evaluateAlerts() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== seenDay) { seen.clear(); seenDay = day; }
  const a = cfg.alert, hits = [];
  for (const s of store.values()) {
    for (const r of s.rows) {
      if (r.score >= a.score && r.voloi >= a.ratio && r.vol >= a.minVol && Math.abs(r.dist) <= a.maxDist && r.dte <= a.maxDte && !seen.has(r.key)) {
        seen.add(r.key); hits.push(r);
      }
    }
  }
  if (firstCycle) { firstCycle = false; return; } // seed silently so a restart does not re-send the whole day
  if (!hits.length || !telegram.enabled) return;
  hits.sort((x, y) => y.score - x.score);
  const f = (x) => Number(x).toLocaleString('en-US');
  for (const r of hits.slice(0, a.maxPerCycle)) {
    const text = `زخم على ${r.sym}\n${r.type === 'C' ? 'Call' : 'Put'} ${r.strike} · ${r.exp} (${r.dte} يوم) · ${r.mny}\nالسعر الحالي ${r.spot} · البعد ${r.dist > 0 ? '+' : ''}${r.dist}%\nالحجم ${f(r.vol)} · OI ${f(r.oi)} · حجم/OI ${r.voloi}\nقيمة التداول $${f(r.value)} · الزخم ${r.score}${cfg.publicUrl ? '\n' + cfg.publicUrl : ''}`;
    await telegram.send(text);
    await sleep(400);
  }
  if (hits.length > a.maxPerCycle) await telegram.send(`و ${hits.length - a.maxPerCycle} عقود أخرى تجاوزت الشروط في هذا التحديث.`);
}

// ---------- http ----------
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const SEC = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const hits = new Map();
function limited(ip) {
  const now = Date.now(), e = hits.get(ip);
  if (!e || e.reset < now) { hits.set(ip, { n: 1, reset: now + 60_000 }); return false; }
  return ++e.n > 120;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();

function authorized(req) {
  if (!cfg.password) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const given = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(cfg.password).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(req, res, status, body, headers = {}) {
  const buf = Buffer.from(body);
  const h = { ...SEC, ...headers };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const z = zlib.gzipSync(buf); res.writeHead(status, { ...h, 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': z.length }); res.end(z);
  } else { res.writeHead(status, { ...h, 'content-length': buf.length }); res.end(buf); }
}
const json = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });

function apiScan(req, res, url) {
  const asked = (url.searchParams.get('symbols') || '').toUpperCase().split(/[\s,;]+/).filter((s) => SYM_RE.test(s)).slice(0, cfg.maxSymbols);
  const syms = asked.length ? asked : [...universe];
  const rejected = [];
  for (const s of syms) {
    if (universe.has(s)) continue;
    if (universe.size >= cfg.maxSymbols) { rejected.push(s); continue; }
    universe.add(s);
    enqueue(() => refreshSymbol(s)); // fetch immediately instead of waiting for the next cycle
  }
  const minVol = Math.max(0, num(url.searchParams.get('minVol'), 100));
  const limit = Math.min(10_000, Math.max(100, num(url.searchParams.get('limit'), 6000)));
  const rows = [], spots = {}, errors = {}, pending = [];
  let asOf = 0;
  for (const s of syms) {
    const e = store.get(s);
    if (!e || !e.ts) { if (e?.err) errors[s] = e.err; else pending.push(s); continue; }
    spots[s] = e.spot; asOf = Math.max(asOf, e.ts);
    if (e.err) errors[s] = e.err;
    for (const r of e.rows) if (r.vol >= minVol) rows.push(r);
  }
  rows.sort((a, b) => b.score - a.score);
  json(req, res, 200, {
    asOf, provider: cfg.provider, delayedMin: cfg.provider === 'yahoo' ? 15 : 0, marketOpen: isMarketOpen(),
    refreshSec: isMarketOpen() ? cfg.refreshSec : cfg.closedRefreshSec, telegram: telegram.enabled,
    total: rows.length, rows: rows.slice(0, limit), spots, pending, errors, rejected,
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(req, res, 403, 'forbidden');
  try {
    const data = await fs.readFile(file);
    send(req, res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  } catch { send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') return json(req, res, 200, { ok: true, uptimeSec: Math.round(process.uptime()), lastCycleAt, symbols: universe.size });
    if (!authorized(req)) return send(req, res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="Option Radar", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'method not allowed');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (url.pathname.startsWith('/api/')) {
      if (limited(ip)) return json(req, res, 429, { error: 'rate_limited' });
      if (url.pathname === '/api/scan') return apiScan(req, res, url);
      return json(req, res, 404, { error: 'not_found' });
    }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    log('error', 'request_error', { err: String(e?.message || e) });
    try { json(req, res, 500, { error: 'internal' }); } catch {}
  }
});

server.listen(cfg.port, () => {
  log('info', 'listening', { port: cfg.port, provider: cfg.provider, symbols: universe.size, telegram: telegram.enabled, auth: Boolean(cfg.password) });
  loop();
});

function shutdown(sig) {
  log('info', 'shutdown', { sig }); stopping = true; if (wake) wake();
  server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
