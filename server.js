const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const security = require('./lib/security');
const store = require('./lib/store');
const { seed } = require('./lib/seed');
const { CATEGORIES, ACTIVITIES, byCode } = require('./lib/categories');

const PORT = process.env.PORT || 3000;
const app = express();
app.disable('x-powered-by');
// Chạy sau proxy HTTPS (Railway, Nginx...) để lấy đúng IP người dùng và cho phép cookie secure
app.set('trust proxy', 1);

const SECURE = process.env.COOKIE_SECURE === '1';
const IDLE_MIN = Number(process.env.SESSION_IDLE_MINUTES || 30);   // tự đăng xuất khi không thao tác
const ABSOLUTE_HOURS = Number(process.env.SESSION_MAX_HOURS || 8);  // thời hạn tối đa một phiên

if (!process.env.SESSION_SECRET) console.warn('CẢNH BÁO: chưa đặt SESSION_SECRET – phiên đăng nhập sẽ mất khi khởi động lại');

// Tiêu đề bảo mật HTTP (CSP, HSTS, chống clickjacking, chống MIME sniffing...)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(SECURE ? { upgradeInsecureRequests: [] } : {})
    }
  },
  hsts: SECURE ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'same-origin' },
  crossOriginEmbedderPolicy: false
}));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// Ghi nhật ký bảo mật & thao tác
function audit(req, action, detail) {
  store.addAudit({ username: req?.session?.user?.username || req?.auditUser || null, ip: req?.clientIp, action, detail })
    .catch(err => console.error('Lỗi ghi nhật ký:', err.message));
}
security.setEventHandler(e => store.addAudit(e).catch(() => {}));

// Tường lửa L7 chạy trước mọi xử lý tốn tài nguyên (phiên, CSDL)
app.use(security.firewall);
app.use(express.json({ limit: '100kb' }));

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
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: SECURE, maxAge: IDLE_MIN * 60 * 1000 }
}));

app.use('/api/', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api/', security.sameOrigin);

// Bọc handler async để lỗi được chuyển tới middleware xử lý lỗi
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Xác thực ----------
function requireAuth(req, res, next) {
  const s = req.session;
  if (s.user && Date.now() - (s.loginAt || 0) > ABSOLUTE_HOURS * 3600 * 1000) {
    return s.destroy(() => (req.path.startsWith('/api/') ? res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn' }) : res.redirect('/login')));
  }
  if (s.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.redirect('/login');
}

// Mỗi request kiểm tra lại tài khoản còn tồn tại và cập nhật vai trò (thu hồi quyền có hiệu lực ngay)
const refreshUser = a(async (req, res, next) => {
  const u = await store.getUserById(req.session.user.id);
  if (!u) return req.session.destroy(() => res.status(401).json({ error: 'Tài khoản không còn hiệu lực' }));
  req.session.user = publicUser(u);
  next();
});

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

// Hash giả để thời gian phản hồi như nhau dù tên đăng nhập có tồn tại hay không (chống dò tài khoản)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

app.post('/api/login', security.loginGuard, a(async (req, res) => {
  const username = String(req.body?.username || '').trim().slice(0, 100);
  const password = String(req.body?.password || '').slice(0, 200);
  req.auditUser = username;

  const lockedMin = security.userLocked(username);
  if (lockedMin) {
    audit(req, 'login_locked', `Tài khoản đang khoá, còn ${lockedMin} phút`);
    return res.status(423).json({ error: `Tài khoản tạm khoá do nhập sai nhiều lần, thử lại sau ${lockedMin} phút` });
  }

  const user = await store.getUserByUsername(username);
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) {
    const locked = security.recordLoginFail(username);
    security.violation(req.clientIp, 1, 'Đăng nhập sai nhiều lần');
    audit(req, 'login_fail', locked ? 'Sai mật khẩu – tài khoản bị khoá tạm thời' : 'Sai tên đăng nhập hoặc mật khẩu');
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  }
  security.recordLoginSuccess(username, req.clientIp);
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Lỗi phiên đăng nhập' });
    req.session.user = publicUser(user);
    req.session.loginAt = Date.now();
    audit(req, 'login_success', req.headers['user-agent']?.slice(0, 150));
    res.json({ user: req.session.user });
  });
}));

app.post('/api/logout', (req, res) => {
  if (req.session.user) audit(req, 'logout');
  req.session.destroy(() => res.json({ ok: true }));
});

app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
app.use('/vendor', requireAuth, express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use(requireAuth);
app.use('/api/', refreshUser);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/me', (req, res) => res.json({ user: req.session.user }));

app.post('/api/me/password', a(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = await store.getUserById(req.session.user.id);
  if (!user || !(await bcrypt.compare(String(oldPassword || ''), user.passwordHash))) {
    audit(req, 'password_change_fail', 'Mật khẩu cũ không đúng');
    return res.status(400).json({ error: 'Mật khẩu cũ không đúng' });
  }
  const problem = security.passwordProblem(newPassword, user.username);
  if (problem) return res.status(400).json({ error: problem });
  await store.setUserPassword(user.id, await bcrypt.hash(String(newPassword), 12));
  audit(req, 'password_change');
  // Cấp lại mã phiên sau khi đổi mật khẩu
  const { user: u, loginAt } = req.session;
  req.session.regenerate(() => { Object.assign(req.session, { user: u, loginAt }); res.json({ ok: true }); });
}));

// ---------- Người dùng (admin) ----------
const ROLES = ['admin', 'ketoan', 'xem'];

app.get('/api/users', requireAdmin, a(async (req, res) => res.json((await store.listUsers()).map(publicUser))));

app.post('/api/users', requireAdmin, a(async (req, res) => {
  const { username, fullName, role, password } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,50}$/.test(name)) return res.status(400).json({ error: 'Tên đăng nhập 3–50 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  const problem = security.passwordProblem(password, name);
  if (problem) return res.status(400).json({ error: problem });
  if (await store.getUserByUsername(name)) return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại' });
  const user = await store.createUser({ id: crypto.randomUUID(), username: name, fullName: fullName || name, role, passwordHash: await bcrypt.hash(String(password), 12), createdAt: new Date().toISOString() });
  audit(req, 'user_create', `${name} (${role})`);
  res.json(publicUser(user));
}));

app.delete('/api/users/:id', requireAdmin, a(async (req, res) => {
  if (req.params.id === req.session.user.id) return res.status(400).json({ error: 'Không thể xoá chính mình' });
  const u = await store.getUserById(req.params.id);
  await store.deleteUser(req.params.id);
  audit(req, 'user_delete', u?.username);
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
  audit(req, 'settings_update', JSON.stringify(patch));
  res.json(await store.updateSettings(patch));
}));

// ---------- Dự án ----------
app.post('/api/projects', requireEditor, a(async (req, res) => {
  const { code, name, client, contractValue, start, end } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Cần mã và tên dự án' });
  const p = await store.createProject({ id: crypto.randomUUID(), code, name, client: client || '', contractValue: Number(contractValue) || 0, start: start || '', end: end || '' });
  audit(req, 'project_create', `${code} – ${name}`);
  res.json(p);
}));

app.delete('/api/projects/:id', requireAdmin, a(async (req, res) => {
  if (await store.projectHasTransactions(req.params.id)) return res.status(400).json({ error: 'Dự án đã có phát sinh, không thể xoá' });
  await store.deleteProject(req.params.id);
  audit(req, 'project_delete', req.params.id);
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
  const t = await store.createTransaction({ id: crypto.randomUUID(), date, projectId: projectId || null, category, amount: Number(amount), kind, description: description || '', createdBy: req.session.user.username, createdAt: new Date().toISOString() });
  audit(req, 'tx_create', `${date} ${category} ${t.amount} (${kind})`);
  res.json(t);
}));

app.put('/api/transactions/:id', requireEditor, a(async (req, res) => {
  const err = validateTx(req.body);
  if (err) return res.status(400).json({ error: err });
  const { date, projectId, category, amount, kind, description } = req.body;
  const t = await store.updateTransaction(req.params.id, { date, projectId: projectId || null, category, amount: Number(amount), kind, description: description || '', updatedBy: req.session.user.username, updatedAt: new Date().toISOString() });
  if (!t) return res.status(404).json({ error: 'Không tìm thấy' });
  audit(req, 'tx_update', `${req.params.id}: ${date} ${category} ${t.amount} (${kind})`);
  res.json(t);
}));

app.delete('/api/transactions/:id', requireEditor, a(async (req, res) => {
  await store.deleteTransaction(req.params.id);
  audit(req, 'tx_delete', req.params.id);
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

// ---------- Bảo mật (admin) ----------
app.get('/api/security/status', requireAdmin, (req, res) => res.json(security.status()));
app.get('/api/security/audit', requireAdmin, a(async (req, res) => res.json(await store.listAudit(Math.min(Number(req.query.limit) || 200, 1000)))));
app.post('/api/security/unban', requireAdmin, (req, res) => {
  security.unban(String(req.body?.ip || ''));
  audit(req, 'ip_unban', req.body?.ip);
  res.json({ ok: true });
});
app.post('/api/security/unlock', requireAdmin, (req, res) => {
  security.unlockUser(String(req.body?.username || ''));
  audit(req, 'user_unlock', req.body?.username);
  res.json({ ok: true });
});

app.use((req, res) => res.status(404).json({ error: 'Không tìm thấy' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dữ liệu gửi lên không hợp lệ' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Dữ liệu gửi lên quá lớn' });
  console.error(err);
  res.status(500).json({ error: 'Lỗi máy chủ' });
});

(async () => {
  await store.init();
  if (await seed()) console.log('Khởi tạo dữ liệu mẫu lần đầu. Tài khoản: admin (mật khẩu theo ADMIN_PASSWORD, mặc định Admin@123).');
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Hệ thống báo cáo tài chính chạy tại http://localhost:${PORT} (lưu trữ: ${store.location})`));
  // Chống Slowloris / kết nối treo: giới hạn thời gian nhận header, toàn bộ request và kết nối nhàn rỗi
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 10_000;
  server.maxRequestsPerSocket = 1000;
  server.maxHeadersCount = 100;
})().catch(err => {
  console.error('Không khởi động được:', err);
  process.exit(1);
});
