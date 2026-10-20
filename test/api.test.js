const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.DATABASE_FILE = ':memory:';
process.env.NUVEMSHOP_API_BASE = 'http://localhost:4100';
process.env.NUVEMSHOP_AUTH_BASE = 'http://localhost:4100';
process.env.NUVEMSHOP_APP_ID = '999';
process.env.NUVEMSHOP_CLIENT_SECRET = 'segredo';

const mock = require('./mock-nuvemshop');
const app = require('../src/server');
let mockSrv, appSrv, cookie;
const base = 'http://localhost:4101';

before(async () => {
  ({ srv: mockSrv } = await mock.start(4100));
  await new Promise(r => { appSrv = app.listen(4101, r); });
});
after(() => { for (const s of [mockSrv, appSrv]) { s.closeAllConnections(); s.close(); } });

const req = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) } });

test('painel exige sessão', async () => {
  const r = await req('/api/admin/sets');
  assert.equal(r.status, 401);
});

test('instalação via OAuth cria sessão', async () => {
  const bad = await req('/auth/callback?code=errado');
  assert.equal(bad.status, 500);
  const r = await req('/auth/callback?code=good-code');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin');
  cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await (await req('/api/admin/me')).json();
  assert.equal(me.store_id, '123');
});

test('busca de produtos', async () => {
  const list = await (await req('/api/admin/products?q=bege')).json();
  assert.deepEqual(list.map(p => p.id), [101, 102]);
  assert.equal(list[0].variants[0].price, 329.9);
  assert.equal(list[0].variants[0].compare_at_price, 389.9);
  assert.equal(list[0].variants[1].available, false);
  const none = await (await req('/api/admin/products?q=xyz')).json();
  assert.deepEqual(none, []);
});

test('validação e CRUD de conjuntos', async () => {
  let r = await req('/api/admin/sets', { method: 'POST', body: JSON.stringify({ name: 'X', product_ids: [101] }) });
  assert.equal(r.status, 400);
  r = await req('/api/admin/sets', { method: 'POST', body: JSON.stringify({ name: 'Look bege', title: 'Complete o look', product_ids: [101, 102, 103, 104] }) });
  assert.equal(r.status, 201);
  const set = await r.json();
  const sets = await (await req('/api/admin/sets')).json();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].products.length, 4);
  r = await req('/api/admin/sets/' + set.id, { method: 'PUT', body: JSON.stringify({ ...set, active: false }) });
  assert.equal((await r.json()).active, false);
  const pub = await (await fetch(base + '/api/public/sets?store=123&product=101')).json();
  assert.equal(pub.sets.length, 0, 'conjunto pausado não aparece');
  await req('/api/admin/sets/' + set.id, { method: 'PUT', body: JSON.stringify({ ...set, active: true }) });
});

test('API pública para a vitrine', async () => {
  const r = await fetch(base + '/api/public/sets?store=123&product=102');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const data = await r.json();
  assert.equal(data.sets.length, 1);
  assert.equal(data.sets[0].title, 'Complete o look');
  assert.deepEqual(data.sets[0].products.map(p => p.id), [101, 102, 103], 'produto oculto é removido');
  assert.equal(data.settings.button_text, 'Comprar o conjunto');
  const none = await (await fetch(base + '/api/public/sets?store=123&product=999')).json();
  assert.deepEqual(none.sets, []);
  const noStore = await (await fetch(base + '/api/public/sets?store=1&product=101')).json();
  assert.deepEqual(noStore.sets, []);
});

test('configurações de aparência', async () => {
  const r = await req('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ button_text: 'Levar o look', primary_color: '#8a5a44', text_color: 'vermelho', after_add: 'reload' }) });
  const s = await r.json();
  assert.equal(s.button_text, 'Levar o look');
  assert.equal(s.primary_color, '#8a5a44');
  assert.equal(s.text_color, '#ffffff', 'cor inválida é ignorada');
  assert.equal(s.after_add, 'reload');
});

test('widget.js recebe a URL do app', async () => {
  const js = await (await fetch(base + '/widget.js')).text();
  assert.match(js, /var API_BASE = 'http:\/\/localhost:4101'/);
});

test('webhook de desinstalação remove a loja', async () => {
  const body = JSON.stringify({ store_id: 123, event: 'app/uninstalled' });
  const r = await fetch(base + '/webhooks/app/uninstalled', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  const me = await req('/api/admin/me');
  assert.equal(me.status, 401);
});

// ---------------- Novos recursos ----------------
const { hmac } = require('../src/session');
function nexoToken(storeId, secret = 'segredo', expIn = 300) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg: 'HS256', typ: 'JWT' }), body = b({ storeId, exp: Math.floor(Date.now() / 1000) + expIn });
  return `${head}.${body}.${hmac(secret, `${head}.${body}`)}`;
}

test('reinstala a loja para os próximos testes', async () => {
  const r = await req('/auth/callback?code=good-code');
  cookie = r.headers.get('set-cookie').split(';')[0];
  const me = await (await req('/api/admin/me')).json();
  assert.equal(me.store_name, 'Loja Teste');
  assert.equal(me.can_coupons, true);
});

test('painel dentro da Nuvemshop: token do Nexo', async () => {
  const ok = await fetch(base + '/api/admin/me', { headers: { Authorization: 'Bearer ' + nexoToken(123) } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).embedded, true);
  const bad = await fetch(base + '/api/admin/me', { headers: { Authorization: 'Bearer ' + nexoToken(123, 'outro') } });
  assert.equal(bad.status, 401);
  const expired = await fetch(base + '/api/admin/me', { headers: { Authorization: 'Bearer ' + nexoToken(123, 'segredo', -10) } });
  assert.equal(expired.status, 401);
  const html = await (await fetch(base + '/admin')).text();
  assert.match(html, /const APP_ID = '999'/);
});

test('login da agência', async () => {
  process.env.AGENCY_EMAIL = 'agencia@vorah.com';
  process.env.AGENCY_PASSWORD = 'senha-forte-123';
  const page = await (await fetch(base + '/login')).text();
  assert.match(page, /var AGENCY = true/);
  let r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'agencia@vorah.com', password: 'errada' }) });
  assert.equal(r.status, 401);
  r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'AGENCIA@vorah.com', password: 'senha-forte-123' }) });
  assert.equal(r.status, 200);
  const ag = r.headers.get('set-cookie').split(';')[0];
  const me0 = await fetch(base + '/api/admin/me', { headers: { cookie: ag } });
  assert.equal(me0.status, 401);
  assert.equal((await me0.json()).agency, true);
  const stores = await (await fetch(base + '/api/agency/stores', { headers: { cookie: ag } })).json();
  assert.equal(stores[0].name, 'Loja Teste');
  r = await fetch(base + '/api/agency/select', { method: 'POST', headers: { cookie: ag, 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: '123' }) });
  const ag2 = r.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(base + '/api/admin/me', { headers: { cookie: ag2 } })).json();
  assert.equal(me.agency, true);
  assert.equal(me.store_id, '123');
  // lojista comum não acessa a lista da agência
  assert.equal((await fetch(base + '/api/agency/stores', { headers: { cookie } })).status, 401);
});

test('sugestões automáticas', async () => {
  const list = (await (await req('/api/admin/suggestions')).json()).suggestions;
  const bozo = list.find(s => s.name === 'Conjunto Bozo');
  assert.ok(bozo, JSON.stringify(list));
  assert.deepEqual(bozo.products.map(p => p.id), [105, 106]);
  await req('/api/admin/sets', { method: 'POST', body: JSON.stringify({ name: bozo.name, product_ids: [105, 106] }) });
  const again = (await (await req('/api/admin/suggestions')).json()).suggestions;
  assert.ok(!again.find(s => s.name === 'Conjunto Bozo'), 'some depois de criado');
});

test('desconto cria, atualiza e remove o cupom', async () => {
  let r = await req('/api/admin/sets', { method: 'POST', body: JSON.stringify({ name: 'Promo', product_ids: [101, 102], discount_percent: 10 }) });
  const set = await r.json();
  assert.equal(set.discount_percent, 10);
  assert.match(set.coupon_code, /^LOOK\d+[A-Z0-9]{0,4}$/);
  let coupons = await (await fetch('http://localhost:4100/__coupons')).json();
  const c = coupons.find(x => x.code === set.coupon_code);
  assert.equal(c.value, '10'); assert.deepEqual(c.products, [101, 102]); assert.equal(c.type, 'percentage');
  const pub = await (await fetch(base + '/api/public/sets?store=123&product=101')).json();
  const ps = pub.sets.find(s => s.id === set.id);
  assert.equal(ps.discount_percent, 10); assert.equal(ps.coupon_code, set.coupon_code);
  r = await req('/api/admin/sets/' + set.id, { method: 'PUT', body: JSON.stringify({ ...set, discount_percent: 15 }) });
  coupons = await (await fetch('http://localhost:4100/__coupons')).json();
  assert.equal(coupons.find(x => x.code === set.coupon_code).value, '15');
  await req('/api/admin/sets/' + set.id, { method: 'DELETE' });
  coupons = await (await fetch('http://localhost:4100/__coupons')).json();
  assert.ok(!coupons.find(x => x.code === set.coupon_code), 'cupom removido');
  r = await req('/api/admin/sets', { method: 'POST', body: JSON.stringify({ name: 'X', product_ids: [101, 102], discount_percent: 80 }) });
  assert.equal(r.status, 400);
});

test('métricas da vitrine', async () => {
  const sets = await (await req('/api/admin/sets')).json();
  const id = sets[0].id;
  const send = body => fetch(base + '/api/public/track', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  for (let i = 0; i < 4; i++) assert.equal((await send({ store: 123, set: id, type: 'view' })).status, 204);
  await send({ store: 123, set: id, type: 'add', items: 2, value: 309.8 });
  assert.equal((await send({ store: 123, set: id, type: 'hack' })).status, 400);
  await send({ store: 999, set: id, type: 'add', items: 2, value: 1000 }); // loja errada: ignorado
  const m = await (await req('/api/admin/metrics?days=7')).json();
  const row = m.bySet.find(r => r.set_id === id);
  assert.equal(row.views, 4); assert.equal(row.adds, 1); assert.equal(row.items, 2); assert.equal(row.value, 309.8);
  assert.equal(m.byDay.length, 1);
});

test('aparência: estilo dos tamanhos e cantos', async () => {
  const s = await (await req('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ variant_style: 'select', radius: 99 }) })).json();
  assert.equal(s.variant_style, 'select'); assert.equal(s.radius, 40);
  const pub = await (await fetch(base + '/api/public/sets?store=123&product=105')).json();
  assert.equal(pub.settings.radius, 40);
});

test('desconto que não combina (padrão) e que combina', async () => {
  let set = await (await req('/api/admin/sets', { method: 'POST', body: JSON.stringify({ name: 'NC', product_ids: [101, 103], discount_percent: 10 }) })).json();
  assert.equal(set.combine_discounts, false);
  let coupons = await (await fetch('http://localhost:4100/__coupons')).json();
  assert.equal(coupons.find(c => c.code === set.coupon_code).combines_with_other_discounts, false);
  set = await (await req('/api/admin/sets/' + set.id, { method: 'PUT', body: JSON.stringify({ ...set, combine_discounts: true }) })).json();
  coupons = await (await fetch('http://localhost:4100/__coupons')).json();
  assert.equal(set.combine_discounts, true);
  assert.equal(coupons.find(c => c.code === set.coupon_code).combines_with_other_discounts, true);
  await req('/api/admin/sets/' + set.id, { method: 'DELETE' });
});

test('conjuntos por categoria', async () => {
  const cats = await (await req('/api/admin/categories')).json();
  assert.deepEqual(cats.map(c => c.name), ['Bermudas', 'Bermudas › Treta', 'Camisetas']);
  // o Conjunto Bozo já existe: some; apagando, volta pela categoria
  const sets = await (await req('/api/admin/sets')).json();
  const bozo = sets.find(s => s.name === 'Conjunto Bozo');
  await req('/api/admin/sets/' + bozo.id, { method: 'DELETE' });
  const full = await (await req('/api/admin/suggestions?categories=20,10')).json();
  let list = full.suggestions;
  assert.deepEqual(full.catalog['10'].map(p => p.id), [101, 105], 'peças da categoria para escolher');
  assert.deepEqual(full.catalog['20'].map(p => p.id), [106, 102]);
  assert.equal(list[0].products[0].category_id, 20);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].products.map(p => p.id), [106, 105], 'ordem das categorias escolhidas');
  list = (await (await req('/api/admin/suggestions?categories=10')).json()).suggestions;
  assert.equal(list.length, 0, 'só uma categoria não forma conjunto');
  list = (await (await req('/api/admin/suggestions?categories=10,20,999&all=1')).json()).suggestions;
  assert.equal(list.length, 0, 'exigir todas as categorias');
  // cria com desconto por categoria
  const r = await (await req('/api/admin/sets', { method: 'POST', body: JSON.stringify({ name: 'Cat', product_ids: [106, 105], discount_percent: 15, combine_discounts: false }) })).json();
  assert.equal(r.discount_percent, 15); assert.ok(r.coupon_code);
});
