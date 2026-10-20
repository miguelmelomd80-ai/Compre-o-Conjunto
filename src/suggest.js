// Sugestões automáticas de conjuntos: agrupa peças de tipos diferentes com a mesma estampa/coleção no nome.
// Ex.: "Camiseta Premium Deus do Trovão" + "Bermuda Premium Deus do Trovão (TRETA)" + "Mochila Deus do Trovão 306"
//      → todas viram a chave "deus trovao".

const TYPES = [
  'camiseta', 'camisa', 'polo', 'regata', 'blazer', 'cardigan', 'tricot', 'sueter', 'cropped', 'top', 'blusa', 'body', 'moletom', 'blusao', 'jaqueta', 'casaco', 'colete',
  'bermuda', 'short', 'shorts', 'calca', 'legging', 'saia', 'vestido', 'macacao', 'macaquinho', 'conjunto',
  'mochila', 'bolsa', 'bone', 'chapeu', 'meia', 'meias', 'tenis', 'sandalia', 'chinelo', 'sapato', 'bota',
  'brinco', 'colar', 'pulseira', 'anel', 'cinto', 'oculos', 'carteira', 'necessaire', 'pochete', 'kit',
];
const NOISE = new Set([
  'premium', 'mm', 'basica', 'basico', 'oversized', 'over', 'slim', 'fit', 'dryfit', 'dry', 'manga', 'longa', 'curta',
  'feminina', 'feminino', 'masculina', 'masculino', 'unissex', 'infantil', 'plus', 'size', 'new', 'nova', 'novo',
  'de', 'do', 'da', 'dos', 'das', 'e', 'com', 'the', 'a', 'o', 'em', 'para',
]);

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function analyze(name) {
  const clean = norm(name).replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  const words = clean.split(/\s+/).filter(Boolean);
  const type = words.find(w => TYPES.includes(w)) || null;
  const rest = words.filter(w => w !== type && !TYPES.includes(w) && !NOISE.has(w) && !/^\d+$/.test(w));
  return { type, key: rest.join(' ') };
}

// Recupera o trecho original do nome (com acentos), do primeiro ao último termo da chave: "Deus do Trovão"
function niceLabel(name, key) {
  const keyWords = new Set(key.split(' '));
  const words = String(name).replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);
  const idx = words.map((w, i) => (keyWords.has(norm(w).replace(/[^a-z0-9]/g, '')) ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return key;
  return words.slice(idx[0], idx[idx.length - 1] + 1).join(' ');
}

// products: [{ id, name, image, published, variants, categories }]  ·  existingSets: [{ product_ids }]
// options.categoryIds: monta os conjuntos por categoria — uma peça de cada categoria escolhida, com a mesma estampa.
function suggestSets(products, existingSets = [], options = {}) {
  const cats = (options.categoryIds || []).map(Number).filter(Boolean);
  const byCategory = cats.length > 0;
  const groups = new Map();
  for (const p of products) {
    if (p.published === false) continue;
    const { type, key } = analyze(p.name);
    if (!key || key.length < 3) continue;
    let slot = type;
    if (byCategory) {
      const pc = (p.categories || []).map(Number);
      const hit = cats.find(c => pc.includes(c));
      if (hit == null) continue;
      slot = 'cat:' + hit;
    }
    if (!slot) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...p, _slot: slot });
  }
  const order = s => (byCategory ? cats.indexOf(Number(s.slice(4))) : TYPES.indexOf(s));
  const covered = existingSets.map(s => new Set(s.product_ids.map(String)));
  const out = [];
  for (const [key, list] of groups) {
    // uma peça por tipo/categoria (a primeira encontrada), no máximo 8
    const bySlot = new Map();
    for (const p of list) if (!bySlot.has(p._slot)) bySlot.set(p._slot, p);
    const picked = [...bySlot.values()]
      .sort((a, b) => order(a._slot) - order(b._slot)) // parte de cima, de baixo, acessórios
      .slice(0, 8);
    if (picked.length < 2) continue;
    if (byCategory && options.requireAll && picked.length < cats.length) continue;
    const ids = picked.map(p => String(p.id));
    if (covered.some(c => ids.every(id => c.has(id)))) continue; // já existe um conjunto com essas peças
    const label = niceLabel(picked[0].name, key);
    out.push({
      key,
      name: `Conjunto ${label}`,
      products: picked.map(p => ({ id: p.id, name: p.name, image: p.image,
        category_id: byCategory ? Number(p._slot.slice(4)) : null })),
    });
  }
  return out.sort((a, b) => b.products.length - a.products.length || a.name.localeCompare(b.name));
}

module.exports = { suggestSets, analyze };
