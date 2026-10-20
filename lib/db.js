// Lưu trữ dạng file JSON đơn giản cho bản sơ khai.
// Khi mở rộng có thể thay bằng PostgreSQL/SQL Server mà không đổi API phía trên.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');

let state = null;

function load() {
  if (state) return state;
  if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    state = { users: [], projects: [], transactions: [], settings: { openingBalance: 0, companyName: '' } };
  }
  return state;
}

function save() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function id() {
  return crypto.randomUUID();
}

module.exports = { load, save, id, DB_FILE };
