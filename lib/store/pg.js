// Lưu trữ PostgreSQL (Railway: biến DATABASE_URL tham chiếu tới service Postgres)
const { Pool, types } = require('pg');

types.setTypeParser(20, Number);       // BIGINT -> number (số tiền VNĐ)
types.setTypeParser(1082, v => v);     // DATE -> 'YYYY-MM-DD'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Kết nối nội bộ Railway (*.railway.internal) không cần SSL; kết nối qua proxy công khai thì cần
  ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) || process.env.PGSSL === '0'
    ? false : { rejectUnauthorized: false },
  max: 10
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','ketoan','xem')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '',
  contract_value BIGINT NOT NULL DEFAULT 0,
  start_date DATE,
  end_date DATE
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  date DATE NOT NULL,
  project_id TEXT REFERENCES projects(id),
  category TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  kind TEXT NOT NULL CHECK (kind IN ('plan','actual')),
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS transactions_date_idx ON transactions (date);
CREATE INDEX IF NOT EXISTS transactions_project_idx ON transactions (project_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);`;

const toUser = r => r && ({ id: r.id, username: r.username, fullName: r.full_name, role: r.role, passwordHash: r.password_hash, createdAt: r.created_at });
const toProject = r => ({ id: r.id, code: r.code, name: r.name, client: r.client, contractValue: r.contract_value, start: r.start_date || '', end: r.end_date || '' });
const toTx = r => r && ({
  id: r.id, date: r.date, projectId: r.project_id, category: r.category, amount: r.amount, kind: r.kind, description: r.description,
  createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at
});

const q = (text, params) => pool.query(text, params);

async function insertProject(c, p) {
  await c.query('INSERT INTO projects (id, code, name, client, contract_value, start_date, end_date) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [p.id, p.code, p.name, p.client || '', p.contractValue || 0, p.start || null, p.end || null]);
}

async function insertTx(c, t) {
  await c.query(`INSERT INTO transactions (id, date, project_id, category, amount, kind, description, created_by, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [t.id, t.date, t.projectId || null, t.category, t.amount, t.kind, t.description || '', t.createdBy || null, t.createdAt || new Date()]);
}

const store = {
  kind: 'postgres',
  location: 'PostgreSQL',
  pool,

  async init() {
    await q(SCHEMA);
    await q("DELETE FROM audit_log WHERE at < now() - interval '365 days'"); // lưu nhật ký 12 tháng
  },
  async isEmpty() { return (await q('SELECT 1 FROM users LIMIT 1')).rowCount === 0; },

  // Ghi đè toàn bộ dữ liệu (dùng cho dữ liệu mẫu) trong một giao dịch
  async replaceAll({ users, projects, transactions, settings }) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('TRUNCATE transactions, projects, users, settings');
      for (const u of users) {
        await c.query('INSERT INTO users (id, username, full_name, role, password_hash) VALUES ($1,$2,$3,$4,$5)',
          [u.id, u.username, u.fullName, u.role, u.passwordHash]);
      }
      for (const p of projects) await insertProject(c, p);
      for (const t of transactions) await insertTx(c, t);
      for (const [k, v] of Object.entries(settings)) {
        await c.query('INSERT INTO settings (key, value) VALUES ($1,$2)', [k, JSON.stringify(v)]);
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  },

  async listUsers() { return (await q('SELECT * FROM users ORDER BY created_at')).rows.map(toUser); },
  async getUserByUsername(username) { return toUser((await q('SELECT * FROM users WHERE username = $1', [username])).rows[0]) || null; },
  async getUserById(id) { return toUser((await q('SELECT * FROM users WHERE id = $1', [id])).rows[0]) || null; },
  async createUser(u) {
    await q('INSERT INTO users (id, username, full_name, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [u.id, u.username, u.fullName, u.role, u.passwordHash]);
    return u;
  },
  async setUserPassword(id, passwordHash) { await q('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]); },
  async deleteUser(id) { await q('DELETE FROM users WHERE id = $1', [id]); },

  async getSettings() {
    return Object.fromEntries((await q('SELECT key, value FROM settings')).rows.map(r => [r.key, r.value]));
  },
  async updateSettings(patch) {
    for (const [k, v] of Object.entries(patch)) {
      await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, JSON.stringify(v)]);
    }
    return store.getSettings();
  },

  async listProjects() { return (await q('SELECT * FROM projects ORDER BY code')).rows.map(toProject); },
  async createProject(p) { await insertProject(pool, p); return p; },
  async deleteProject(id) { await q('DELETE FROM projects WHERE id = $1', [id]); },
  async projectHasTransactions(id) { return (await q('SELECT 1 FROM transactions WHERE project_id = $1 LIMIT 1', [id])).rowCount > 0; },

  async listTransactions({ from, to, projectId, kind } = {}) {
    const where = [], params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
    if (from) add('date >= ?', from);
    if (to) add('date <= ?', to);
    if (projectId === '_none') where.push('project_id IS NULL');
    else if (projectId) add('project_id = ?', projectId);
    if (kind) add('kind = ?', kind);
    const sql = 'SELECT * FROM transactions' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY date, created_at';
    return (await q(sql, params)).rows.map(toTx);
  },
  async createTransaction(t) { await insertTx(pool, t); return t; },
  async updateTransaction(id, t) {
    const r = await q(`UPDATE transactions SET date=$2, project_id=$3, category=$4, amount=$5, kind=$6, description=$7, updated_by=$8, updated_at=now()
      WHERE id = $1 RETURNING *`, [id, t.date, t.projectId || null, t.category, t.amount, t.kind, t.description || '', t.updatedBy]);
    return toTx(r.rows[0]) || null;
  },
  async deleteTransaction(id) { await q('DELETE FROM transactions WHERE id = $1', [id]); },

  async addAudit({ username, ip, action, detail }) {
    await q('INSERT INTO audit_log (username, ip, action, detail) VALUES ($1,$2,$3,$4)', [username || null, ip || null, action, detail || null]);
  },
  async listAudit(limit = 200) {
    return (await q('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT $1', [limit])).rows;
  }
};

module.exports = store;
