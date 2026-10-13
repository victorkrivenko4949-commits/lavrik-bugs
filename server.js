const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_ANON_KEY || '';

app.get('/api/config', (req,res) => res.json({ ok: Boolean(SUPA_URL && SUPA_KEY) }));

app.get('/api/bugs', async (req,res) => {
  if (!SUPA_URL) return res.status(500).json({ error: 'SUPABASE_URL not set' });
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/bugs?select=*&order=created_at.desc', {
      headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY }
    });
    if (!r.ok) throw new Error('supabase: ' + r.status + ' ' + await r.text());
    res.json(await r.json());
  } catch(e){ res.status(500).json({ error: String(e.message||e) }); }
});

app.post('/api/bugs', async (req,res) => {
  const { razdel, chto, kak, ssylka, vazhnost, skrin } = req.body;
  if (!chto || !String(chto).trim()) return res.status(400).json({ error: 'Пустое поле «Что случилось?»' });
  try {
    const payload = {
      razdel: razdel || '',
      chto: String(chto).slice(0,5000),
      kak: String(kak||'').slice(0,3000),
      ssylka: String(ssylka||'').slice(0,500),
      vazhnost: vazhnost || '🟡 Работает, но криво',
      skrin: (skrin && String(skrin).length < 14_000_000) ? String(skrin) : null,
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
