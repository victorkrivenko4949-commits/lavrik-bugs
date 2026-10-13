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

app.get('/api/config', (req,res) => res.json({ ok: Boolean(SUPA_URL && SUPA_KEY) }));

app.get('/api/bugs', async (req,res) => {
  if (!SUPA_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/bugs?select=id,razdel,chto,kak,ssylka,vazhnost,skrin,status,created_at&order=created_at.desc', {
      headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY }
    });
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
      headers: {
        'Content-Type':'application/json',
        'apikey': SUPA_KEY,
        'Authorization':'Bearer ' + SUPA_KEY,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('supabase: ' + r.status + ' ' + await r.text());
    const created = await r.json();
    res.json({ ok: true, id: created[0]?.id ?? null });
  } catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('lavrik-bugs on ' + port));
