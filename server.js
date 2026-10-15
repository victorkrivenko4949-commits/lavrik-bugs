const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_ANON_KEY || '';
// Ключ для чтения на сервере: service_role (обходит RLS). Если не задан — anon.
const SUPA_READ_KEY = process.env.SUPABASE_SERVICE_KEY || SUPA_KEY;

// GitHub: дублирование багов в Issues, чтобы агент видел их через GitHub
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || 'victorkrivenko4949-commits/lavrik-bugs';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Валидация data:image/...;base64,... (только PNG/JPEG/WebP/GIF)
const IMG_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function sanitizeSkrin(v){
  if (!v || typeof v !== 'string') return null;
  if (!IMG_RE.test(v)) return null;
  if (v.length > 14_000_000) return null; // ~10 MB base64
  return v;
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

function supaHeaders(key, extra={}){
  return { 'apikey': key, 'Authorization': 'Bearer ' + key, ...extra };
}

async function supaSelectBugs(){
  const r = await fetch(SUPA_URL + '/rest/v1/bugs?select=id,razdel,chto,kak,ssylka,vazhnost,skrin,status,created_at&order=created_at.desc', {
    headers: supaHeaders(SUPA_READ_KEY)
  });
  if (!r.ok) throw new Error('supabase: ' + r.status + ' ' + await r.text());
  return r.json();
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

function issueBody(b, baseUrl){
  const lines = [
    MARK(b.id),
    `**Где сломалось:** ${b.razdel || '—'}`,
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
  lines.push('', `_Источник: Supabase bugs.id = ${b.id}. Создано автоматически сервером lavrik-bugs._`);
  return lines.join('\n');
}

function labelsFor(b){
  const labels = ['bug'];
  const v = String(b.vazhnost || '');
  if (v.startsWith('🔴')) labels.push('критично');
  else if (v.startsWith('🟢')) labels.push('мелочь');
  if (b.razdel) labels.push(String(b.razdel).slice(0,50));
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
  ok: Boolean(SUPA_URL && SUPA_KEY),
  github: Boolean(GH_TOKEN),
  repo: GH_REPO
}));

app.get('/api/bugs', async (req,res) => {
  if (!SUPA_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
  try { res.json(await supaSelectBugs()); }
  catch(e){ res.status(500).json({ error: String(e.message||e) }); }
});

app.post('/api/bugs', async (req,res) => {
  const { razdel, chto, kak, ssylka, vazhnost, skrin } = req.body || {};
  if (!chto || !String(chto).trim()) return res.status(400).json({ error: 'Пустое поле «Что случилось?»' });

  const ALLOWED_VAZHNOST = ['🔴 Вообще не работает','🟡 Работает, но криво','🟢 Мелочь'];

  try {
    const payload = {
      razdel: sanitizeText(razdel, 200),
      chto: sanitizeText(chto, 5000),
      kak: sanitizeText(kak, 3000),
      ssylka: sanitizeUrl(ssylka),
      vazhnost: ALLOWED_VAZHNOST.includes(vazhnost) ? vazhnost : '🟡 Работает, но криво',
      skrin: sanitizeSkrin(skrin),
      status: 'new'
    };

    const r = await fetch(SUPA_URL + '/rest/v1/bugs', {
      method: 'POST',
      headers: supaHeaders(SUPA_KEY, { 'Content-Type':'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('supabase: ' + r.status + ' ' + await r.text());
    const created = await r.json();
    const bug = created[0] || { ...payload, id: null, created_at: new Date().toISOString() };

    // Дублируем в GitHub Issues (ошибка GitHub не ломает отправку бага)
    let issue_url = null, issue_error = null;
    if (GH_TOKEN) {
      try { issue_url = await ghCreateIssue(bug, baseUrlOf(req)); }
      catch(e){ issue_error = String(e.message||e); console.error('github issue failed:', issue_error); }
    }

    res.json({ ok: true, id: bug.id ?? null, issue_url, issue_error });
  } catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});

// Разовая синхронизация: все баги из Supabase, которых ещё нет в Issues.
// Открыть в браузере: /api/sync-issues?key=ВАШ_ADMIN_KEY
app.get('/api/sync-issues', async (req,res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
  if (!GH_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not set' });
  try {
    const bugs = await supaSelectBugs();
    const have = await ghExistingBugIds();
    const created = [], failed = [];
    const baseUrl = baseUrlOf(req);
    for (const b of [...bugs].reverse()) { // старые первыми — чтобы номера issue шли по порядку
      if (have.has(Number(b.id))) continue;
      try { created.push({ id: b.id, url: await ghCreateIssue(b, baseUrl) }); }
      catch(e){ failed.push({ id: b.id, error: String(e.message||e) }); }
    }
    res.json({ ok: true, total: bugs.length, already: have.size, created, failed });
  } catch(e){ res.status(500).json({ error: String(e.message||e) }); }
});

// ---------- Входящие вопросы агента (двусторонняя связь с Лавриком) ----------
const REPLY_MARK = '<!-- lavrik-reply -->';
const INBOX_TTL_MS = 60 * 1000;
let _inboxCache = { at: 0, data: null };

function isAgentQuestion(c){
  const b = String(c.body || '');
  if (b.includes(REPLY_MARK)) return false;            // ответ самого Лаврика
  if (b.trim().startsWith('✅ Принято')) return false;  // автоответ бота
  if ((c.user && c.user.type) === 'Bot') return false;
  return true;
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

async function buildInbox(){
  const issues = await ghListOpenBugIssues();
  const items = [];
  for (const it of issues) {
    const comments = await ghIssueComments(it.number);
    const thread = comments
      .filter(c => isAgentQuestion(c) || String(c.body||'').includes(REPLY_MARK))
      .map(c => ({
        id: c.id,
        from: String(c.body||'').includes(REPLY_MARK) ? 'lavrik' : 'agent',
        text: String(c.body||'').replace(REPLY_MARK, '').replace(/^\s*\*\*💬 Ответ Лаврика:\*\*\s*/,'').trim(),
        at: c.created_at
      }));
    const questions = thread.filter(t => t.from === 'agent');
    if (!questions.length) continue;
    const last = thread[thread.length - 1];
    items.push({
      issue: it.number,
      bug_id: it.bug_id,
      title: it.title.replace(/^\[Баг #\d+\]\s*/, ''),
      url: it.html_url,
      thread,
      waiting: last.from === 'agent',   // агент ждёт ответа
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

const _replyHits = new Map(); // ip -> [timestamps]
function replyRateOk(ip){
  const now = Date.now(), arr = (_replyHits.get(ip) || []).filter(t => now - t < 10*60*1000);
  arr.push(now); _replyHits.set(ip, arr);
  return arr.length <= 20;
}

app.post('/api/inbox/:issue/reply', async (req,res) => {
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
    const body = `${REPLY_MARK}\n**💬 Ответ Лаврика:**\n\n${text}`;
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/issues/${n}/comments`, {
      method: 'POST', headers: ghHeaders(), body: JSON.stringify({ body })
    });
    if (!r.ok) throw new Error('github comment: ' + r.status + ' ' + await r.text());
    _inboxCache = { at: 0, data: null }; // сбросить кэш
    res.json({ ok: true });
  } catch(e){ res.status(500).json({ error: String(e.message||e) }); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('lavrik-bugs on ' + port));
