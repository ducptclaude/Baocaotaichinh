const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const db = require('./lib/db');
const { seed } = require('./lib/seed');
const { CATEGORIES, ACTIVITIES, byCode } = require('./lib/categories');

const PORT = process.env.PORT || 3000;
if (seed()) console.log('Khởi tạo dữ liệu mẫu lần đầu. Tài khoản: admin / Admin@123 (hãy đổi mật khẩu).');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'bctc.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 8 * 3600 * 1000 }
}));

// ---------- Xác thực ----------
const loginAttempts = new Map(); // chống dò mật khẩu: tối đa 5 lần sai / 15 phút / IP

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Chỉ quản trị viên được thực hiện' });
}

function requireEditor(req, res, next) {
  if (['admin', 'ketoan'].includes(req.session.user?.role)) return next();
  res.status(403).json({ error: 'Tài khoản chỉ có quyền xem' });
}

const publicUser = u => ({ id: u.id, username: u.username, fullName: u.fullName, role: u.role });

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
  if (rec.count >= 5) return res.status(429).json({ error: 'Sai quá nhiều lần, thử lại sau 15 phút' });

  const { username, password } = req.body || {};
  const user = db.load().users.find(u => u.username === String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.passwordHash)) {
    rec.count++;
    loginAttempts.set(ip, rec);
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  loginAttempts.delete(ip);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Lỗi phiên đăng nhập' });
    req.session.user = publicUser(user);
    res.json({ user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use('/vendor', requireAuth, express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use(requireAuth);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/me', (req, res) => res.json({ user: req.session.user }));

app.post('/api/me/password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const state = db.load();
  const user = state.users.find(u => u.id === req.session.user.id);
  if (!user || !bcrypt.compareSync(String(oldPassword || ''), user.passwordHash)) return res.status(400).json({ error: 'Mật khẩu cũ không đúng' });
  if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 8 ký tự' });
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  db.save();
  res.json({ ok: true });
});

// ---------- Người dùng (admin) ----------
const ROLES = ['admin', 'ketoan', 'xem'];

app.get('/api/users', requireAdmin, (req, res) => res.json(db.load().users.map(publicUser)));

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, fullName, role, password } = req.body || {};
  const state = db.load();
  if (!username || !password || String(password).length < 8) return res.status(400).json({ error: 'Cần tên đăng nhập và mật khẩu tối thiểu 8 ký tự' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  if (state.users.some(u => u.username === username)) return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
  const user = { id: db.id(), username: String(username).trim(), fullName: fullName || username, role, passwordHash: bcrypt.hashSync(password, 10), createdAt: new Date().toISOString() };
  state.users.push(user);
  db.save();
  res.json(publicUser(user));
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const state = db.load();
  if (req.params.id === req.session.user.id) return res.status(400).json({ error: 'Không thể xoá chính mình' });
  state.users = state.users.filter(u => u.id !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Danh mục & thiết lập ----------
app.get('/api/meta', (req, res) => {
  const s = db.load();
  res.json({ categories: CATEGORIES, activities: ACTIVITIES, settings: s.settings, projects: s.projects });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const s = db.load();
  const { openingBalance, companyName } = req.body || {};
  if (openingBalance !== undefined) s.settings.openingBalance = Number(openingBalance) || 0;
  if (companyName !== undefined) s.settings.companyName = String(companyName);
  db.save();
  res.json(s.settings);
});

// ---------- Dự án ----------
app.post('/api/projects', requireEditor, (req, res) => {
  const { code, name, client, contractValue, start, end } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Cần mã và tên dự án' });
  const s = db.load();
  const p = { id: db.id(), code, name, client: client || '', contractValue: Number(contractValue) || 0, start: start || '', end: end || '' };
  s.projects.push(p);
  db.save();
  res.json(p);
});

app.delete('/api/projects/:id', requireAdmin, (req, res) => {
  const s = db.load();
  if (s.transactions.some(t => t.projectId === req.params.id)) return res.status(400).json({ error: 'Dự án đã có phát sinh, không thể xoá' });
  s.projects = s.projects.filter(p => p.id !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Giao dịch thu/chi ----------
function filterTx(q) {
  const { from, to, projectId, kind } = q;
  return db.load().transactions.filter(t =>
    (!from || t.date >= from) && (!to || t.date <= to) &&
    (!projectId || (projectId === '_none' ? !t.projectId : t.projectId === projectId)) &&
    (!kind || t.kind === kind));
}

function validateTx(body) {
  const { date, category, amount, kind } = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return 'Ngày không hợp lệ';
  if (!byCode[category]) return 'Khoản mục không hợp lệ';
  if (!(Number(amount) > 0)) return 'Số tiền phải lớn hơn 0';
  if (!['plan', 'actual'].includes(kind)) return 'Loại phải là kế hoạch hoặc thực tế';
  return null;
}

app.get('/api/transactions', (req, res) => {
  res.json(filterTx(req.query).sort((a, b) => b.date.localeCompare(a.date)));
});

app.post('/api/transactions', requireEditor, (req, res) => {
  const err = validateTx(req.body);
  if (err) return res.status(400).json({ error: err });
  const { date, projectId, category, amount, kind, description } = req.body;
  const t = { id: db.id(), date, projectId: projectId || null, category, amount: Number(amount), kind, description: description || '', createdBy: req.session.user.username, createdAt: new Date().toISOString() };
  db.load().transactions.push(t);
  db.save();
  res.json(t);
});

app.put('/api/transactions/:id', requireEditor, (req, res) => {
  const err = validateTx(req.body);
  if (err) return res.status(400).json({ error: err });
  const t = db.load().transactions.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Không tìm thấy' });
  const { date, projectId, category, amount, kind, description } = req.body;
  Object.assign(t, { date, projectId: projectId || null, category, amount: Number(amount), kind, description: description || '', updatedBy: req.session.user.username, updatedAt: new Date().toISOString() });
  db.save();
  res.json(t);
});

app.delete('/api/transactions/:id', requireEditor, (req, res) => {
  const s = db.load();
  s.transactions = s.transactions.filter(t => t.id !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- Báo cáo ----------
const signed = t => (byCode[t.category].flow === 'in' ? t.amount : -t.amount);

// Báo cáo lưu chuyển tiền tệ (B03-DN, phương pháp trực tiếp) cho một kỳ
app.get('/api/reports/cashflow-statement', (req, res) => {
  const { from = '2026-01-01', to = '2026-12-31', kind = 'actual', projectId } = req.query;
  const s = db.load();
  const all = s.transactions.filter(t => t.kind === kind && (!projectId || t.projectId === projectId));
  const opening = (projectId ? 0 : s.settings.openingBalance) + all.filter(t => t.date < from).reduce((a, t) => a + signed(t), 0);
  const inPeriod = all.filter(t => t.date >= from && t.date <= to);

  const sections = Object.entries(ACTIVITIES).map(([act, title]) => {
    const lines = CATEGORIES.filter(c => c.activity === act).map(c => ({
      code: c.code, ms: c.ms, name: c.name, flow: c.flow,
      amount: inPeriod.filter(t => t.category === c.code).reduce((a, t) => a + signed(t), 0)
    }));
    return { activity: act, title, lines, net: lines.reduce((a, l) => a + l.amount, 0) };
  });
  const net = sections.reduce((a, x) => a + x.net, 0);
  res.json({ from, to, kind, opening, sections, net, closing: opening + net });
});

// Dòng tiền theo tháng: kế hoạch vs thực tế, số dư lũy kế
app.get('/api/reports/monthly', (req, res) => {
  const { year = '2026', projectId } = req.query;
  const s = db.load();
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const tx = s.transactions.filter(t => (!projectId || t.projectId === projectId));
  const result = {};
  for (const kind of ['plan', 'actual']) {
    const k = tx.filter(t => t.kind === kind);
    let bal = (projectId ? 0 : s.settings.openingBalance) + k.filter(t => t.date < `${year}-01-01`).reduce((a, t) => a + signed(t), 0);
    result[kind] = months.map(m => {
      const mt = k.filter(t => t.date.startsWith(m));
      const inflow = mt.filter(t => byCode[t.category].flow === 'in').reduce((a, t) => a + t.amount, 0);
      const outflow = mt.filter(t => byCode[t.category].flow === 'out').reduce((a, t) => a + t.amount, 0);
      bal += inflow - outflow;
      const byCategory = {};
      for (const t of mt) byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
      return { month: m, inflow, outflow, net: inflow - outflow, balance: bal, byCategory };
    });
  }
  res.json({ year, months, ...result });
});

// Tổng hợp theo dự án
app.get('/api/reports/projects', (req, res) => {
  const s = db.load();
  res.json(s.projects.map(p => {
    const tx = s.transactions.filter(t => t.projectId === p.id);
    const sum = (kind, flow) => tx.filter(t => t.kind === kind && byCode[t.category].flow === flow).reduce((a, t) => a + t.amount, 0);
    const thu = sum('actual', 'in'), chi = sum('actual', 'out');
    return {
      ...p,
      actualIn: thu, actualOut: chi, actualNet: thu - chi,
      planIn: sum('plan', 'in'), planOut: sum('plan', 'out'),
      collectedPct: p.contractValue ? thu / p.contractValue : 0,
      receivable: p.contractValue - thu
    };
  }));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Lỗi máy chủ' });
});

app.listen(PORT, () => console.log(`Hệ thống báo cáo tài chính chạy tại http://localhost:${PORT}`));
