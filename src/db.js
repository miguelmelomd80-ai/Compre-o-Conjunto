// Banco SQLite embutido no Node (node:sqlite) — sem dependências nativas.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dbFile = process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'app.db');
if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new DatabaseSync(dbFile);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS stores (
    store_id     TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    scope        TEXT,
    settings     TEXT NOT NULL DEFAULT '{}',
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    title       TEXT NOT NULL,
    product_ids TEXT NOT NULL,            -- JSON array, na ordem de exibição
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sets_store ON sets(store_id);
  -- Métricas agregadas por dia (sem dados pessoais de clientes)
  CREATE TABLE IF NOT EXISTS metrics (
    store_id TEXT NOT NULL,
    set_id   INTEGER NOT NULL,
    day      TEXT NOT NULL,
    views    INTEGER NOT NULL DEFAULT 0,
    adds     INTEGER NOT NULL DEFAULT 0,
    items    INTEGER NOT NULL DEFAULT 0,
    value    REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (store_id, set_id, day)
  );
`);

// Migrações: colunas novas em bancos que já existiam
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('stores', 'name', 'TEXT');
addColumn('stores', 'domain', 'TEXT');
addColumn('sets', 'discount_percent', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sets', 'coupon_id', 'TEXT');
addColumn('sets', 'coupon_code', 'TEXT');
addColumn('sets', 'combine_discounts', 'INTEGER NOT NULL DEFAULT 0');

const DEFAULT_SETTINGS = {
  button_text: 'Comprar o conjunto',
  primary_color: '#111111',
  text_color: '#ffffff',
  after_add: 'cart',       // 'cart' = vai para o carrinho | 'reload' = continua na página
  show_on_mobile: true,
  variant_style: 'buttons', // 'buttons' = tamanhos em botões | 'select' = lista
  radius: 8,                // cantos arredondados (px) do bloco, botões e seletores
};

function rowToSet(r) {
  return r && { ...r, active: !!r.active, product_ids: JSON.parse(r.product_ids), discount_percent: r.discount_percent || 0, combine_discounts: !!r.combine_discounts };
}

const today = () => new Date().toISOString().slice(0, 10);

module.exports = {
  db,
  DEFAULT_SETTINGS,

  // ---------- Lojas ----------
  saveStore(storeId, token, scope) {
    db.prepare(`
      INSERT INTO stores (store_id, access_token, scope) VALUES (?, ?, ?)
      ON CONFLICT(store_id) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope
    `).run(String(storeId), token, scope || '');
  },
  saveStoreInfo(storeId, name, domain) {
    db.prepare('UPDATE stores SET name = ?, domain = ? WHERE store_id = ?').run(name || null, domain || null, String(storeId));
  },
  getStore(storeId) {
    if (storeId == null) return null;
    const s = db.prepare('SELECT * FROM stores WHERE store_id = ?').get(String(storeId));
    if (!s) return null;
    return { ...s, settings: { ...DEFAULT_SETTINGS, ...JSON.parse(s.settings || '{}') } };
  },
  listStores() {
    return db.prepare(`
      SELECT s.store_id, s.name, s.domain, s.scope, s.installed_at,
        (SELECT COUNT(*) FROM sets WHERE sets.store_id = s.store_id) AS sets_count,
        (SELECT COUNT(*) FROM sets WHERE sets.store_id = s.store_id AND active = 1) AS active_sets
      FROM stores s ORDER BY COALESCE(s.name, s.store_id)
    `).all();
  },
  deleteStore(storeId) {
    for (const t of ['metrics', 'sets', 'stores']) db.prepare(`DELETE FROM ${t} WHERE store_id = ?`).run(String(storeId));
  },
  saveSettings(storeId, settings) {
    db.prepare('UPDATE stores SET settings = ? WHERE store_id = ?').run(JSON.stringify(settings), String(storeId));
  },

  // ---------- Conjuntos ----------
  listSets(storeId) {
    return db.prepare('SELECT * FROM sets WHERE store_id = ? ORDER BY id DESC').all(String(storeId)).map(rowToSet);
  },
  getSet(storeId, id) {
    return rowToSet(db.prepare('SELECT * FROM sets WHERE store_id = ? AND id = ?').get(String(storeId), Number(id)));
  },
  createSet(storeId, { name, title, product_ids, active, discount_percent, combine_discounts }) {
    const r = db.prepare('INSERT INTO sets (store_id, name, title, product_ids, active, discount_percent, combine_discounts) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(storeId), name, title, JSON.stringify(product_ids), active ? 1 : 0, discount_percent || 0, combine_discounts ? 1 : 0);
    return this.getSet(storeId, r.lastInsertRowid);
  },
  updateSet(storeId, id, { name, title, product_ids, active, discount_percent, combine_discounts }) {
    db.prepare(`UPDATE sets SET name = ?, title = ?, product_ids = ?, active = ?, discount_percent = ?, combine_discounts = ?, updated_at = datetime('now')
                WHERE store_id = ? AND id = ?`)
      .run(name, title, JSON.stringify(product_ids), active ? 1 : 0, discount_percent || 0, combine_discounts ? 1 : 0, String(storeId), Number(id));
    return this.getSet(storeId, id);
  },
  setCoupon(storeId, id, couponId, code) {
    db.prepare('UPDATE sets SET coupon_id = ?, coupon_code = ? WHERE store_id = ? AND id = ?')
      .run(couponId != null ? String(couponId) : null, code || null, String(storeId), Number(id));
  },
  deleteSet(storeId, id) {
    db.prepare('DELETE FROM sets WHERE store_id = ? AND id = ?').run(String(storeId), Number(id));
    db.prepare('DELETE FROM metrics WHERE store_id = ? AND set_id = ?').run(String(storeId), Number(id));
  },
  activeSetsForProduct(storeId, productId) {
    return this.listSets(storeId).filter(s => s.active && s.product_ids.map(String).includes(String(productId)));
  },

  // ---------- Métricas ----------
  track(storeId, setId, type, items = 0, value = 0) {
    const col = type === 'add' ? 'adds' : 'views';
    db.prepare(`
      INSERT INTO metrics (store_id, set_id, day, ${col}, items, value) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(store_id, set_id, day) DO UPDATE SET ${col} = ${col} + 1, items = items + excluded.items, value = value + excluded.value
    `).run(String(storeId), Number(setId), today(), type === 'add' ? items : 0, type === 'add' ? value : 0);
  },
  metrics(storeId, days) {
    const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    const bySet = db.prepare(`
      SELECT set_id, SUM(views) views, SUM(adds) adds, SUM(items) items, ROUND(SUM(value), 2) value
      FROM metrics WHERE store_id = ? AND day >= ? GROUP BY set_id
    `).all(String(storeId), since);
    const byDay = db.prepare(`
      SELECT day, SUM(views) views, SUM(adds) adds, ROUND(SUM(value), 2) value
      FROM metrics WHERE store_id = ? AND day >= ? GROUP BY day ORDER BY day
    `).all(String(storeId), since);
    return { since, bySet, byDay };
  },
};
