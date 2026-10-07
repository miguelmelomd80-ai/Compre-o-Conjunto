const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./db');
const ns = require('./nuvemshop');
const { setSession, getSession, clearSession } = require('./session');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const publicUrl = req => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// ---------- Webhooks (precisam do corpo bruto para validar a assinatura) ----------
app.post('/webhooks/*', express.raw({ type: '*/*' }), (req, res) => {
  const received = req.get('x-linkedstore-hmac-sha256') || '';
  const expected = crypto.createHmac('sha256', process.env.NUVEMSHOP_CLIENT_SECRET || '').update(req.body || '').digest('hex');
  if (isProd && (received.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected)))) {
    return res.status(401).send('assinatura inválida');
  }
  let body = {};
  try { body = JSON.parse(req.body.toString() || '{}'); } catch {}
  const topic = req.params[0];
  const storeId = body.store_id;
  if ((topic === 'app/uninstalled' || topic === 'store/redact') && storeId) {
    store.deleteStore(storeId);
    ns.clearCache(storeId);
  }
  // customers/redact e customers/data_request: o app não guarda dados de clientes.
  res.sendStatus(200);
});

app.use(express.json({ limit: '200kb' }));

// ---------- Instalação / OAuth ----------
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Parâmetro "code" ausente.');
  try {
    const data = await ns.exchangeCode(code);
    store.saveStore(data.user_id, data.access_token, data.scope);
    // Registra o aviso de desinstalação (só funciona com URL https pública)
    const url = `${publicUrl(req)}/webhooks/app/uninstalled`;
    if (url.startsWith('https://')) {
      ns.api(store.getStore(data.user_id), 'POST', '/webhooks', { event: 'app/uninstalled', url })
        .catch(e => console.warn('Webhook não registrado (pode já existir):', e.message));
    }
    setSession(req, res, data.user_id);
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send('Não foi possível concluir a instalação. Tente de novo pela Nuvemshop.');
  }
});

app.get('/', (req, res) => {
  if (getSession(req)) return res.redirect('/admin');
  const install = process.env.NUVEMSHOP_APP_ID ? `${ns.AUTH_BASE}/apps/${process.env.NUVEMSHOP_APP_ID}/authorize` : '#';
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Compre o Conjunto</title>
  <body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px;text-align:center;color:#222">
  <h1>Compre o Conjunto</h1><p>Abra o app pelo painel da sua loja Nuvemshop para acessar.</p>
  <p><a href="${install}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Instalar / entrar pela Nuvemshop</a></p></body>`);
});

app.get('/logout', (req, res) => { clearSession(res); res.redirect('/'); });

// Login de desenvolvimento (somente fora de produção) usando DEV_STORE_ID + DEV_ACCESS_TOKEN
if (!isProd) {
  app.get('/dev/login', (req, res) => {
    const id = process.env.DEV_STORE_ID, tok = process.env.DEV_ACCESS_TOKEN;
    if (!id || !tok) return res.status(400).send('Defina DEV_STORE_ID e DEV_ACCESS_TOKEN no .env');
    store.saveStore(id, tok, 'dev');
    setSession(req, res, id);
    res.redirect('/admin');
  });
}

// ---------- Painel ----------
function requireStore(req, res, next) {
  const id = getSession(req);
  const s = id && store.getStore(id);
  if (!s) {
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Sessão expirada. Abra o app pela Nuvemshop.' });
    return res.redirect('/');
  }
  req.store = s;
  next();
}

app.get('/admin', requireStore, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

const admin = express.Router();
admin.use(requireStore);

admin.get('/me', (req, res) => res.json({ store_id: req.store.store_id, settings: req.store.settings }));

admin.put('/settings', (req, res) => {
  const cur = req.store.settings;
  const b = req.body || {};
  const color = v => (/^#[0-9a-f]{3,8}$/i.test(v || '') ? v : null);
  const next = {
    button_text: String(b.button_text || cur.button_text).slice(0, 60),
    primary_color: color(b.primary_color) || cur.primary_color,
    text_color: color(b.text_color) || cur.text_color,
    after_add: b.after_add === 'reload' ? 'reload' : 'cart',
    show_on_mobile: b.show_on_mobile !== false,
  };
  store.saveSettings(req.store.store_id, next);
  res.json(next);
});

admin.get('/products', async (req, res) => {
  try { res.json(await ns.searchProducts(req.store, String(req.query.q || '').trim())); }
  catch (e) { console.error(e); res.status(502).json({ error: 'Erro ao buscar produtos na Nuvemshop.' }); }
});

async function withProducts(st, set) {
  const products = await Promise.all(set.product_ids.map(id => ns.getProduct(st, id).catch(() => null)));
  return {
    ...set,
    products: set.product_ids.map((id, i) => products[i]
      ? { id, name: products[i].name, image: products[i].image, published: products[i].published }
      : { id, name: 'Produto não encontrado', image: null, missing: true }),
  };
}

admin.get('/sets', async (req, res) => {
  const sets = store.listSets(req.store.store_id);
  res.json(await Promise.all(sets.map(s => withProducts(req.store, s))));
});

function validateSet(b) {
  const product_ids = [...new Set((Array.isArray(b.product_ids) ? b.product_ids : []).map(Number).filter(Boolean))];
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) return { error: 'Dê um nome ao conjunto.' };
  if (product_ids.length < 2) return { error: 'Escolha pelo menos 2 produtos.' };
  if (product_ids.length > 8) return { error: 'Máximo de 8 produtos por conjunto.' };
  return { value: { name, title: String(b.title || 'Compre o conjunto').trim().slice(0, 100), product_ids, active: b.active !== false } };
}

admin.post('/sets', (req, res) => {
  const v = validateSet(req.body || {});
  if (v.error) return res.status(400).json(v);
  res.status(201).json(store.createSet(req.store.store_id, v.value));
});

admin.put('/sets/:id', (req, res) => {
  if (!store.getSet(req.store.store_id, req.params.id)) return res.status(404).json({ error: 'Conjunto não encontrado.' });
  const v = validateSet(req.body || {});
  if (v.error) return res.status(400).json(v);
  res.json(store.updateSet(req.store.store_id, req.params.id, v.value));
});

admin.delete('/sets/:id', (req, res) => {
  store.deleteSet(req.store.store_id, req.params.id);
  res.sendStatus(204);
});

admin.post('/refresh-cache', (req, res) => { ns.clearCache(req.store.store_id); res.json({ ok: true }); });

app.use('/api/admin', admin);

// ---------- API pública usada pelo script da vitrine ----------
app.get('/api/public/sets', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=60');
  const { store: storeId, product } = req.query;
  const st = storeId && store.getStore(storeId);
  if (!st || !product) return res.json({ sets: [] });

  const sets = store.activeSetsForProduct(st.store_id, product);
  const out = [];
  for (const s of sets) {
    const products = (await Promise.all(s.product_ids.map(id => ns.getProduct(st, id).catch(() => null))))
      .filter(p => p && p.published && p.variants.length);
    if (products.length >= 2) out.push({ id: s.id, title: s.title, products });
  }
  const { button_text, primary_color, text_color, after_add, show_on_mobile } = st.settings;
  res.json({ settings: { button_text, primary_color, text_color, after_add, show_on_mobile }, sets: out });
});

// Script da vitrine com a URL do app já embutida (é este arquivo que vai para o Portal de Parceiros)
app.get('/widget.js', (req, res) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'widget', 'widget.js'), 'utf8')
    .replace('__API_BASE__', publicUrl(req));
  res.type('application/javascript').set('Access-Control-Allow-Origin', '*').send(src);
});

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Compre o Conjunto rodando na porta ${PORT}`));
}
module.exports = app;
