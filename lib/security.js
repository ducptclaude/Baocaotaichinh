// Lớp bảo vệ L7 trong ứng dụng: tường lửa IP, giới hạn tần suất, tự động chặn IP vi phạm,
// chặn quét lỗ hổng, kiểm tra nguồn gốc request (CSRF), giảm tải khi quá tải.
// Lớp L3/L4 (SYN flood, ngập băng thông) phải xử lý ở biên mạng: Railway Edge / Cloudflare.
const crypto = require('crypto');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => Number(env(k, d));

const CONFIG = {
  allowedIps: env('ALLOWED_IPS', '').split(',').map(s => s.trim()).filter(Boolean), // trống = cho phép tất cả
  cfOriginSecret: env('CF_ORIGIN_SECRET', ''),          // bắt buộc request đi qua Cloudflare
  globalPerMin: num('RATE_LIMIT_PER_MIN', 300),         // mọi request / IP / phút
  apiPerMin: num('API_RATE_LIMIT_PER_MIN', 120),        // request /api / IP / phút
  loginPer15Min: num('LOGIN_RATE_LIMIT', 10),           // lần thử đăng nhập / IP / 15 phút
  userMaxFails: num('LOGIN_MAX_FAILS', 5),              // sai mật khẩu liên tiếp trước khi khoá tài khoản
  userLockMin: num('LOGIN_LOCK_MINUTES', 15),
  banScore: num('BAN_SCORE', 20),                       // điểm vi phạm để bị chặn IP
  banMin: num('BAN_MINUTES', 60),
  lagLimitMs: num('EVENT_LOOP_LAG_LIMIT_MS', 300)       // độ trễ event loop vượt ngưỡng -> từ chối bớt request
};

const MAX_ENTRIES = 50_000; // giới hạn bộ nhớ cho các bảng theo dõi

// ---------- Địa chỉ IP ----------
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every(n => n >= 0 && n <= 255) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null;
}

// Hỗ trợ IP đơn (IPv4/IPv6) và dải IPv4 dạng CIDR, ví dụ 113.160.0.0/16
function ipMatches(ip, rule) {
  const clean = ip.replace(/^::ffff:/, '');
  if (!rule.includes('/')) return clean === rule;
  const [base, bits] = rule.split('/');
  const a = ipToInt(clean), b = ipToInt(base);
  if (a === null || b === null) return false;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (a & mask) === (b & mask);
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// IP thật của người dùng: qua Cloudflare dùng CF-Connecting-IP, qua Railway dùng X-Forwarded-For (trust proxy)
function clientIp(req) {
  if (CONFIG.cfOriginSecret && req.headers['cf-connecting-ip'] && safeEqual(req.headers['x-origin-secret'] || '', CONFIG.cfOriginSecret)) {
    return String(req.headers['cf-connecting-ip']);
  }
  return (req.ip || '').replace(/^::ffff:/, '');
}

// ---------- Bộ đếm cửa sổ cố định ----------
class Counter {
  constructor(windowMs) { this.windowMs = windowMs; this.map = new Map(); }
  hit(key, n = 1) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || now - e.start > this.windowMs) {
      if (this.map.size >= MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
      e = { start: now, count: 0 };
      this.map.set(key, e);
    }
    e.count += n;
    return e;
  }
  get(key) {
    const e = this.map.get(key);
    return e && Date.now() - e.start <= this.windowMs ? e.count : 0;
  }
  reset(key) { this.map.delete(key); }
  sweep() { const now = Date.now(); for (const [k, e] of this.map) if (now - e.start > this.windowMs) this.map.delete(k); }
}

const globalCounter = new Counter(60_000);
const apiCounter = new Counter(60_000);
const loginCounter = new Counter(15 * 60_000);
const violationCounter = new Counter(10 * 60_000);
const userFails = new Map(); // username -> { count, lockedUntil }
const bans = new Map();      // ip -> { until, reason }

let onEvent = () => {};      // ghi nhật ký (gắn từ server)
const setEventHandler = fn => { onEvent = fn; };

function isBanned(ip) {
  const b = bans.get(ip);
  if (!b) return false;
  if (Date.now() > b.until) { bans.delete(ip); return false; }
  return true;
}

function ban(ip, reason) {
  if (isBanned(ip)) return;
  if (bans.size >= MAX_ENTRIES) bans.delete(bans.keys().next().value);
  bans.set(ip, { until: Date.now() + CONFIG.banMin * 60_000, reason, at: new Date().toISOString() });
  onEvent({ action: 'ip_banned', ip, detail: `${reason} – chặn ${CONFIG.banMin} phút` });
}

// Cộng điểm vi phạm; vượt ngưỡng thì chặn IP
function violation(ip, points, reason) {
  if (CONFIG.allowedIps.length && CONFIG.allowedIps.some(r => ipMatches(ip, r))) return; // không tự chặn IP trong danh sách trắng
  if (violationCounter.hit(ip, points).count >= CONFIG.banScore) ban(ip, reason);
}

function unban(ip) { bans.delete(ip); violationCounter.reset(ip); }

// ---------- Dấu hiệu quét lỗ hổng / tấn công ----------
const SCANNER = /(\.env|\.git|\.php|\.asp|wp-admin|wp-login|wp-content|phpmyadmin|\/cgi-bin|\/actuator|\/vendor\/phpunit|\/\.aws|\/server-status|\.\.\/|%2e%2e|\/etc\/passwd|<script|union(\s|%20)+select)/i;

// ---------- Theo dõi độ trễ event loop để giảm tải khi bị flood ----------
let lag = 0;
setInterval(() => {
  const start = process.hrtime.bigint();
  setImmediate(() => { lag = Number(process.hrtime.bigint() - start) / 1e6; });
}, 500).unref();

setInterval(() => {
  [globalCounter, apiCounter, loginCounter, violationCounter].forEach(c => c.sweep());
  const now = Date.now();
  for (const [ip, b] of bans) if (now > b.until) bans.delete(ip);
  for (const [u, f] of userFails) if (f.lockedUntil && now > f.lockedUntil) userFails.delete(u);
}, 60_000).unref();

function tooMany(res, seconds, msg) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: msg || 'Quá nhiều yêu cầu, vui lòng thử lại sau' });
}

// ---------- Middleware tường lửa chính ----------
function firewall(req, res, next) {
  if (req.path === '/healthz') return next(); // healthcheck nội bộ của Railway

  // Chỉ nhận request đi qua Cloudflare (khi đã cấu hình), chặn truy cập thẳng vào *.up.railway.app
  if (CONFIG.cfOriginSecret && !safeEqual(req.headers['x-origin-secret'] || '', CONFIG.cfOriginSecret)) {
    return res.status(403).send('Forbidden');
  }

  const ip = clientIp(req);
  req.clientIp = ip;

  if (CONFIG.allowedIps.length && !CONFIG.allowedIps.some(r => ipMatches(ip, r))) {
    return res.status(403).json({ error: 'Địa chỉ IP không được phép truy cập' });
  }
  if (isBanned(ip)) return res.status(403).json({ error: 'Địa chỉ IP đang bị tạm chặn do hoạt động bất thường' });

  // Khi quá tải: ưu tiên người đã đăng nhập (có cookie phiên), từ chối bớt request lạ
  if (lag > CONFIG.lagLimitMs && !/bctc\.sid=/.test(req.headers.cookie || '')) {
    res.set('Retry-After', '5');
    return res.status(503).json({ error: 'Hệ thống đang quá tải, vui lòng thử lại sau ít giây' });
  }

  if (SCANNER.test(req.originalUrl)) {
    violation(ip, 5, 'Quét lỗ hổng: ' + req.originalUrl.slice(0, 100));
    return res.status(404).send('Not found');
  }

  if (globalCounter.hit(ip).count > CONFIG.globalPerMin) {
    violation(ip, 1, 'Vượt giới hạn tần suất truy cập');
    return tooMany(res, 60);
  }
  if (req.path.startsWith('/api/') && apiCounter.hit(ip).count > CONFIG.apiPerMin) {
    violation(ip, 1, 'Vượt giới hạn tần suất API');
    return tooMany(res, 60);
  }
  next();
}

// Chống CSRF: request thay đổi dữ liệu phải là JSON và cùng nguồn gốc
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.is('application/json')) return res.status(415).json({ error: 'Yêu cầu không hợp lệ' });
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.headers.host) {
      violation(req.clientIp, 3, 'Request khác nguồn gốc');
      return res.status(403).json({ error: 'Yêu cầu không hợp lệ (khác nguồn gốc)' });
    }
  }
  next();
}

// ---------- Đăng nhập ----------
function loginGuard(req, res, next) {
  if (loginCounter.hit(req.clientIp).count > CONFIG.loginPer15Min) {
    violation(req.clientIp, 2, 'Dò mật khẩu');
    return tooMany(res, 900, 'Thử đăng nhập quá nhiều lần, vui lòng thử lại sau 15 phút');
  }
  next();
}

function userLocked(username) {
  const f = userFails.get(username);
  return f?.lockedUntil && Date.now() < f.lockedUntil ? Math.ceil((f.lockedUntil - Date.now()) / 60_000) : 0;
}

// Trả về true nếu lần sai này làm tài khoản bị khoá
function recordLoginFail(username) {
  const f = userFails.get(username) || { count: 0 };
  f.count++;
  if (f.count >= CONFIG.userMaxFails) { f.lockedUntil = Date.now() + CONFIG.userLockMin * 60_000; f.count = 0; }
  if (userFails.size >= MAX_ENTRIES) userFails.delete(userFails.keys().next().value);
  userFails.set(username, f);
  return !!f.lockedUntil;
}

function recordLoginSuccess(username, ip) { userFails.delete(username); loginCounter.reset(ip); }

// ---------- Chính sách mật khẩu ----------
function passwordProblem(pw, username) {
  pw = String(pw || '');
  if (pw.length < 10) return 'Mật khẩu tối thiểu 10 ký tự';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw)) return 'Mật khẩu phải có chữ hoa, chữ thường, chữ số và ký tự đặc biệt';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Mật khẩu không được chứa tên đăng nhập';
  return null;
}

function status() {
  const now = Date.now();
  return {
    bans: [...bans].filter(([, b]) => b.until > now).map(([ip, b]) => ({ ip, reason: b.reason, at: b.at, minutesLeft: Math.ceil((b.until - now) / 60_000) })),
    lockedUsers: [...userFails].filter(([, f]) => f.lockedUntil > now).map(([username, f]) => ({ username, minutesLeft: Math.ceil((f.lockedUntil - now) / 60_000) })),
    eventLoopLagMs: Math.round(lag),
    config: {
      cloudflareOnly: !!CONFIG.cfOriginSecret,
      allowedIps: CONFIG.allowedIps,
      globalPerMin: CONFIG.globalPerMin, apiPerMin: CONFIG.apiPerMin, loginPer15Min: CONFIG.loginPer15Min,
      userMaxFails: CONFIG.userMaxFails, userLockMin: CONFIG.userLockMin, banScore: CONFIG.banScore, banMin: CONFIG.banMin
    }
  };
}

function unlockUser(username) { userFails.delete(username); }

module.exports = {
  CONFIG, firewall, sameOrigin, loginGuard, userLocked, recordLoginFail, recordLoginSuccess,
  passwordProblem, violation, unban, unlockUser, status, setEventHandler, ipMatches
};
