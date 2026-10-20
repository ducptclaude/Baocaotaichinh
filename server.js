const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const store = require('./lib/store');
const { seed } = require('./lib/seed');
const { CATEGORIES, ACTIVITIES, byCode } = require('./lib/categories');

const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');
// Chạy sau proxy HTTPS (Railway, Nginx...) để lấy đúng IP người dùng và cho phép cookie secure
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Phiên đăng nhập lưu trong PostgreSQL (nếu có) để không bị đăng xuất khi deploy lại
const sessionStore = store.pool
  ? new (require('connect-pg-simple')(session))({ pool: store.pool, createTableIfMissing: true })
  : undefined;

app.use(session({
  name: 'bctc.sid',
  store: sessionStore,
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 8 * 3600 * 1000 }
}));

// Bọc handler async để lỗi được chuyển tới middleware xử lý lỗi
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// Kiểm tra tình trạng cho nền tảng triển khai (Railway healthcheck)
app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', a(async (req, res) => {
  const ip = req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
  if (rec.count >= 5) return res.status(429).json({ error: 'Sai quá nhiều lần, thử lại sau 15 phút' });

  const { username, password } = req.body || {};
  const user = await store.getUserByUsername(String(username || '').trim());
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
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use('/vendor', requireAuth, express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use(requireAuth);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/me', (req, res) => res.json({ user: req.session.user }));

app.post('/api/me/password', a(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = await store.getUserById(req.session.user.id);
  if (!user || !bcrypt.compareSync(String(oldPassword || ''), user.passwordHash)) return res.status(400).json({ error: 'Mật khẩu cũ không đúng' });
  if (String(newPassword || '').length < 8) return res.status(400).json({ error: 'Mật khẩu mới tối thiểu 8 ký tự' });
  await store.setUserPassword(user.id, bcrypt.hashSync(newPassword, 10));
  res.json({ ok: true });
}));

// ---------- Người dùng (admin) ----------
const ROLES = ['admin', 'ketoan', 'xem'];

app.get('/api/users', requireAdmin, a(async (req, res) => res.json((await store.listUsers()).map(publicUser))));

app.post('/api/users', requireAdmin, a(async (req, res) => {
  const { username, fullName, role, password } = req.body || {};
  if (!username || !password || String(password).length < 8) return res.status(400).json({ error: 'Cần tên đăng nhập và mật khẩu tối thiểu 8 ký tự' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  const name = String(username).trim();
  if (await store.getUserByUsername(name)) return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
  const user = await store.createUser({ id: crypto.randomUUID(), username: name, fullName: fullName || name, role, passwordHash: bcrypt.hashSync(password, 10), createdAt: new Date().toISOString() });
  res.json(publicUser(user));
}));

app.delete('/api/users/:id', requireAdmin, a(async (req, res) => {
  if (req.params.id === req.session.user.id) return res.status(400).json({ error: 'Không thể xoá chính mình' });
  await store.deleteUser(req.params.id);
  res.json({ ok: true });
}));

// ---------- Danh mục & thiết lập ----------
app.get('/api/meta', a(async (req, res) => {
  res.json({ categories: CATEGORIES, activities: ACTIVITIES, settings: await store.getSettings(), projects: await store.listProjects() });
}));

app.put('/api/settings', requireAdmin, a(async (req, res) => {
  const { openingBalance, companyName } = req.body || {};
  const patch = {};
  if (openingBalance !== undefined) patch.openingBalance = Number(openingBalance) || 0;
  if (companyName !== undefined) patch.companyName = String(companyName);
  res.json(await store.updateSettings(patch));
}));

// ---------- Dự án ----------
app.post('/api/projects', requireEditor, a(async (req, res) => {
  const { code, name, client, contractValue, start, end } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Cần mã và tên dự án' });
  res.json(await store.createProject({ id: crypto.randomUUID(), code, name, client: client || '', contractValue: Number(contractValue) || 0, start: start || '', end: end || '' }));
}));

app.delete('/api/projects/:id', requireAdmin, a(async (req, res) => {
  if (await store.projectHasTransactions(req.params.id)) return res.status(400).json({ error: 'Dự án đã có phát sinh, không thể xoá' });
  await store.deleteProject(req.params.id);
  res.json({ ok: true });
}));

// ---------- Giao dịch thu/chi ----------
function validateTx(body) {
  const { date, category, amount, kind } = body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return 'Ngày không hợp lệ';
  if (!byCode[category]) return 'Khoản mục không hợp lệ';
  if (!(Number(amount) > 0)) return 'Số tiền phải lớn hơn 0';
  if (!['plan', 'actual'].includes(kind)) return 'Loại phải là kế hoạch hoặc thực tế';
  return null;
}

app.get('/api/transactions', a(async (req, res) => {
  const { from, to, projectId, kind } = req.query;
  res.json((await store.listTransactions({ from, to, projectId, kind })).sort((x, y) => y.date.localeCompare(x.date)));
}));

app.post('/api/transactions', requireEditor, a(async (req, res) => {
  const err = validateTx(req.body);
  if (err) return res.status(400).json({ error: err });
  const { date, projectId, category, amount, kind, description } = req.body;
  res.json(await store.createTransaction({ id: crypto.randomUUID(), date, projectId: projectId || null, category, amount: Number(amount), kind, description: description || '', createdBy: req.session.user.username, createdAt: new Date().toISOString() }));
}));

app.put('/api/transactions/:id', requireEditor, a(async (req, res) => {
  const err = validateTx(req.body);
  if (err) return res.status(400).json({ error: err });
  const { date, projectId, category, amount, kind, description } = req.body;
  const t = await store.updateTransaction(req.params.id, { date, projectId: projectId || null, category, amount: Number(amount), kind, description: description || '', updatedBy: req.session.user.username, updatedAt: new Date().toISOString() });
  if (!t) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(t);
}));

app.delete('/api/transactions/:id', requireEditor, a(async (req, res) => {
  await store.deleteTransaction(req.params.id);
  res.json({ ok: true });
}));

// ---------- Báo cáo ----------
const signed = t => (byCode[t.category].flow === 'in' ? t.amount : -t.amount);

// Báo cáo lưu chuyển tiền tệ (B03-DN, phương pháp trực tiếp) cho một kỳ
app.get('/api/reports/cashflow-statement', a(async (req, res) => {
  const { from = '2026-01-01', to = '2026-12-31', kind = 'actual', projectId } = req.query;
  const settings = await store.getSettings();
  const all = await store.listTransactions({ kind, projectId, to });
  const opening = (projectId ? 0 : Number(settings.openingBalance) || 0) + all.filter(t => t.date < from).reduce((s, t) => s + signed(t), 0);
  const inPeriod = all.filter(t => t.date >= from);

  const sections = Object.entries(ACTIVITIES).map(([act, title]) => {
    const lines = CATEGORIES.filter(c => c.activity === act).map(c => ({
      code: c.code, ms: c.ms, name: c.name, flow: c.flow,
      amount: inPeriod.filter(t => t.category === c.code).reduce((s, t) => s + signed(t), 0)
    }));
    return { activity: act, title, lines, net: lines.reduce((s, l) => s + l.amount, 0) };
  });
  const net = sections.reduce((s, x) => s + x.net, 0);
  res.json({ from, to, kind, opening, sections, net, closing: opening + net });
}));

// Dòng tiền theo tháng: kế hoạch vs thực tế, số dư lũy kế
app.get('/api/reports/monthly', a(async (req, res) => {
  const { year = '2026', projectId } = req.query;
  const settings = await store.getSettings();
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const tx = await store.listTransactions({ projectId, to: `${year}-12-31` });
  const result = {};
  for (const kind of ['plan', 'actual']) {
    const k = tx.filter(t => t.kind === kind);
    let bal = (projectId ? 0 : Number(settings.openingBalance) || 0) + k.filter(t => t.date < `${year}-01-01`).reduce((s, t) => s + signed(t), 0);
    result[kind] = months.map(m => {
      const mt = k.filter(t => t.date.startsWith(m));
      const inflow = mt.filter(t => byCode[t.category].flow === 'in').reduce((s, t) => s + t.amount, 0);
      const outflow = mt.filter(t => byCode[t.category].flow === 'out').reduce((s, t) => s + t.amount, 0);
      bal += inflow - outflow;
      const byCategory = {};
      for (const t of mt) byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
      return { month: m, inflow, outflow, net: inflow - outflow, balance: bal, byCategory };
    });
  }
  res.json({ year, months, ...result });
}));

// Tổng hợp theo dự án
app.get('/api/reports/projects', a(async (req, res) => {
  const [projects, allTx] = await Promise.all([store.listProjects(), store.listTransactions()]);
  res.json(projects.map(p => {
    const tx = allTx.filter(t => t.projectId === p.id);
    const sum = (kind, flow) => tx.filter(t => t.kind === kind && byCode[t.category].flow === flow).reduce((s, t) => s + t.amount, 0);
    const thu = sum('actual', 'in'), chi = sum('actual', 'out');
    return {
      ...p,
      actualIn: thu, actualOut: chi, actualNet: thu - chi,
      planIn: sum('plan', 'in'), planOut: sum('plan', 'out'),
      collectedPct: p.contractValue ? thu / p.contractValue : 0,
      receivable: p.contractValue - thu
    };
  }));
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Lỗi máy chủ' });
});

(async () => {
  await store.init();
  if (await seed()) console.log('Khởi tạo dữ liệu mẫu lần đầu. Tài khoản: admin (mật khẩu theo ADMIN_PASSWORD, mặc định Admin@123).');
  app.listen(PORT, '0.0.0.0', () => console.log(`Hệ thống báo cáo tài chính chạy tại http://localhost:${PORT} (lưu trữ: ${store.location})`));
})().catch(err => {
  console.error('Không khởi động được:', err);
  process.exit(1);
});
