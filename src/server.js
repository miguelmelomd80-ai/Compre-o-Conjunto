const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const store = require('./db');
const ns = require('./nuvemshop');
const { suggestSets } = require('./suggest');
const auth = require('./session');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const PUBLIC = path.join(__dirname, '..', 'public');

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

// Eventos da vitrine chegam como texto (sendBeacon), então aceitamos text/plain também
app.use('/api/public/track', express.text({ type: '*/*', limit: '2kb' }));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false }));

// ---------- Instalação / OAuth ----------
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Parâmetro "code" ausente.');
  try {
    const data = await ns.exchangeCode(code);
    store.saveStore(data.user_id, data.access_token, data.scope);
    const st = store.getStore(data.user_id);
    ns.getStoreInfo(st).then(i => i && store.saveStoreInfo(st.store_id, i.name, i.domain)).catch(() => {});
    const url = `${publicUrl(req)}/webhooks/app/uninstalled`;
    if (url.startsWith('https://')) {
      ns.api(st, 'POST', '/webhooks', { event: 'app/uninstalled', url })
        .catch(e => console.warn('Webhook não registrado (pode já existir):', e.message));
    }
    // Se quem instalou já estava logado como agência, mantém o acesso de agência
    const cur = auth.getAuth(req);
    auth.setSession(req, res, { s: data.user_id, a: !!(cur && cur.agency) });
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send('Não foi possível concluir a instalação. Tente de novo pela Nuvemshop.');
  }
});

// ---------- Páginas ----------
app.get('/', (req, res) => {
  const a = auth.getAuth(req);
  if (a && a.storeId) return res.redirect('/admin');
  if (a && a.agency) return res.redirect('/lojas');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8')
    .replace('__INSTALL_URL__', process.env.NUVEMSHOP_APP_ID ? `${ns.AUTH_BASE}/apps/${process.env.NUVEMSHOP_APP_ID}/authorize` : '#')
    .replace('__AGENCY_ENABLED__', process.env.AGENCY_EMAIL && process.env.AGENCY_PASSWORD ? 'true' : 'false');
  res.type('html').send(html);
});

app.post('/login', (req, res) => {
  const ip = req.ip;
  if (!auth.loginAllowed(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { email, password } = req.body || {};
  if (!auth.checkAgencyLogin(email, password)) {
    auth.registerFailure(ip);
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  auth.setSession(req, res, { s: null, a: true });
  res.json({ ok: true, redirect: '/lojas' });
});

app.get('/logout', (req, res) => { auth.clearSession(res); res.redirect('/login'); });

app.get('/lojas', (req, res) => {
  const a = auth.getAuth(req);
  if (!a || !a.agency) return res.redirect('/login');
  res.sendFile(path.join(PUBLIC, 'lojas.html'));
});

// O painel carrega sem exigir cookie: dentro da Nuvemshop ele se autentica pelo token do Nexo.
app.get('/admin', (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8')
    .replace('__APP_ID__', String(process.env.NUVEMSHOP_APP_ID || ''));
  res.type('html').set('Cache-Control', 'no-store').send(html);
});
app.use('/static', express.static(PUBLIC));

// Login de desenvolvimento (somente fora de produção)
if (!isProd) {
  app.get('/dev/login', (req, res) => {
    const id = process.env.DEV_STORE_ID, tok = process.env.DEV_ACCESS_TOKEN;
    if (!id || !tok) return res.status(400).send('Defina DEV_STORE_ID e DEV_ACCESS_TOKEN no .env');
    store.saveStore(id, tok, 'dev');
    auth.setSession(req, res, { s: id, a: req.query.agency === '1' });
    res.redirect('/admin');
  });
}

// ---------- API da agência ----------
const agency = express.Router();
agency.use((req, res, next) => {
  const a = auth.getAuth(req);
  if (!a || !a.agency) return res.status(401).json({ error: 'Faça login.' });
  req.auth = a;
  next();
});
agency.get('/stores', async (req, res) => {
  const list = store.listStores();
  // completa nome/domínio de lojas antigas
  await Promise.all(list.filter(s => !s.name).map(async s => {
    const info = await ns.getStoreInfo(store.getStore(s.store_id)).catch(() => null);
    if (info) { store.saveStoreInfo(s.store_id, info.name, info.domain); Object.assign(s, info); }
  }));
  res.json(list.map(({ scope, ...s }) => ({ ...s, coupons: /coupons/.test(scope || '') })));
});
agency.post('/select', (req, res) => {
  const id = req.body && req.body.store_id;
  if (!store.getStore(id)) return res.status(404).json({ error: 'Loja não encontrada.' });
  auth.setSession(req, res, { s: id, a: true });
  res.json({ ok: true });
});
app.use('/api/agency', agency);

// ---------- API do painel (de uma loja) ----------
const admin = express.Router();
admin.use((req, res, next) => {
  const a = auth.getAuth(req);
  const s = a && store.getStore(a.storeId);
  if (!s) {
    return res.status(401).json({
      error: a && a.agency ? 'Escolha uma loja.' : 'Sessão expirada. Abra o app pela Nuvemshop.',
      agency: !!(a && a.agency),
    });
  }
  req.auth = a;
  req.store = s;
  next();
});

admin.get('/me', (req, res) => res.json({
  store_id: req.store.store_id,
  store_name: req.store.name,
  store_domain: req.store.domain,
  agency: !!req.auth.agency,
  embedded: !!req.auth.embedded,
  can_coupons: /coupons/.test(req.store.scope || '') || req.store.scope === 'dev',
  settings: req.store.settings,
}));

admin.put('/settings', (req, res) => {
  const cur = req.store.settings;
  const b = req.body || {};
  const color = v => (/^#[0-9a-f]{3,8}$/i.test(v || '') ? v : null);
  const radius = Number(b.radius);
  const next = {
    button_text: String(b.button_text || cur.button_text).slice(0, 60),
    primary_color: color(b.primary_color) || cur.primary_color,
    text_color: color(b.text_color) || cur.text_color,
    after_add: b.after_add === 'reload' ? 'reload' : 'cart',
    show_on_mobile: b.show_on_mobile !== false,
    variant_style: b.variant_style === 'select' ? 'select' : 'buttons',
    radius: Number.isFinite(radius) ? Math.max(0, Math.min(40, Math.round(radius))) : cur.radius,
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
  const discount = Math.round(Number(b.discount_percent) || 0);
  if (!name) return { error: 'Dê um nome ao conjunto.' };
  if (product_ids.length < 2) return { error: 'Escolha pelo menos 2 produtos.' };
  if (product_ids.length > 8) return { error: 'Máximo de 8 produtos por conjunto.' };
  if (discount < 0 || discount > 50) return { error: 'O desconto deve ficar entre 0% e 50%.' };
  return { value: {
    name, title: String(b.title || 'Compre o conjunto').trim().slice(0, 100), product_ids,
    active: b.active !== false, discount_percent: discount,
    combine_discounts: b.combine_discounts === true, // padrão: NÃO combina com outros descontos
  } };
}

// Cria/atualiza/remove o cupom do conjunto conforme o desconto. Retorna um aviso se não conseguir.
async function syncCoupon(st, set) {
  try {
    if (set.discount_percent > 0) {
      const c = await ns.upsertCoupon(st, set);
      store.setCoupon(st.store_id, set.id, c.id, c.code);
    } else if (set.coupon_id) {
      await ns.deleteCoupon(st, set.coupon_id);
      store.setCoupon(st.store_id, set.id, null, null);
    }
    return null;
  } catch (e) {
    console.error('Cupom:', e.message);
    store.updateSet(st.store_id, set.id, { ...set, discount_percent: 0 });
    return (e.status === 401 || e.status === 403)
      ? 'O conjunto foi salvo, mas sem desconto: o app ainda não tem permissão para criar cupons. Veja as instruções na aba Desconto.'
      : 'O conjunto foi salvo, mas a Nuvemshop recusou o cupom de desconto. Tente de novo em instantes.';
  }
}

admin.post('/sets', async (req, res) => {
  const v = validateSet(req.body || {});
  if (v.error) return res.status(400).json(v);
  const set = store.createSet(req.store.store_id, v.value);
  const warning = await syncCoupon(req.store, set);
  res.status(201).json({ ...store.getSet(req.store.store_id, set.id), warning });
});

admin.put('/sets/:id', async (req, res) => {
  const cur = store.getSet(req.store.store_id, req.params.id);
  if (!cur) return res.status(404).json({ error: 'Conjunto não encontrado.' });
  const v = validateSet(req.body || {});
  if (v.error) return res.status(400).json(v);
  const set = store.updateSet(req.store.store_id, req.params.id, v.value);
  const changed = set.discount_percent !== cur.discount_percent || set.combine_discounts !== cur.combine_discounts ||
    JSON.stringify(set.product_ids) !== JSON.stringify(cur.product_ids);
  const warning = changed || (set.discount_percent > 0 && !set.coupon_id) ? await syncCoupon(req.store, set) : null;
  res.json({ ...store.getSet(req.store.store_id, set.id), warning });
});

admin.delete('/sets/:id', async (req, res) => {
  const cur = store.getSet(req.store.store_id, req.params.id);
  if (cur && cur.coupon_id) await ns.deleteCoupon(req.store, cur.coupon_id);
  store.deleteSet(req.store.store_id, req.params.id);
  res.sendStatus(204);
});

admin.get('/categories', async (req, res) => {
  try { res.json(await ns.listCategories(req.store)); }
  catch (e) { console.error(e); res.status(502).json({ error: 'Erro ao ler as categorias da Nuvemshop.' }); }
});

admin.get('/suggestions', async (req, res) => {
  try {
    const categoryIds = String(req.query.categories || '').split(',').map(Number).filter(Boolean);
    const products = await ns.listAllProducts(req.store);
    const suggestions = suggestSets(products, store.listSets(req.store.store_id), { categoryIds, requireAll: req.query.all === '1' });
    // Peças disponíveis em cada categoria escolhida, para a pessoa trocar/escolher as peças de cada conjunto
    const catalog = {};
    for (const c of categoryIds) {
      catalog[c] = products.filter(p => p.published !== false && (p.categories || []).map(Number).includes(c))
        .slice(0, 400).map(p => ({ id: p.id, name: p.name, image: p.image }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    }
    res.json({ suggestions, catalog });
  } catch (e) { console.error(e); res.status(502).json({ error: 'Erro ao ler os produtos da Nuvemshop.' }); }
});

admin.get('/metrics', (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const m = store.metrics(req.store.store_id, days);
  const names = Object.fromEntries(store.listSets(req.store.store_id).map(s => [s.id, s.name]));
  res.json({
    days, since: m.since, byDay: m.byDay,
    bySet: m.bySet.filter(r => names[r.set_id]).map(r => ({ ...r, name: names[r.set_id] }))
      .sort((a, b) => b.value - a.value || b.views - a.views),
  });
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
    if (products.length >= 2) {
      out.push({
        id: s.id, title: s.title, products,
        discount_percent: s.coupon_code ? s.discount_percent : 0,
        coupon_code: s.discount_percent > 0 ? s.coupon_code : null,
      });
    }
  }
  const { button_text, primary_color, text_color, after_add, show_on_mobile, variant_style, radius } = st.settings;
  res.json({ settings: { button_text, primary_color, text_color, after_add, show_on_mobile, variant_style, radius }, sets: out });
});

// Métricas da vitrine (visualização do bloco e conjunto adicionado ao carrinho)
const trackHits = new Map();
app.options('/api/public/track', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }).sendStatus(204);
});
app.post('/api/public/track', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  // limite: 300 eventos por minuto por IP
  const now = Date.now(), key = req.ip;
  const hits = (trackHits.get(key) || []).filter(t => now - t < 60000);
  if (hits.length >= 300) return res.sendStatus(429);
  hits.push(now); trackHits.set(key, hits);
  if (trackHits.size > 5000) trackHits.clear();

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || !['view', 'add'].includes(b.type)) return res.sendStatus(400);
  const set = store.getSet(b.store, b.set);
  if (!set) return res.sendStatus(204);
  const items = Math.max(0, Math.min(8, Number(b.items) || 0));
  const value = Math.max(0, Math.min(100000, Number(b.value) || 0));
  store.track(set.store_id, set.id, b.type, items, value);
  res.sendStatus(204);
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
