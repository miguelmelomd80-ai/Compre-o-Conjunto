// Simula a API da Nuvemshop e uma vitrine com tema padrão, para testes locais.
const express = require('express');

const products = [
  { id: 101, name: { pt: 'Blazer Alfaiataria Bege' }, published: true, canonical_url: '/produtos/blazer/',
    attributes: [{ pt: 'Tamanho' }], images: [{ id: 1, src: 'https://placehold.co/200x200?text=Blazer' }],
    variants: [
      { id: 1011, values: [{ pt: 'P' }], price: '389.90', promotional_price: '329.90', stock_management: true, stock: 3 },
      { id: 1012, values: [{ pt: 'M' }], price: '389.90', promotional_price: '329.90', stock_management: true, stock: 0 },
      { id: 1013, values: [{ pt: 'G' }], price: '389.90', promotional_price: '329.90', stock_management: true, stock: 5 },
    ] },
  { id: 102, name: { pt: 'Calça Pantalona Bege' }, published: true, canonical_url: '/produtos/calca/',
    attributes: [{ pt: 'Cor' }, { pt: 'Tamanho' }], images: [{ id: 2, src: 'https://placehold.co/200x200?text=Calca' }],
    variants: [
      { id: 1021, values: [{ pt: 'Bege' }, { pt: '38' }], price: '259.90', promotional_price: null, stock_management: true, stock: 2 },
      { id: 1022, values: [{ pt: 'Bege' }, { pt: '40' }], price: '259.90', promotional_price: null, stock_management: true, stock: 2 },
    ] },
  { id: 103, name: { pt: 'Cinto Couro' }, published: true, canonical_url: '/produtos/cinto/',
    attributes: [], images: [], variants: [{ id: 1031, values: [], price: '99.00', stock_management: false, stock: null }] },
  { id: 104, name: { pt: 'Produto Oculto' }, published: false, canonical_url: '/produtos/oculto/', attributes: [], images: [],
    variants: [{ id: 1041, values: [], price: '10', stock_management: false }] },
];

function start(port, { appUrl } = {}) {
  const app = express();
  const cart = [];

  // ---- API REST
  app.use(/^\/(v1|\d{4}-\d{2})\/\d+/, (req, res, next) => {
    if (!/Bearer tok-123/.test(req.get('authorization') || '')) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  app.get('/:ver/:store/products', (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    const list = products.filter(p => !q || p.name.pt.toLowerCase().includes(q));
    if (!list.length) return res.status(404).json({ code: 404, message: 'Not Found', description: 'Last page is 0' });
    res.json(list);
  });
  app.get('/:ver/:store/products/:id', (req, res) => {
    const p = products.find(x => String(x.id) === req.params.id);
    p ? res.json(p) : res.status(404).json({});
  });

  // ---- OAuth
  app.post('/apps/authorize/token', express.json(), (req, res) => {
    if (req.body.code !== 'good-code') return res.status(400).json({ error: 'invalid_grant' });
    res.json({ access_token: 'tok-123', token_type: 'bearer', scope: 'read_products,write_scripts', user_id: 123 });
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
