const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '25mb' })); // MULTI_SKRIN_V1: до 4 скриншотов
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// RENDER_PG_V1: баги хранятся в Render Postgres (таблица lavrik_bugs), Supabase больше не используется.
const DATABASE_URL = process.env.DATABASE_URL || '';
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: /\.render\.com/.test(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 5
}) : null;
if (pool) pool.on('error', e => console.error('pg pool error:', e.message));

let _dbReady = null;
function dbReady(){
  if (!pool) return Promise.reject(new Error('DATABASE_URL not set'));
  if (!_dbReady) {
    _dbReady = pool.query(`CREATE TABLE IF NOT EXISTS lavrik_bugs (
      id SERIAL PRIMARY KEY,
      razdel TEXT,
      chto TEXT,
      kak TEXT,
      ssylka TEXT,
      vazhnost TEXT,
      skrin TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`).catch(e => { _dbReady = null; throw e; });
  }
  return _dbReady;
}

const BUG_COLS = 'id,razdel,chto,kak,ssylka,vazhnost,skrin,status,created_at';

async function dbSelectBugs(){
  await dbReady();
  const r = await pool.query(`SELECT ${BUG_COLS} FROM lavrik_bugs ORDER BY created_at DESC, id DESC`);
  return r.rows;
}

async function dbInsertBug(p){
  await dbReady();
  const r = await pool.query(
    `INSERT INTO lavrik_bugs (razdel,chto,kak,ssylka,vazhnost,skrin,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${BUG_COLS}`,
    [p.razdel || '', p.chto || '', p.kak || '', p.ssylka || '', p.vazhnost || '', p.skrin || null, p.status || 'new']
  );
  return r.rows[0];
}

async function dbUpdateStatus(id, status){
  await dbReady();
  const r = await pool.query('UPDATE lavrik_bugs SET status=$1 WHERE id=$2 RETURNING id', [status, id]);
  return r.rowCount;
}

function friendlyErr(e){
  const m = String((e && e.message) || e);
  if (/DATABASE_URL not set|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Connection terminated|timeout/i.test(m)) {
    return 'База багов сейчас недоступна. Скопируй текст бага и напиши Виктору.';
  }
  return m;
}

// GitHub: дублирование багов в Issues, чтобы агент видел их через GitHub
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || 'victorkrivenko4949-commits/lavrik-bugs';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// BUGS_PASSWORD_V1: пароль формы. Без него баги не принимаются (fail closed).
const BUGS_PASSWORD = process.env.BUGS_PASSWORD || '';
function badPassword(v){
  return !BUGS_PASSWORD || String(v || '').trim() !== BUGS_PASSWORD;
}

const IMG_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

const SKRIN_MAX_FILE = 4 * 1024 * 1024;
const SKRIN_MAX_COUNT = 4;
const SKRIN_MAX_TOTAL = 16 * 1024 * 1024;
function skrinBytes(s){
  const m = /^data:image\/[a-z+]+;base64,/.exec(s || '');
  if (!m) return -1;
  return Math.floor((s.length - m[0].length) * 3 / 4);
}
function sanitizeSkrins(v){
  const arr = Array.isArray(v) ? v : [v];
  if (arr.filter(Boolean).length > SKRIN_MAX_COUNT) {
    throw new Error('Не больше ' + SKRIN_MAX_COUNT + ' скриншотов за раз — убери лишние');
  }
  const clean = [];
  arr.forEach((s, i) => {
    if (!s) return;
    if (!IMG_RE.test(s)) throw new Error('Скриншот №' + (i + 1) + ' повреждён или не картинка');
    const bytes = skrinBytes(s);
    if (bytes > SKRIN_MAX_FILE) throw new Error('Скриншот №' + (i + 1) + ' больше 4 МБ — уменьши');
    clean.push({ s, bytes });
  });
  if (clean.reduce((a, c) => a + c.bytes, 0) > SKRIN_MAX_TOTAL) {
    throw new Error('Скриншоты вместе больше 16 МБ — отправь меньшим числом');
  }
  if (!clean.length) return null;
  const imgs = clean.map(c => c.s);
  if (imgs.length === 1) return imgs[0];
  return JSON.stringify(imgs);
}

function sanitizeUrl(v){
  if (!v || typeof v !== 'string') return '';
  const s = v.slice(0,500);
  if (/^https?:\/\//.test(s)) return s;
  return '';
}

function sanitizeText(v, max=5000){
  if (!v || typeof v !== 'string') return '';
  return v.slice(0, max);
}

// ---------- GitHub Issues ----------
const MARK = id => `<!-- lavrik-bug-id:${id} -->`;

function ghHeaders(){
  return {
    'Authorization': 'Bearer ' + GH_TOKEN,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'lavrik-bugs'
  };
}

function issueTitle(b){
  const t = String(b.chto || '').replace(/\s+/g,' ').trim();
  return `[Баг #${b.id}] ${b.razdel || 'Другое'}: ${t.slice(0,70)}${t.length>70?'…':''}`;
}

const BUG_TYPES = ['Ошибка','Дизайн','Съелся текст','Неправильная задача','Что-то пропало','Тормозит','Другое'];
function issueTip(b){
  const m = /^\[([^\]]{1,40})\]\s/.exec(String(b.chto || ''));
  return (m && BUG_TYPES.includes(m[1])) ? m[1] : '';
}

function issueBody(b, baseUrl){
  const tip = issueTip(b);
  const lines = [
    MARK(b.id),
    `**Где сломалось:** ${b.razdel || '—'}`,
    tip ? `**Тип проблемы:** ${tip}` : null,
    `**Важность:** ${b.vazhnost || '—'}`,
    `**Статус в базе:** ${b.status || 'new'}`,
    `**Отправлено:** ${b.created_at ? new Date(b.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—'}`,
    '',
    '### Что случилось',
    b.chto || '—',
  ];
  if (b.kak) lines.push('', '### Как повторить', b.kak);
  if (b.ssylka) lines.push('', `**Ссылка на страницу:** ${b.ssylka}`);
  if (b.skrin) lines.push('', `📸 Есть скриншот — открыть: ${baseUrl}/admin.html#bug-${b.id}`);
  lines.push('', `_Источник: Render Postgres lavrik_bugs.id = ${b.id}. Создано автоматически сервером lavrik-bugs._`);
  return lines.filter(l => l !== null).join('\n');
}

function labelsFor(b){
  const labels = ['bug'];
  const v = String(b.vazhnost || '');
  if (v.startsWith('🔴')) labels.push('критично');
  else if (v.startsWith('🟢')) labels.push('мелочь');
  if (b.razdel) labels.push(String(b.razdel).slice(0,50));
  const tip = issueTip(b);
  if (tip) labels.push(tip);
  return labels;
}

async function ghCreateIssue(b, baseUrl){
  if (!GH_TOKEN) throw new Error('GITHUB_TOKEN not set');
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues`, {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ title: issueTitle(b), body: issueBody(b, baseUrl), labels: labelsFor(b) })
  });
  if (!r.ok) throw new Error('github: ' + r.status + ' ' + await r.text());
  const j = await r.json();
  return j.html_url;
}

async function ghExistingBugIds(){
  const ids = new Set();
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues?state=all&per_page=100&page=${page}`, { headers: ghHeaders() });
    if (!r.ok) throw new Error('github list: ' + r.status + ' ' + await r.text());
    const arr = await r.json();
    for (const it of arr) {
      const m = /lavrik-bug-id:(\d+)/.exec(it.body || '');
      if (m) ids.add(Number(m[1]));
    }
    if (arr.length < 100) break;
  }
  return ids;
}

function baseUrlOf(req){
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

// ---------- API ----------
app.get('/api/config', (req,res) => res.json({
  ok: Boolean(pool),
  github: Boolean(GH_TOKEN),
  repo: GH_REPO,
  needKey: Boolean(ADMIN_KEY),
  password: Boolean(BUGS_PASSWORD)
}));

app.get('/api/bugs', async (req,res) => {
  try { res.json(await dbSelectBugs()); }
  catch(e){ console.error('GET /api/bugs:', e.message); res.status(500).json({ error: friendlyErr(e) }); }
});

const ALLOWED_STATUS = ['new', 'in_progress', 'done'];
app.patch('/api/bugs/:id', async (req,res) => {
  const id = Number(req.params.id);
  const status = String((req.body || {}).status || '');
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad id' });
  if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: 'bad status' });
  if (ADMIN_KEY && req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'Неверный ключ админа' });
  try {
    const n = await dbUpdateStatus(id, status);
    if (!n) return res.status(404).json({ error: 'Баг не найден' });
    _inboxCache = { at: 0, data: null };
    res.json({ ok: true, id, status });
  } catch(e){ console.error('PATCH /api/bugs:', e.message); res.status(500).json({ error: friendlyErr(e) }); }
});

app.post('/api/bugs', async (req,res) => {
  if (badPassword((req.body || {}).parol)) {
    return res.status(403).json({ error: 'Неверный пароль. Лаврик, спроси пароль у Виктора.' });
  }
  const { razdel, tip, chto, kak, ssylka, vazhnost, skrin } = req.body || {};
  if (!chto || !String(chto).trim()) return res.status(400).json({ error: 'Пустое поле «Что случилось?»' });

  const ALLOWED_VAZHNOST = ['🔴 Вообще не работает','🟡 Работает, но криво','🟢 Мелочь'];
  const ALLOWED_TIP = ['Ошибка','Дизайн','Съелся текст','Неправильная задача','Что-то пропало','Тормозит','Другое'];
  const tipVal = ALLOWED_TIP.includes(tip) ? tip : '';
  const chtoFull = (tipVal ? `[${tipVal}] ` : '') + String(chto).trimLeft();

  try {
    const payload = {
      razdel: sanitizeText(razdel, 200),
      chto: sanitizeText(chtoFull, 5000),
      kak: sanitizeText(kak, 3000),
      ssylka: sanitizeUrl(ssylka),
      vazhnost: ALLOWED_VAZHNOST.includes(vazhnost) ? vazhnost : '🟡 Работает, но криво',
      status: 'new'
    };
    try { payload.skrin = sanitizeSkrins(skrin); }
    catch (e) { return res.status(400).json({ error: String(e.message || e) }); }

    const bug = await dbInsertBug(payload);

    let issue_url = null, issue_error = null;
    if (GH_TOKEN) {
      try { issue_url = await ghCreateIssue(bug, baseUrlOf(req)); }
      catch(e){ issue_error = String(e.message||e); console.error('github issue failed:', issue_error); }
    }

    res.json({ ok: true, id: bug.id ?? null, issue_url, issue_error });
  } catch(e){
    console.error('POST /api/bugs:', e.message);
    res.status(500).json({ error: friendlyErr(e) });
  }
});

app.get('/api/sync-issues', async (req,res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  if (!GH_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  try {
    const bugs = await dbSelectBugs();
    const have = await ghExistingBugIds();
    const created = [], failed = [];
    const baseUrl = baseUrlOf(req);
    for (const b of [...bugs].reverse()) {
      if (b.status === 'reply') continue;
      if (have.has(Number(b.id))) continue;
      try { created.push({ id: b.id, url: await ghCreateIssue(b, baseUrl) }); }
      catch(e){ failed.push({ id: b.id, error: String(e.message||e) }); }
    }
    res.json({ ok: true, total: bugs.length, already: have.size, created, failed });
  } catch(e){ res.status(500).json({ error: friendlyErr(e) }); }
});

// ---------- Входящие вопросы агента ----------
const REPLY_PREFIX = '<!-- lavrik-reply';
const INBOX_TTL_MS = 60 * 1000;
let _inboxCache = { at: 0, data: null };

function isReply(body){ return String(body || '').includes(REPLY_PREFIX); }
function isAgentQuestion(c){
  const b = String(c.body || '');
  if (isReply(b)) return false;
  if (b.trim().startsWith('✅ Принято')) return false;
  if ((c.user && c.user.type) === 'Bot') return false;
  return true;
}
function stripReply(body){
  return String(body || '').replace(/<!--\s*lavrik-reply[^>]*-->/g, '').replace(/^\s*\*\*💬 Ответ Лаврика:\*\*\s*/,'').trim();
}

async function ghListOpenBugIssues(){
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues?state=open&per_page=100&page=${page}`, { headers: ghHeaders() });
    if (!r.ok) throw new Error('github issues: ' + r.status + ' ' + await r.text());
    const arr = await r.json();
    for (const it of arr) {
      if (it.pull_request) continue;
      const m = /lavrik-bug-id:(\d+)/.exec(it.body || '');
      if (m) out.push({ number: it.number, bug_id: Number(m[1]), title: it.title, html_url: it.html_url });
    }
    if (arr.length < 100) break;
  }
  return out;
}

async function ghIssueComments(n){
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues/${n}/comments?per_page=100`, { headers: ghHeaders() });
  if (!r.ok) throw new Error('github comments: ' + r.status + ' ' + await r.text());
  return r.json();
}

async function pendingReplies(){
  if (!pool) return [];
  try {
    const bugs = await dbSelectBugs();
    return bugs.filter(b => b.status === 'reply' && /^issue:\d+$/.test(String(b.kak || '')));
  } catch(e){ console.error('pendingReplies:', e.message); return []; }
}

async function buildInbox(){
  const issues = await ghListOpenBugIssues();
  const queued = await pendingReplies();
  const items = [];
  for (const it of issues) {
    const comments = await ghIssueComments(it.number);
    const thread = comments
      .filter(c => isAgentQuestion(c) || isReply(c.body))
      .map(c => ({
        id: c.id,
        from: isReply(c.body) ? 'lavrik' : 'agent',
        text: isReply(c.body) ? stripReply(c.body) : String(c.body||'').trim(),
        at: c.created_at
      }));
    const delivered = new Set();
    for (const c of comments) { const m = /lavrik-reply:(\d+)/.exec(c.body || ''); if (m) delivered.add(Number(m[1])); }
    for (const q of queued) {
      if (q.kak !== `issue:${it.number}` || delivered.has(Number(q.id))) continue;
      thread.push({ id: 'q' + q.id, from: 'lavrik', text: String(q.chto || ''), at: q.created_at, pending: true });
    }
    thread.sort((a,b) => new Date(a.at) - new Date(b.at));
    const questions = thread.filter(t => t.from === 'agent');
    if (!questions.length) continue;
    const last = thread[thread.length - 1];
    items.push({
      issue: it.number,
      bug_id: it.bug_id,
      title: it.title.replace(/^\[Баг #\d+\]\s*/, ''),
      url: it.html_url,
      thread,
      waiting: last.from === 'agent',
      last_at: last.at
    });
  }
  items.sort((a,b) => (b.waiting - a.waiting) || (new Date(b.last_at) - new Date(a.last_at)));
  return items;
}

app.get('/api/inbox', async (req,res) => {
  if (!GH_TOKEN) return res.json({ ok: true, items: [], disabled: true });
  try {
    const now = Date.now();
    if (!_inboxCache.data || now - _inboxCache.at > INBOX_TTL_MS || req.query.fresh === '1') {
      _inboxCache = { at: now, data: await buildInbox() };
    }
    res.json({ ok: true, items: _inboxCache.data, waiting: _inboxCache.data.filter(i => i.waiting).length });
  } catch(e){ res.status(500).json({ ok:false, error: String(e.message||e) }); }
});

const _replyHits = new Map();
function replyRateOk(ip){
  const now = Date.now(), arr = (_replyHits.get(ip) || []).filter(t => now - t < 10*60*1000);
  arr.push(now); _replyHits.set(ip, arr);
  return arr.length <= 20;
}

app.post('/api/inbox/:issue/reply', async (req,res) => {
  if (badPassword((req.body || {}).parol)) {
    return res.status(403).json({ error: 'Неверный пароль. Лаврик, спроси пароль у Виктора.' });
  }
  if (!GH_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  const n = Number(req.params.issue);
  const text = sanitizeText((req.body||{}).text, 3000).trim();
  if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'bad issue' });
  if (!text) return res.status(400).json({ error: 'Пустой ответ' });
  if (!replyRateOk(req.ip)) return res.status(429).json({ error: 'Слишком много ответов подряд, подожди минуту' });
  try {
    const ir = await fetch(`https://api.github.com/repos/${GH_REPO}/issues/${n}`, { headers: ghHeaders() });
    if (!ir.ok) throw new Error('github issue: ' + ir.status);
    const issue = await ir.json();
    if (!/lavrik-bug-id:\d+/.test(issue.body || '')) return res.status(403).json({ error: 'Это не баг Лаврика' });

    const row = await dbInsertBug({
      razdel: 'Ответ агенту', chto: text, kak: `issue:${n}`, ssylka: issue.html_url || '',
      vazhnost: '🟢 Мелочь', skrin: null, status: 'reply'
    }) || {};

    let via = 'queue';
    if (row.id) {
      const body = `<!-- lavrik-reply:${row.id} -->\n**💬 Ответ Лаврика:**\n\n${text}`;
      const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues/${n}/comments`, {
        method: 'POST', headers: ghHeaders(), body: JSON.stringify({ body })
      });
      if (r.ok) via = 'direct';
    }
    _inboxCache = { at: 0, data: null };
    res.json({ ok: true, via });
  } catch(e){ console.error('reply:', e.message); res.status(500).json({ error: friendlyErr(e) }); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log('lavrik-bugs on ' + port);
  if (pool) dbReady().then(() => console.log('db: lavrik_bugs ready')).catch(e => console.error('db init failed:', e.message));
  else console.error('DATABASE_URL not set');
});
