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
`);

const DEFAULT_SETTINGS = {
  button_text: 'Comprar o conjunto',
  primary_color: '#111111',
  text_color: '#ffffff',
  after_add: 'cart', // 'cart' = vai para o carrinho | 'reload' = recarrega a página
  show_on_mobile: true,
};

function rowToSet(r) {
  return r && { ...r, active: !!r.active, product_ids: JSON.parse(r.product_ids) };
}

module.exports = {
  db,
  DEFAULT_SETTINGS,

  saveStore(storeId, token, scope) {
    db.prepare(`
      INSERT INTO stores (store_id, access_token, scope) VALUES (?, ?, ?)
      ON CONFLICT(store_id) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope
    `).run(String(storeId), token, scope || '');
  },
  getStore(storeId) {
    const s = db.prepare('SELECT * FROM stores WHERE store_id = ?').get(String(storeId));
    if (!s) return null;
    return { ...s, settings: { ...DEFAULT_SETTINGS, ...JSON.parse(s.settings || '{}') } };
  },
  deleteStore(storeId) {
    db.prepare('DELETE FROM sets WHERE store_id = ?').run(String(storeId));
    db.prepare('DELETE FROM stores WHERE store_id = ?').run(String(storeId));
  },
  saveSettings(storeId, settings) {
    db.prepare('UPDATE stores SET settings = ? WHERE store_id = ?').run(JSON.stringify(settings), String(storeId));
  },

  listSets(storeId) {
    return db.prepare('SELECT * FROM sets WHERE store_id = ? ORDER BY id DESC').all(String(storeId)).map(rowToSet);
  },
  getSet(storeId, id) {
    return rowToSet(db.prepare('SELECT * FROM sets WHERE store_id = ? AND id = ?').get(String(storeId), Number(id)));
  },
  createSet(storeId, { name, title, product_ids, active }) {
    const r = db.prepare('INSERT INTO sets (store_id, name, title, product_ids, active) VALUES (?, ?, ?, ?, ?)')
      .run(String(storeId), name, title, JSON.stringify(product_ids), active ? 1 : 0);
    return this.getSet(storeId, r.lastInsertRowid);
  },
  updateSet(storeId, id, { name, title, product_ids, active }) {
    db.prepare(`UPDATE sets SET name = ?, title = ?, product_ids = ?, active = ?, updated_at = datetime('now')
                WHERE store_id = ? AND id = ?`)
      .run(name, title, JSON.stringify(product_ids), active ? 1 : 0, String(storeId), Number(id));
    return this.getSet(storeId, id);
  },
  deleteSet(storeId, id) {
    db.prepare('DELETE FROM sets WHERE store_id = ? AND id = ?').run(String(storeId), Number(id));
  },
  // Conjuntos ativos que contêm o produto
  activeSetsForProduct(storeId, productId) {
    return this.listSets(storeId).filter(s => s.active && s.product_ids.map(String).includes(String(productId)));
  },
};
