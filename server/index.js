// Vibe Arena leaderboard sunucusu
// Railway: DATABASE_URL (Postgres eklentisi) ve SECRET ortam değişkenleri ile çalışır.
// DATABASE_URL yoksa veriyi bellekte tutar (yerel test için).
import http from 'node:http';
import crypto from 'node:crypto';
import { verifyMessage, getAddress, isAddress } from 'viem';

const PORT = process.env.PORT || 8080;
const SECRET = process.env.SECRET || 'dev-secret-change-me';
const ORIGINS = (process.env.ORIGINS || 'https://vibe-nine-woad.vercel.app,http://localhost:8765').split(',').map(s => s.trim());

// ---- skor kuralları (oyundaki formülle aynı, sunucu üst sınırı kontrol eder)
const MAPS = { classic: 1, neon: 2, street: 3, court: 4, school: 5 };
const STAGES = 5;
const stageMax = (s, m) => Math.round((100 + 40 * s) * m * 1.5) + 100; // tam can + en hızlı bitiriş
const runMax = (stages, m, champ) => { let t = 0; for (let s = 0; s < stages; s++) t += stageMax(s, m); return t + (champ ? 1000 * m : 0); };
const MIN_STAGE_MS = 12000; // bir aşama 12 saniyeden kısa sürmez

// ISO hafta anahtarı, ör. 2026-W41 (haftalık sıralama pazartesi sıfırlanır)
function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, '0')}`;
}

// ---- veri katmanı: Postgres ya da bellek
let db;
if (process.env.DATABASE_URL) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } });
  await pool.query(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, addr TEXT NOT NULL, started_at BIGINT NOT NULL, ended_at BIGINT,
    map TEXT, stages INT, score INT, champ BOOLEAN DEFAULT FALSE, week TEXT)`);
  await pool.query('CREATE INDEX IF NOT EXISTS runs_week_score ON runs (week, score DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS runs_addr ON runs (addr)');
  await pool.query('CREATE TABLE IF NOT EXISTS names (addr TEXT PRIMARY KEY, name TEXT NOT NULL, lname TEXT UNIQUE NOT NULL)');
  db = {
    async start(id, addr, t) { await pool.query('INSERT INTO runs (id, addr, started_at) VALUES ($1,$2,$3)', [id, addr, t]); },
    async get(id) { const r = await pool.query('SELECT * FROM runs WHERE id=$1', [id]); return r.rows[0]; },
    async end(id, v) { await pool.query('UPDATE runs SET ended_at=$2, map=$3, stages=$4, score=$5, champ=$6, week=$7 WHERE id=$1 AND ended_at IS NULL', [id, v.ended_at, v.map, v.stages, v.score, v.champ, v.week]); },
    async board(week, limit) {
      const r = await pool.query(`SELECT DISTINCT ON (addr) addr, score, map, champ, stages FROM runs
        WHERE ended_at IS NOT NULL ${week ? 'AND week=$1' : ''} ORDER BY addr, score DESC`, week ? [week] : []);
      return r.rows.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    async names(addrs) { if (!addrs.length) return {}; const r = await pool.query('SELECT addr, name FROM names WHERE addr = ANY($1)', [addrs]); return Object.fromEntries(r.rows.map(x => [x.addr, x.name])); },
    async setName(addr, name) {
      const lname = name.toLowerCase();
      const t = await pool.query('SELECT addr FROM names WHERE lname=$1', [lname]);
      if (t.rows[0] && t.rows[0].addr !== addr) return false;
      await pool.query('INSERT INTO names (addr, name, lname) VALUES ($1,$2,$3) ON CONFLICT (addr) DO UPDATE SET name=$2, lname=$3', [addr, name, lname]);
      return true;
    },
    async best(addr, week) {
      const r = await pool.query(`SELECT MAX(score) AS s FROM runs WHERE addr=$1 AND ended_at IS NOT NULL ${week ? 'AND week=$2' : ''}`, week ? [addr, week] : [addr]);
      return Number(r.rows[0].s) || 0;
    }
  };
} else {
  const runs = new Map(), nm = new Map();
  db = {
    async names(addrs) { return Object.fromEntries(addrs.filter(a => nm.has(a)).map(a => [a, nm.get(a)])); },
    async setName(addr, name) { for (const [a, n] of nm) if (a !== addr && n.toLowerCase() === name.toLowerCase()) return false; nm.set(addr, name); return true; },
    async start(id, addr, t) { runs.set(id, { id, addr, started_at: t }); },
    async get(id) { return runs.get(id); },
    async end(id, v) { const r = runs.get(id); if (r && !r.ended_at) Object.assign(r, v); },
    async board(week, limit) {
      const best = new Map();
      for (const r of runs.values()) if (r.ended_at && (!week || r.week === week)) { const b = best.get(r.addr); if (!b || r.score > b.score) best.set(r.addr, r); }
      return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ addr, score, map, champ, stages }) => ({ addr, score, map, champ, stages }));
    },
    async best(addr, week) { let m = 0; for (const r of runs.values()) if (r.addr === addr && r.ended_at && (!week || r.week === week)) m = Math.max(m, r.score); return m; }
  };
  console.log('DATABASE_URL yok: veriler bellekte tutuluyor');
}

// ---- oturum: cüzdan imzası ile giriş, HMAC jeton
const nonces = new Map(); // addr -> {nonce, exp}
const lastStart = new Map(); // addr -> ms (hız sınırı)
const msgFor = (addr, nonce) => `Vibe Arena leaderboard\n\nSign in to save your scores. This does not cost gas.\n\nAddress: ${addr}\nNonce: ${nonce}`;
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const makeToken = addr => { const body = `${addr}.${Date.now() + 7 * 864e5}`; return `${body}.${sign(body)}`; };
function readToken(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [addr, exp, sig] = t.split('.');
  if (!addr || !exp || !sig) return null;
  const good = sign(`${addr}.${exp}`);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Date.now() > Number(exp)) return null;
  return addr;
}

// ---- takma isim kuralları
const BAD = ['fuck','shit','bitch','nigg','cunt','rape','nazi','hitler','porn','pussy','orospu','yarrak','admin','vibevibe','official','support','moderator'];
function cleanName(s) {
  const n = String(s || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) return { error: '3-16 letters, numbers or _' };
  const l = n.toLowerCase().replace(/_/g, '');
  if (BAD.some(b => l.includes(b))) return { error: 'name not allowed' };
  return { name: n };
}

// ---- http yardımcıları
function send(res, req, code, data) {
  const o = req.headers.origin;
  const h = { 'content-type': 'application/json', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS', vary: 'origin' };
  if (o && (ORIGINS.includes(o) || ORIGINS.includes('*'))) h['access-control-allow-origin'] = o;
  res.writeHead(code, h); res.end(data === undefined ? '' : JSON.stringify(data));
}
const body = req => new Promise((ok, bad) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 4096) { bad(new Error('too big')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
});
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;

const routes = {
  'GET /health': async () => [200, { ok: true, week: weekKey() }],
  'GET /auth/nonce': async (req, url) => {
    const a = url.searchParams.get('addr') || '';
    if (!isAddress(a)) return [400, { error: 'bad address' }];
    const addr = getAddress(a), nonce = crypto.randomBytes(12).toString('hex');
    nonces.set(addr, { nonce, exp: Date.now() + 5 * 60e3 });
    return [200, { message: msgFor(addr, nonce) }];
  },
  'POST /auth/verify': async req => {
    const { addr: a, signature } = await body(req);
    if (!isAddress(a || '') || typeof signature !== 'string') return [400, { error: 'bad input' }];
    const addr = getAddress(a), n = nonces.get(addr);
    if (!n || Date.now() > n.exp) return [400, { error: 'nonce expired' }];
    nonces.delete(addr);
    const ok = await verifyMessage({ address: addr, message: msgFor(addr, n.nonce), signature }).catch(() => false);
    if (!ok) return [401, { error: 'bad signature' }];
    return [200, { token: makeToken(addr), addr }];
  },
  'POST /run/start': async req => {
    const addr = readToken(req); if (!addr) return [401, { error: 'login' }];
    const now = Date.now();
    if (now - (lastStart.get(addr) || 0) < 5000) return [429, { error: 'slow down' }];
    lastStart.set(addr, now);
    const id = crypto.randomUUID(); await db.start(id, addr, now);
    return [200, { runId: id }];
  },
  'POST /run/end': async req => {
    const addr = readToken(req); if (!addr) return [401, { error: 'login' }];
    const { runId, map, stages, score, champ } = await body(req);
    const run = runId && await db.get(String(runId));
    if (!run || run.addr !== addr) return [404, { error: 'no run' }];
    if (run.ended_at) return [409, { error: 'already saved' }];
    const m = MAPS[map], st = Number(stages), sc = Number(score), ch = !!champ;
    if (!m || !Number.isInteger(st) || st < 0 || st > STAGES || !Number.isInteger(sc) || sc < 0) return [400, { error: 'bad input' }];
    if (ch && st !== STAGES) return [400, { error: 'bad input' }];
    if (sc > runMax(st, m, ch)) return [400, { error: 'score too high' }];
    const now = Date.now();
    if (st > 0 && now - Number(run.started_at) < st * MIN_STAGE_MS) return [400, { error: 'too fast' }];
    const week = weekKey();
    await db.end(String(runId), { ended_at: now, map, stages: st, score: sc, champ: ch, week });
    const board = await db.board(week, 1000), rank = board.findIndex(r => r.addr === addr) + 1;
    return [200, { ok: true, rank, best: await db.best(addr, week), week }];
  },
  'POST /name': async req => {
    const addr = readToken(req); if (!addr) return [401, { error: 'login' }];
    const { name } = await body(req), c = cleanName(name);
    if (c.error) return [400, { error: c.error }];
    if (!(await db.setName(addr, c.name))) return [409, { error: 'name taken' }];
    return [200, { ok: true, name: c.name }];
  },
  'GET /name': async (req, url) => {
    const a = url.searchParams.get('addr') || ''; if (!isAddress(a)) return [400, { error: 'bad address' }];
    const addr = getAddress(a); return [200, { name: (await db.names([addr]))[addr] || null }];
  },
  'GET /leaderboard': async (req, url) => {
    const scope = url.searchParams.get('scope') === 'all' ? null : weekKey();
    const rows = await db.board(scope, 50);
    const me = url.searchParams.get('addr');
    let mine = null;
    if (me && isAddress(me)) {
      const a = getAddress(me), all = await db.board(scope, 100000), i = all.findIndex(r => r.addr === a);
      const myName = (await db.names([a]))[a];
      mine = i >= 0 ? { rank: i + 1, ...all[i], name: myName || short(a), nick: myName || null } : { rank: null, nick: myName || null };
    }
    const N = await db.names(rows.map(r => r.addr));
    return [200, { week: weekKey(), scope: scope ? 'week' : 'all', rows: rows.map((r, i) => ({ rank: i + 1, name: N[r.addr] || short(r.addr), nick: !!N[r.addr], short: short(r.addr), addr: r.addr, score: r.score, map: r.map, champ: r.champ, stages: r.stages })), me: mine }];
  }
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, req, 204);
  const url = new URL(req.url, 'http://x'), fn = routes[`${req.method} ${url.pathname}`];
  if (!fn) return send(res, req, 404, { error: 'not found' });
  try { const [code, data] = await fn(req, url); send(res, req, code, data); }
  catch (e) { console.error(e); send(res, req, 500, { error: 'server error' }); }
}).listen(PORT, () => console.log(`leaderboard on :${PORT}, week ${weekKey()}`));
