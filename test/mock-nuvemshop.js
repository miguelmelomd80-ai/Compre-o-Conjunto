// Simula a API da Nuvemshop e uma vitrine com tema padrão, para testes locais.
const express = require('express');

const products = [
  { id: 101, name: { pt: 'Blazer Alfaiataria Bege' }, published: true, categories: [{ id: 10 }], canonical_url: '/produtos/blazer/',
    attributes: [{ pt: 'Tamanho' }], images: [{ id: 1, src: 'https://placehold.co/200x200?text=Blazer' }],
    variants: [
      { id: 1011, values: [{ pt: 'P' }], price: '389.90', promotional_price: '329.90', stock_management: true, stock: 3 },
      { id: 1012, values: [{ pt: 'M' }], price: '389.90', promotional_price: '329.90', stock_management: true, stock: 0 },
      { id: 1013, values: [{ pt: 'G' }], price: '389.90', promotional_price: '329.90', stock_management: true, stock: 5 },
    ] },
  { id: 102, name: { pt: 'Calça Pantalona Bege' }, published: true, categories: [{ id: 20 }], canonical_url: '/produtos/calca/',
    attributes: [{ pt: 'Cor' }, { pt: 'Tamanho' }], images: [{ id: 2, src: 'https://placehold.co/200x200?text=Calca' }],
    variants: [
      { id: 1021, values: [{ pt: 'Bege' }, { pt: '38' }], price: '259.90', promotional_price: null, stock_management: true, stock: 2 },
      { id: 1022, values: [{ pt: 'Bege' }, { pt: '40' }], price: '259.90', promotional_price: null, stock_management: true, stock: 2 },
    ] },
  { id: 103, name: { pt: 'Cinto Couro' }, published: true, canonical_url: '/produtos/cinto/',
    attributes: [], images: [], variants: [{ id: 1031, values: [], price: '99.00', stock_management: false, stock: null }] },
  { id: 105, name: { pt: 'Camiseta Premium Bozo' }, published: true, categories: [{ id: 10 }], canonical_url: '/produtos/camiseta-bozo/',
    attributes: [{ pt: 'Tamanho' }], images: [], variants: [{ id: 1051, values: [{ pt: 'M' }], price: '189.90', stock_management: false }, { id: 1052, values: [{ pt: 'G' }], price: '189.90', stock_management: false }] },
  { id: 106, name: { pt: 'Bermuda Premium Bozo (TRETA)' }, published: true, categories: [{ id: 20 }, { id: 21 }], canonical_url: '/produtos/bermuda-bozo/',
    attributes: [{ pt: 'Tamanho' }], images: [], variants: [{ id: 1061, values: [{ pt: '40' }], price: '119.90', stock_management: false }, { id: 1062, values: [{ pt: 'G' }], price: '119.90', stock_management: false }] },
  { id: 104, name: { pt: 'Produto Oculto' }, published: false, canonical_url: '/produtos/oculto/', attributes: [], images: [],
    variants: [{ id: 1041, values: [], price: '10', stock_management: false }] },
];

function start(port, { appUrl } = {}) {
  const app = express();
  const cart = [];
  const applied = [];

  // ---- API REST
  app.use(/^\/(v1|\d{4}-\d{2})\/\d+/, (req, res, next) => {
    if (!/Bearer tok-123/.test(req.get('authorization') || '')) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  const coupons = [];
  app.get('/:ver/:store/products', (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    const page = Number(req.query.page || 1);
    let list = products.filter(p => !q || p.name.pt.toLowerCase().includes(q));
    if (page > 1) list = [];
    if (!list.length) return res.status(404).json({ code: 404, message: 'Not Found', description: 'Last page is 0' });
    res.json(list);
  });
  app.get('/:ver/:store/products/:id', (req, res) => {
    const p = products.find(x => String(x.id) === req.params.id);
    p ? res.json(p) : res.status(404).json({});
  });

  app.get('/:ver/:store/categories', (req, res) => res.json(Number(req.query.page || 1) > 1 ? [] : [
    { id: 10, name: { pt: 'Camisetas' }, parent: null }, { id: 20, name: { pt: 'Bermudas' }, parent: null }, { id: 21, name: { pt: 'Treta' }, parent: 20 }]));
  app.get('/:ver/:store/store', (req, res) => res.json({ id: 123, name: { pt: 'Loja Teste' }, url_with_protocol: 'https://loja-teste.com.br' }));
  app.post('/:ver/:store/coupons', express.json(), (req, res) => {
    if (process.env.MOCK_NO_COUPONS) return res.status(403).json({ error: 'forbidden' });
    const c = { id: 900 + coupons.length, ...req.body }; coupons.push(c); res.status(201).json(c);
  });
  app.put('/:ver/:store/coupons/:id', express.json(), (req, res) => {
    const c = coupons.find(x => String(x.id) === req.params.id);
    if (!c) return res.status(404).json({}); Object.assign(c, req.body); res.json(c);
  });
  app.delete('/:ver/:store/coupons/:id', (req, res) => {
    const i = coupons.findIndex(x => String(x.id) === req.params.id);
    if (i >= 0) coupons.splice(i, 1); res.json({});
  });
  app.get('/__coupons', (req, res) => res.json(coupons));
  app.get('/discount/:code', (req, res) => { applied.push(req.params.code); res.redirect(303, req.query.redirect_to || '/'); });
  app.get('/__applied', (req, res) => res.json(applied));

  // ---- OAuth
  app.post('/apps/authorize/token', express.json(), (req, res) => {
    if (req.body.code !== 'good-code') return res.status(400).json({ error: 'invalid_grant' });
    res.json({ access_token: 'tok-123', token_type: 'bearer', scope: 'read_products,write_scripts,write_coupons', user_id: 123 });
  });

  // ---- Vitrine (tema simplificado, com o mesmo formulário do tema base)
  const optId = (p, attrIdx, value) => `${p.id}-${attrIdx}-${value}`;
  function page(p) {
    const vals = p.attributes.map((a, i) => [...new Set(p.variants.map(v => v.values[i].pt))]);
    const selects = p.attributes.map((a, i) => `<label>${a.pt}<select name="variation[${p.id}${i}]">` +
      vals[i].map(v => `<option value="${optId(p, i, v)}">${v}</option>`).join('') + '</select></label>').join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${p.name.pt}</title>
      <script>window.LS = { store: { id: 123, url: location.origin }, product: { id: ${p.id} }, currency: { code: 'BRL' } };</script>
      </head><body><h1>${p.name.pt}</h1>
      <form id="product_form" class="js-product-form" method="post" action="/comprar/">
        <input type="hidden" name="add_to_cart" value="${p.id}">${selects}
        <input type="number" name="quantity" value="1"><input type="submit" value="Comprar">
      </form>
      ${appUrl ? `<script src="${appUrl}/widget.js"></script>` : ''}
      </body></html>`;
  }
  app.get('/produtos/:slug/', (req, res) => {
    const p = products.find(x => x.canonical_url === `/produtos/${req.params.slug}/`);
    p ? res.send(page(p)) : res.sendStatus(404);
  });
  app.post('/comprar/', express.urlencoded({ extended: false }), (req, res) => {
    const p = products.find(x => String(x.id) === req.body.add_to_cart);
    if (!p) return res.status(400).send('produto inválido');
    const chosen = p.attributes.map((a, i) => {
      const key = Object.keys(req.body).find(k => k === `variation[${p.id}${i}]`);
      return String(req.body[key] || '').split('-').slice(2).join('-');
    });
    const v = p.variants.find(v => v.values.every((x, i) => x.pt === chosen[i]));
    if (!v) return res.status(400).send('variação inválida');
    cart.push({ product: p.id, variant: v.id, qty: Number(req.body.quantity || 1) });
    res.redirect(303, '/comprar/');
  });
  app.get('/comprar/', (req, res) => res.send('<h1>Carrinho</h1><pre id="cart">' + JSON.stringify(cart) + '</pre>'));
  app.get('/__cart', (req, res) => res.json(cart));

  return new Promise(r => { const srv = app.listen(port, () => r({ srv, cart })); });
}

module.exports = { start, products };
if (require.main === module) start(Number(process.env.MOCK_PORT || 4000), { appUrl: process.env.APP_URL || 'http://localhost:3000' })
  .then(() => console.log('Mock Nuvemshop em http://localhost:' + (process.env.MOCK_PORT || 4000)));
