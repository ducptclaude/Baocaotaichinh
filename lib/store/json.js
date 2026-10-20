// Lưu trữ file JSON – dùng khi chạy thử trên máy, không có PostgreSQL
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'db.json');
let state;

function save() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}

const store = {
  kind: 'json',
  location: DB_FILE,

  async init() {
    state = fs.existsSync(DB_FILE)
      ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
      : { users: [], projects: [], transactions: [], settings: {} };
    state.audit = state.audit || [];
  },
  async isEmpty() { return state.users.length === 0; },
  async replaceAll(data) { state = { audit: state?.audit || [], ...structuredClone(data) }; save(); },

  async listUsers() { return state.users; },
  async getUserByUsername(username) { return state.users.find(u => u.username === username) || null; },
  async getUserById(id) { return state.users.find(u => u.id === id) || null; },
  async createUser(u) { state.users.push(u); save(); return u; },
  async setUserPassword(id, passwordHash) { const u = state.users.find(x => x.id === id); if (u) u.passwordHash = passwordHash; save(); },
  async deleteUser(id) { state.users = state.users.filter(u => u.id !== id); save(); },

  async getSettings() { return state.settings; },
  async updateSettings(patch) { Object.assign(state.settings, patch); save(); return state.settings; },

  async listProjects() { return state.projects; },
  async createProject(p) { state.projects.push(p); save(); return p; },
  async deleteProject(id) { state.projects = state.projects.filter(p => p.id !== id); save(); },
  async projectHasTransactions(id) { return state.transactions.some(t => t.projectId === id); },

  async listTransactions({ from, to, projectId, kind } = {}) {
    return state.transactions.filter(t =>
      (!from || t.date >= from) && (!to || t.date <= to) &&
      (!projectId || (projectId === '_none' ? !t.projectId : t.projectId === projectId)) &&
      (!kind || t.kind === kind));
  },
  async createTransaction(t) { state.transactions.push(t); save(); return t; },
  async updateTransaction(id, patch) {
    const t = state.transactions.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch); save(); return t;
  },
  async deleteTransaction(id) { state.transactions = state.transactions.filter(t => t.id !== id); save(); },

  async addAudit(e) {
    state.audit.push({ id: state.audit.length + 1, at: new Date().toISOString(), ...e });
    if (state.audit.length > 5000) state.audit = state.audit.slice(-5000);
    save();
  },
  async listAudit(limit = 200) { return state.audit.slice(-limit).reverse(); }
};

module.exports = store;
