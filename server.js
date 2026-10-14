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
// Необязательный ключ админа: если задан, смена статуса требует заголовок x-admin-key
const ADMIN_KEY = process.env.ADMIN_KEY || '';

const STATUSES = ['new', 'in_progress', 'done'];

const supaHeaders = (extra = {}) => ({
  'apikey': SUPA_KEY,
  'Authorization': 'Bearer ' + SUPA_KEY,
  ...extra
});

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

function checkAdmin(req, res, next){
  if (!ADMIN_KEY) return next();
  if (req.get('x-admin-key') === ADMIN_KEY) return next();
  res.status(401).json({ error: 'Нужен ключ админа (x-admin-key)' });
}

app.get('/api/config', (req,res) => res.json({
  ok: Boolean(SUPA_URL && SUPA_KEY),
  needKey: Boolean(ADMIN_KEY)
}));

// GET /api/bugs            — все баги
// GET /api/bugs?status=open — только неисправленные (new + in_progress)
// GET /api/bugs?status=done — только исправленные
app.get('/api/bugs', async (req,res) => {
  if (!SUPA_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
  try {
    let q = '/rest/v1/bugs?select=id,razdel,chto,kak,ssylka,vazhnost,skrin,status,created_at&order=created_at.desc';
    const s = String(req.query.status || '');
    if (s === 'open') q += '&status=neq.done';
    else if (STATUSES.includes(s)) q += '&status=eq.' + s;
    const r = await fetch(SUPA_URL + q, { headers: supaHeaders() });
    if (!r.ok) throw new Error('supabase: ' + r.status + ' ' + await r.text());
    res.json(await r.json());
  } catch(e){ res.status(500).json({ error: String(e.message||e) }); }
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
      headers: supaHeaders({ 'Content-Type':'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('supabase: ' + r.status + ' ' + await r.text());
    const created = await r.json();
    res.json({ ok: true, id: created[0]?.id ?? null });
  } catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});

// PATCH /api/bugs/:id  { status: 'new' | 'in_progress' | 'done' }
// Исправленный баг получает status=done и уходит со страницы «Не исправлено» в «Исправлено».
app.patch('/api/bugs/:id', checkAdmin, async (req,res) => {
  if (!SUPA_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Плохой id' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'status должен быть new | in_progress | done' });
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/bugs?id=eq.' + id, {
      method: 'PATCH',
      headers: supaHeaders({ 'Content-Type':'application/json', 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status })
    });
    if (!r.ok) throw new Error('supabase: ' + r.status + ' ' + await r.text());
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'Баг #' + id + ' не найден (или RLS запрещает UPDATE)' });
    res.json({ ok: true, id, status: rows[0].status });
  } catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('lavrik-bugs on ' + port));
