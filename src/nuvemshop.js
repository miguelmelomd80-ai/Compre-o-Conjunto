// Cliente da API Nuvemshop (OAuth + REST).
const API_BASE = process.env.NUVEMSHOP_API_BASE || 'https://api.nuvemshop.com.br';
const API_VERSION = process.env.NUVEMSHOP_API_VERSION || '2025-03';
const AUTH_BASE = process.env.NUVEMSHOP_AUTH_BASE || 'https://www.nuvemshop.com.br';
const USER_AGENT = process.env.NUVEMSHOP_USER_AGENT || 'Compre o Conjunto (contato@exemplo.com)';

// Troca o "code" recebido na instalação por um access_token permanente.
async function exchangeCode(code) {
  const res = await fetch(`${AUTH_BASE}/apps/authorize/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      client_id: process.env.NUVEMSHOP_APP_ID,
      client_secret: process.env.NUVEMSHOP_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Falha ao obter token: ${res.status} ${JSON.stringify(data)}`);
  }
  return data; // { access_token, token_type, scope, user_id }
}

async function api(store, method, pathname, body) {
  const url = `${API_BASE}/${API_VERSION}/${store.store_id}${pathname}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        // A Nuvemshop aceita "Authorization: Bearer"; o cabeçalho legado "Authentication" é mantido por compatibilidade.
        Authorization: `Bearer ${store.access_token}`,
        Authentication: `bearer ${store.access_token}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) { // limite de requisições: espera e tenta de novo
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (res.status === 404) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`API Nuvemshop ${res.status}: ${JSON.stringify(data)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('API Nuvemshop: limite de requisições excedido');
}

// Textos multilíngues vêm como { pt: "...", es: "..." }
const t = v => (v && typeof v === 'object' ? (v.pt || v.es || v.en || Object.values(v)[0] || '') : (v ?? ''));

function normalizeProduct(p) {
  const attributes = (p.attributes || []).map(t);
  const variants = (p.variants || []).map(v => {
    const price = Number(v.price || 0);
    const promo = v.promotional_price != null ? Number(v.promotional_price) : null;
    const hasStock = !v.stock_management || v.stock == null || Number(v.stock) > 0;
    return {
      id: v.id,
      values: (v.values || []).map(t),
      price: promo && promo < price ? promo : price,
      compare_at_price: promo && promo < price ? price : null,
      available: hasStock,
      image_id: v.image_id || null,
    };
  });
  return {
    id: p.id,
    name: t(p.name),
    url: p.canonical_url || '',
    image: (p.images && p.images[0] && p.images[0].src) || null,
    images: (p.images || []).map(i => ({ id: i.id, src: i.src })),
    published: p.published !== false,
    categories: (p.categories || []).map(c => c.id),
    attributes,
    variants,
  };
}

// Cache curto para não estourar o limite da API quando a vitrine tiver muito acesso.
const cache = new Map();
const TTL = Number(process.env.PRODUCT_CACHE_SECONDS || 120) * 1000;

async function getProduct(store, productId) {
  const key = `${store.store_id}:${productId}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const raw = await api(store, 'GET', `/products/${productId}`);
  const value = raw ? normalizeProduct(raw) : null;
  cache.set(key, { value, exp: Date.now() + TTL });
  return value;
}

async function searchProducts(store, q) {
  const params = new URLSearchParams({ per_page: '30' });
  if (q) params.set('q', q);
  const list = await api(store, 'GET', `/products?${params}`);
  return (list || []).map(normalizeProduct);
}

// Todos os produtos da loja (até 2.000), para as sugestões automáticas de conjuntos
async function listAllProducts(store) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const list = await api(store, 'GET', `/products?per_page=200&page=${page}`);
    if (!list || !list.length) break;
    all.push(...list.map(normalizeProduct));
    for (const p of all.slice(-list.length)) cache.set(`${store.store_id}:${p.id}`, { value: p, exp: Date.now() + TTL });
    if (list.length < 200) break;
  }
  return all;
}

// Categorias da loja (para montar conjuntos por categoria)
async function listCategories(store) {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const list = await api(store, 'GET', `/categories?per_page=200&page=${page}`);
    if (!list || !list.length) break;
    all.push(...list.map(c => ({ id: c.id, name: t(c.name), parent: c.parent || null })));
    if (list.length < 200) break;
  }
  // nome completo: "Bermudas > Treta"
  const byId = Object.fromEntries(all.map(c => [c.id, c]));
  const full = c => (c.parent && byId[c.parent] ? full(byId[c.parent]) + ' › ' : '') + c.name;
  return all.map(c => ({ id: c.id, name: full(c), parent: c.parent })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

// Nome e domínio da loja (para a lista da agência)
async function getStoreInfo(store) {
  const s = await api(store, 'GET', '/store');
  if (!s) return null;
  return { name: t(s.name) || s.business_name || null, domain: s.url_with_protocol || (s.original_domain ? `https://${s.original_domain}` : null) };
}

// ---------- Cupons (desconto do conjunto) ----------
function couponCode(setId) {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `LOOK${setId}${rand}`.replace(/[^A-Z0-9]/g, '');
}
async function upsertCoupon(store, set) {
  const body = {
    type: 'percentage',
    value: String(set.discount_percent),
    valid: true,
    products: set.product_ids,
    combines_with_other_discounts: !!set.combine_discounts,
  };
  if (set.coupon_id) {
    try {
      await api(store, 'PUT', `/coupons/${set.coupon_id}`, { code: set.coupon_code, ...body });
      return { id: set.coupon_id, code: set.coupon_code };
    } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
  }
  const code = couponCode(set.id);
  const c = await api(store, 'POST', '/coupons', { code, ...body });
  return { id: c.id, code: c.code || code };
}
async function deleteCoupon(store, couponId) {
  if (!couponId) return;
  try { await api(store, 'DELETE', `/coupons/${couponId}`); } catch (e) { console.warn('Cupom não removido:', e.message); }
}

function clearCache(storeId) {
  for (const k of cache.keys()) if (k.startsWith(`${storeId}:`)) cache.delete(k);
}

module.exports = {
  exchangeCode, api, getProduct, searchProducts, listAllProducts, listCategories, getStoreInfo, upsertCoupon, deleteCoupon,
  normalizeProduct, clearCache, AUTH_BASE,
};
