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
