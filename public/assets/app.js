// ===== Tiện ích =====
const $ = s => document.querySelector(s);
const fmt = n => new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));
const fmtM = n => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format((n || 0) / 1e6);
const fmtB = n => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format((n || 0) / 1e9) + ' tỷ';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signCls = n => (n < 0 ? 'out' : 'in');
const monthLabel = m => 'T' + Number(m.slice(5));

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/login'; throw new Error('401'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { toast(data.error || `Có lỗi xảy ra (${res.status})`); throw new Error(data.error); }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2500);
}

// Mở dialog và trả về dữ liệu form khi bấm Lưu
function openForm(dlg, init = {}) {
  const form = dlg.querySelector('form');
  form.reset();
  for (const [k, v] of Object.entries(init)) if (form.elements[k]) form.elements[k].value = v ?? '';
  dlg.showModal();
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? Object.fromEntries(new FormData(form)) : null), { once: true });
  });
}

// ===== Trạng thái =====
let ME, META, CAT = {};
const charts = {};
const projName = id => (id ? META.projects.find(p => p.id === id)?.code || '?' : 'Chung');
const canEdit = () => ['admin', 'ketoan'].includes(ME.role);

function fillProjectSelect(sel, { all = true, none = false } = {}) {
  sel.innerHTML = (all ? '<option value="">Toàn công ty</option>' : '') +
    (none ? '<option value="">— Chung (không gắn dự án) —</option>' : '') +
    META.projects.map(p => `<option value="${p.id}">${esc(p.code)} · ${esc(p.name)}</option>`).join('');
}

// Bảng màu biểu đồ theo nhận diện navy – teal
const C = { navy: '#0b2545', navy2: '#13315c', teal: '#0fa3a3', teal2: '#2cc2b8', in: '#0fa3a3', out: '#e06363', plan: '#c9821a' };
Chart.defaults.font.family = 'Montserrat, "Segoe UI", Arial, sans-serif';
Chart.defaults.font.size = 11.5;
Chart.defaults.color = '#66748a';
Chart.defaults.borderColor = '#edf1f6';
Chart.defaults.plugins.legend.labels.usePointStyle = true;

async function init() {
  ME = (await api('/api/me')).user;
  META = await api('/api/meta');
  META.categories.forEach(c => (CAT[c.code] = c));
  $('#userName').textContent = ME.fullName;
  $('#avatar').textContent = (ME.fullName || ME.username).trim().split(/\s+/).pop()[0].toUpperCase();
  $('#company').textContent = META.settings.companyName || '';
  if (ME.role === 'admin') $('#tabAdmin').hidden = false;
  if (!canEdit()) document.querySelectorAll('.editor').forEach(b => (b.hidden = true));

  ['#dashProject', '#fProject', '#sProject', '#pProject'].forEach(s => fillProjectSelect($(s)));
  $('#fProject').insertAdjacentHTML('beforeend', '<option value="_none">Chung (không gắn dự án)</option>');
  fillProjectSelect($('#formTx').elements.projectId, { all: false, none: true });
  $('#formTx').elements.category.innerHTML = Object.entries(META.activities).map(([a, title]) =>
    `<optgroup label="${esc(title)}">` + META.categories.filter(c => c.activity === a)
      .map(c => `<option value="${c.code}">[${c.flow === 'in' ? 'Thu' : 'Chi'}] ${esc(c.name)}</option>`).join('') + '</optgroup>').join('');

  loadDashboard();
}

// ===== Điều hướng tab =====
const loaders = { dashboard: loadDashboard, ledger: loadLedger, statement: loadStatement, plan: loadPlan, projects: loadProjects, admin: loadAdmin };
$('#tabs').addEventListener('click', e => {
  const v = e.target.dataset.view;
  if (!v) return;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === e.target));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  loaders[v]();
});

function drawChart(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

// ===== Tổng quan =====
async function loadDashboard() {
  const pid = $('#dashProject').value;
  const q = pid ? `?projectId=${pid}` : '';
  const m = await api('/api/reports/monthly' + q);
  const today = new Date().toISOString().slice(0, 7);
  const act = m.actual.filter(x => x.month <= today);
  const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  const planToDate = m.plan.filter(x => x.month <= today);
  const totalIn = sum(act, 'inflow'), totalOut = sum(act, 'outflow');
  const planIn = sum(planToDate, 'inflow');
  const lastBal = act.length ? act[act.length - 1].balance : 0;
  const yearEndPlan = m.plan[11].balance;
  const minPlan = m.plan.reduce((a, x) => (x.balance < a.balance ? x : a), m.plan[0]);

  $('#kpis').innerHTML = [
    ['Tổng thu thực tế (lũy kế)', fmtB(totalIn), `Đạt ${planIn ? Math.round(totalIn / planIn * 100) : 0}% kế hoạch cùng kỳ`, 'in'],
    ['Tổng chi thực tế (lũy kế)', fmtB(totalOut), `${act.filter(x => x.inflow || x.outflow).length} tháng có phát sinh`, 'out'],
    ['Dòng tiền thuần', fmtB(totalIn - totalOut), 'Thu − Chi', signCls(totalIn - totalOut)],
    ['Số dư tiền hiện tại', fmtB(lastBal), pid ? 'Theo dự án (không gồm đầu kỳ)' : 'Gồm số dư đầu kỳ', signCls(lastBal)],
    ['Số dư cuối năm (KH)', fmtB(yearEndPlan), `Thấp nhất: ${fmtB(minPlan.balance)} (${monthLabel(minPlan.month)})`, minPlan.balance < 0 ? 'warn' : '']
  ].map(([l, v, n, c]) => `<div class="kpi"><div class="label">${l}</div><div class="value ${c}">${v}</div><div class="note">${n}</div></div>`).join('');

  const labels = m.months.map(monthLabel);
  drawChart('chartMonthly', {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Thu', data: m.actual.map(x => x.inflow / 1e6), backgroundColor: C.in, borderRadius: 4 },
      { label: 'Chi', data: m.actual.map(x => -x.outflow / 1e6), backgroundColor: C.out, borderRadius: 4 },
      { label: 'Dòng tiền thuần', type: 'line', data: m.actual.map(x => (x.month <= today ? x.net / 1e6 : null)), borderColor: C.navy, backgroundColor: C.navy, borderWidth: 2.5, tension: .3 }
    ] },
    options: { plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)} tr` } } }, scales: { x: { stacked: true }, y: { ticks: { callback: v => fmt(v) + ' tr' } } } }
  });

  const mix = {};
  act.forEach(x => Object.entries(x.byCategory).forEach(([k, v]) => { if (CAT[k].flow === 'out') mix[k] = (mix[k] || 0) + v; }));
  const mixKeys = Object.keys(mix).sort((a, b) => mix[b] - mix[a]);
  drawChart('chartMix', {
    type: 'doughnut',
    data: { labels: mixKeys.map(k => CAT[k].name), datasets: [{ data: mixKeys.map(k => mix[k] / 1e6), backgroundColor: ['#0b2545', '#13315c', '#1d4677', '#0f7f86', '#0fa3a3', '#2cc2b8', '#8fdcd5', '#8da2bf', '#c3cfdf', '#e06363'], borderWidth: 2, borderColor: '#fff' }] },
    options: { plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10.5 } } }, tooltip: { callbacks: { label: c => `${fmt(c.raw)} tr` } } } }
  });

  drawChart('chartBalance', {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Kế hoạch', data: m.plan.map(x => x.balance / 1e6), borderColor: C.plan, borderDash: [6, 4], borderWidth: 2, pointRadius: 2, tension: .3 },
      { label: 'Thực tế', data: m.actual.map(x => (x.month <= today ? x.balance / 1e6 : null)), borderColor: C.teal, backgroundColor: ctx => { const { chart } = ctx; const g = chart.ctx.createLinearGradient(0, chart.chartArea?.top || 0, 0, chart.chartArea?.bottom || 300); g.addColorStop(0, 'rgba(15,163,163,.35)'); g.addColorStop(1, 'rgba(11,37,69,.02)'); return g; }, borderWidth: 2.5, fill: true, tension: .3 }
    ] },
    options: { plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmt(c.raw)} tr` } } }, scales: { y: { ticks: { callback: v => fmt(v) + ' tr' } } } }
  });
}
$('#dashProject').addEventListener('change', loadDashboard);

// ===== Sổ thu chi =====
let LEDGER = [];
async function loadLedger() {
  const p = new URLSearchParams({ from: $('#fFrom').value, to: $('#fTo').value, projectId: $('#fProject').value, kind: $('#fKind').value });
  LEDGER = await api('/api/transactions?' + p);
  const tin = LEDGER.filter(t => CAT[t.category].flow === 'in').reduce((a, t) => a + t.amount, 0);
  const tout = LEDGER.filter(t => CAT[t.category].flow === 'out').reduce((a, t) => a + t.amount, 0);
  $('#ledgerTable').innerHTML = `<thead><tr><th>Ngày</th><th>Loại</th><th>Dự án</th><th>Khoản mục</th><th>Diễn giải</th><th class="num">Thu</th><th class="num">Chi</th><th>Người nhập</th>${canEdit() ? '<th></th>' : ''}</tr></thead><tbody>` +
    LEDGER.map(t => {
      const c = CAT[t.category];
      return `<tr><td>${t.date.split('-').reverse().join('/')}</td><td><span class="tag ${t.kind}">${t.kind === 'plan' ? 'Kế hoạch' : 'Thực tế'}</span></td>
        <td>${esc(projName(t.projectId))}</td><td class="wrap">${esc(c.name)}</td><td class="wrap">${esc(t.description)}</td>
        <td class="num in">${c.flow === 'in' ? fmt(t.amount) : ''}</td><td class="num out">${c.flow === 'out' ? fmt(t.amount) : ''}</td>
        <td class="muted">${esc(t.updatedBy || t.createdBy)}</td>
        ${canEdit() ? `<td><button class="btn sm ghost" data-edit="${t.id}">Sửa</button> <button class="btn danger sm" data-del="${t.id}">Xoá</button></td>` : ''}</tr>`;
    }).join('') +
    `<tr class="grand"><td colspan="5">Tổng cộng (${LEDGER.length} dòng) · Chênh lệch: <span class="${signCls(tin - tout)}">${fmt(tin - tout)}</span></td><td class="num in">${fmt(tin)}</td><td class="num out">${fmt(tout)}</td><td colspan="2"></td></tr></tbody>`;
}
$('#btnFilter').addEventListener('click', loadLedger);

$('#ledgerTable').addEventListener('click', async e => {
  const { edit, del } = e.target.dataset;
  if (del && confirm('Xoá giao dịch này?')) { await api('/api/transactions/' + del, { method: 'DELETE' }); toast('Đã xoá'); loadLedger(); }
  if (edit) {
    const t = LEDGER.find(x => x.id === edit);
    $('#dlgTxTitle').textContent = 'Sửa giao dịch';
    const data = await openForm($('#dlgTx'), t);
    if (data) { await api('/api/transactions/' + edit, { method: 'PUT', body: data }); toast('Đã cập nhật'); loadLedger(); }
  }
});

$('#btnAdd').addEventListener('click', async () => {
  $('#dlgTxTitle').textContent = 'Thêm giao dịch';
  const data = await openForm($('#dlgTx'), { date: new Date().toISOString().slice(0, 10), kind: 'actual' });
  if (data) { await api('/api/transactions', { method: 'POST', body: data }); toast('Đã thêm giao dịch'); loadLedger(); }
});

$('#btnCsv').addEventListener('click', () => {
  const rows = [['Ngày', 'Loại', 'Dự án', 'Hoạt động', 'Mã số B03', 'Khoản mục', 'Diễn giải', 'Thu', 'Chi']];
  LEDGER.forEach(t => {
    const c = CAT[t.category];
    rows.push([t.date, t.kind === 'plan' ? 'Kế hoạch' : 'Thực tế', projName(t.projectId), c.activity, c.ms, c.name, t.description, c.flow === 'in' ? t.amount : '', c.flow === 'out' ? t.amount : '']);
  });
  // Ô văn bản bắt đầu bằng = + - @ bị Excel hiểu là công thức -> thêm dấu ' để vô hiệu (chống CSV injection)
  const cell = v => { let s = String(v); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `so-thu-chi_${$('#fFrom').value}_${$('#fTo').value}.csv`;
  a.click();
});

// ===== Báo cáo lưu chuyển tiền tệ =====
async function loadStatement() {
  const p = new URLSearchParams({ from: $('#sFrom').value, to: $('#sTo').value, kind: $('#sKind').value, projectId: $('#sProject').value });
  const r = await api('/api/reports/cashflow-statement?' + p);
  const d = s => s.split('-').reverse().join('/');
  $('#stmtSub').textContent = `(Theo phương pháp trực tiếp) · Kỳ từ ${d(r.from)} đến ${d(r.to)} · Số liệu ${r.kind === 'plan' ? 'kế hoạch' : 'thực tế'} · Đơn vị: VNĐ`;
  const msNet = { KD: '20', DT: '30', TC: '40' };
  let html = '<thead><tr><th>Chỉ tiêu</th><th>Mã số</th><th class="num">Số tiền</th></tr></thead><tbody>';
  r.sections.forEach((s, i) => {
    html += `<tr class="section"><td colspan="3">${['I', 'II', 'III'][i]}. ${esc(s.title)}</td></tr>`;
    s.lines.forEach(l => {
      html += `<tr><td class="wrap">&nbsp;&nbsp;${esc(l.name)}</td><td>${l.ms}</td><td class="num ${l.amount ? signCls(l.amount) : 'muted'}">${l.amount < 0 ? '(' + fmt(-l.amount) + ')' : fmt(l.amount)}</td></tr>`;
    });
    html += `<tr class="total"><td>Lưu chuyển tiền thuần từ ${esc(s.title.replace('Lưu chuyển tiền từ ', ''))}</td><td>${msNet[s.activity]}</td><td class="num ${signCls(s.net)}">${fmt(s.net)}</td></tr>`;
  });
  html += `<tr class="grand"><td>Lưu chuyển tiền thuần trong kỳ (50 = 20 + 30 + 40)</td><td>50</td><td class="num ${signCls(r.net)}">${fmt(r.net)}</td></tr>
    <tr class="grand"><td>Tiền và tương đương tiền đầu kỳ</td><td>60</td><td class="num">${fmt(r.opening)}</td></tr>
    <tr class="grand"><td>Tiền và tương đương tiền cuối kỳ (70 = 50 + 60)</td><td>70</td><td class="num ${signCls(r.closing)}">${fmt(r.closing)}</td></tr></tbody>`;
  $('#statementTable').innerHTML = html;
}
$('#btnStatement').addEventListener('click', loadStatement);

// ===== Kế hoạch vs thực tế =====
async function loadPlan() {
  const pid = $('#pProject').value;
  const m = await api('/api/reports/monthly' + (pid ? `?projectId=${pid}` : ''));
  const used = META.categories.filter(c => m.plan.some(x => x.byCategory[c.code]) || m.actual.some(x => x.byCategory[c.code]));
  const head = m.months.map(x => `<th class="num" colspan="2">${monthLabel(x)}</th>`).join('');
  const sub = m.months.map(() => '<th class="num">KH</th><th class="num">TT</th>').join('');
  const cell = (v, cls = '') => `<td class="num ${cls}">${v ? fmtM(v) : '<span class="muted">–</span>'}</td>`;
  const row = (label, fn, cls = '', trCls = '') => {
    let tp = 0, ta = 0;
    const cells = m.months.map((_, i) => { const p = fn(m.plan[i]), a = fn(m.actual[i]); tp += p; ta += a; return cell(p) + cell(a, cls); }).join('');
    const pct = tp ? Math.round(ta / tp * 100) : 0;
    return `<tr class="${trCls}"><td class="wrap">${label}</td>${cells}${cell(tp)}${cell(ta, cls)}<td class="num ${pct < 80 ? 'warn' : ''}">${tp ? pct + '%' : ''}</td></tr>`;
  };
  let html = `<thead><tr><th rowspan="2">Khoản mục</th>${head}<th class="num" colspan="2">Cả năm</th><th class="num" rowspan="2">TT/KH</th></tr><tr>${sub}<th class="num">KH</th><th class="num">TT</th></tr></thead><tbody>`;
  html += `<tr class="section"><td colspan="${m.months.length * 2 + 4}">A. DÒNG TIỀN VÀO</td></tr>`;
  used.filter(c => c.flow === 'in').forEach(c => (html += row(esc(c.name), x => x.byCategory[c.code] || 0, 'in')));
  html += row('Tổng thu', x => x.inflow, 'in', 'total');
  html += `<tr class="section"><td colspan="${m.months.length * 2 + 4}">B. DÒNG TIỀN RA</td></tr>`;
  used.filter(c => c.flow === 'out').forEach(c => (html += row(esc(c.name), x => x.byCategory[c.code] || 0, 'out')));
  html += row('Tổng chi', x => x.outflow, 'out', 'total');
  html += row('C. Dòng tiền thuần (A − B)', x => x.net, '', 'grand');
  html += `<tr class="grand"><td>D. Số dư tiền cuối tháng</td>${m.months.map((_, i) => cell(m.plan[i].balance, signCls(m.plan[i].balance)) + cell(m.actual[i].balance, signCls(m.actual[i].balance))).join('')}<td colspan="3"></td></tr>`;
  $('#planTable').innerHTML = html + '</tbody>';
}
$('#pProject').addEventListener('change', loadPlan);

// ===== Dự án =====
async function loadProjects() {
  const rows = await api('/api/reports/projects');
  $('#projectTable').innerHTML = `<thead><tr><th>Mã</th><th>Tên dự án</th><th>Chủ đầu tư</th><th class="num">Giá trị HĐ</th><th class="num">Đã thu</th><th>% thu</th><th class="num">Còn phải thu</th><th class="num">Đã chi</th><th class="num">Dòng tiền thuần</th><th>Thời gian</th>${ME.role === 'admin' ? '<th></th>' : ''}</tr></thead><tbody>` +
    rows.map(p => `<tr><td>${esc(p.code)}</td><td class="wrap">${esc(p.name)}</td><td class="wrap">${esc(p.client)}</td>
      <td class="num">${fmt(p.contractValue)}</td><td class="num in">${fmt(p.actualIn)}</td>
      <td><div class="bar"><span style="width:${Math.min(100, p.collectedPct * 100)}%"></span></div><small>${(p.collectedPct * 100).toFixed(1)}%</small></td>
      <td class="num">${fmt(p.receivable)}</td><td class="num out">${fmt(p.actualOut)}</td><td class="num ${signCls(p.actualNet)}">${fmt(p.actualNet)}</td>
      <td class="muted">${esc(p.start)} → ${esc(p.end)}</td>
      ${ME.role === 'admin' ? `<td><button class="btn danger sm" data-delp="${p.id}">Xoá</button></td>` : ''}</tr>`).join('') + '</tbody>';
}
$('#projectTable').addEventListener('click', async e => {
  const id = e.target.dataset.delp;
  if (id && confirm('Xoá dự án?')) { await api('/api/projects/' + id, { method: 'DELETE' }); await refreshMeta(); loadProjects(); }
});
$('#btnAddProject').addEventListener('click', async () => {
  const data = await openForm($('#dlgProject'));
  if (data) { await api('/api/projects', { method: 'POST', body: data }); toast('Đã thêm dự án'); await refreshMeta(); loadProjects(); }
});

async function refreshMeta() {
  META = await api('/api/meta');
  ['#dashProject', '#fProject', '#sProject', '#pProject'].forEach(s => fillProjectSelect($(s)));
  $('#fProject').insertAdjacentHTML('beforeend', '<option value="_none">Chung (không gắn dự án)</option>');
  fillProjectSelect($('#formTx').elements.projectId, { all: false, none: true });
}

// ===== Quản trị =====
async function loadAdmin() {
  $('#setCompany').value = META.settings.companyName || '';
  $('#setOpening').value = META.settings.openingBalance || 0;
  const users = await api('/api/users');
  const roleName = { admin: 'Quản trị', ketoan: 'Kế toán', xem: 'Chỉ xem' };
  $('#userTable').innerHTML = '<thead><tr><th>Tên đăng nhập</th><th>Họ tên</th><th>Vai trò</th><th></th></tr></thead><tbody>' +
    users.map(u => `<tr><td>${esc(u.username)}</td><td>${esc(u.fullName)}</td><td>${roleName[u.role]}</td>
      <td>${u.id !== ME.id ? `<button class="btn danger sm" data-delu="${u.id}">Xoá</button>` : '<span class="muted">(bạn)</span>'}</td></tr>`).join('') + '</tbody>';
  loadSecurity();
}

// ===== Tường lửa & nhật ký =====
const AUDIT_LABEL = {
  login_success: 'Đăng nhập', login_fail: 'Đăng nhập sai', login_locked: 'Tài khoản bị khoá', logout: 'Đăng xuất',
  password_change: 'Đổi mật khẩu', password_change_fail: 'Đổi mật khẩu thất bại', user_create: 'Thêm người dùng', user_delete: 'Xoá người dùng',
  user_unlock: 'Mở khoá tài khoản', settings_update: 'Sửa thiết lập', project_create: 'Thêm dự án', project_delete: 'Xoá dự án',
  tx_create: 'Thêm giao dịch', tx_update: 'Sửa giao dịch', tx_delete: 'Xoá giao dịch', ip_banned: 'Chặn IP tự động', ip_unban: 'Bỏ chặn IP'
};
const AUDIT_ALERT = ['login_fail', 'login_locked', 'ip_banned', 'password_change_fail'];

async function loadSecurity() {
  const [st, logs] = await Promise.all([api('/api/security/status'), api('/api/security/audit')]);
  const c = st.config;
  const item = (label, value, ok) => `<div class="sec-item"><div class="label">${label}</div><div class="value ${ok === false ? 'warn' : ''}">${value}</div></div>`;
  $('#secConfig').innerHTML = [
    item('Chỉ nhận truy cập qua Cloudflare', c.cloudflareOnly ? 'Bật' : 'Chưa bật', c.cloudflareOnly),
    item('Danh sách IP được phép', c.allowedIps.length ? esc(c.allowedIps.join(', ')) : 'Mọi IP'),
    item('Giới hạn truy cập', `${c.globalPerMin} req/phút · API ${c.apiPerMin}/phút`),
    item('Đăng nhập', `${c.loginPer15Min} lần/15 phút/IP · khoá TK sau ${c.userMaxFails} lần sai (${c.userLockMin} phút)`),
    item('Tự động chặn IP', `≥ ${c.banScore} điểm vi phạm → chặn ${c.banMin} phút`),
    item('Độ trễ xử lý hiện tại', st.eventLoopLagMs + ' ms', st.eventLoopLagMs < 200)
  ].join('');
  $('#banTable').innerHTML = '<thead><tr><th>IP</th><th>Lý do</th><th class="num">Còn</th><th></th></tr></thead><tbody>' +
    (st.bans.map(b => `<tr><td>${esc(b.ip)}</td><td class="wrap">${esc(b.reason)}</td><td class="num">${b.minutesLeft} phút</td><td><button class="btn sm ghost" data-unban="${esc(b.ip)}">Bỏ chặn</button></td></tr>`).join('') ||
      '<tr><td colspan="4" class="muted">Không có IP nào bị chặn</td></tr>') + '</tbody>';
  $('#lockTable').innerHTML = '<thead><tr><th>Tài khoản</th><th class="num">Còn</th><th></th></tr></thead><tbody>' +
    (st.lockedUsers.map(u => `<tr><td>${esc(u.username)}</td><td class="num">${u.minutesLeft} phút</td><td><button class="btn sm ghost" data-unlock="${esc(u.username)}">Mở khoá</button></td></tr>`).join('') ||
      '<tr><td colspan="3" class="muted">Không có tài khoản nào bị khoá</td></tr>') + '</tbody>';
  $('#auditTable').innerHTML = '<thead><tr><th>Thời gian</th><th>Sự kiện</th><th>Người dùng</th><th>IP</th><th>Chi tiết</th></tr></thead><tbody>' +
    logs.map(l => `<tr class="${AUDIT_ALERT.includes(l.action) ? 'alert' : ''}"><td>${new Date(l.at).toLocaleString('vi-VN')}</td>
      <td>${esc(AUDIT_LABEL[l.action] || l.action)}</td><td>${esc(l.username || '')}</td><td>${esc(l.ip || '')}</td><td class="wrap">${esc(l.detail || '')}</td></tr>`).join('') + '</tbody>';
}
$('#btnSecRefresh').addEventListener('click', loadSecurity);
$('#view-admin').addEventListener('click', async e => {
  const { unban, unlock } = e.target.dataset;
  if (unban) { await api('/api/security/unban', { method: 'POST', body: { ip: unban } }); toast('Đã bỏ chặn ' + unban); loadSecurity(); }
  if (unlock) { await api('/api/security/unlock', { method: 'POST', body: { username: unlock } }); toast('Đã mở khoá ' + unlock); loadSecurity(); }
});
$('#btnPrint').addEventListener('click', () => window.print());
$('#btnSaveSettings').addEventListener('click', async () => {
  META.settings = await api('/api/settings', { method: 'PUT', body: { companyName: $('#setCompany').value, openingBalance: $('#setOpening').value } });
  $('#company').textContent = META.settings.companyName;
  toast('Đã lưu thiết lập');
});
$('#btnAddUser').addEventListener('click', async () => {
  const data = await openForm($('#dlgUser'));
  if (data) { await api('/api/users', { method: 'POST', body: data }); toast('Đã thêm người dùng'); loadAdmin(); }
});
$('#userTable').addEventListener('click', async e => {
  const id = e.target.dataset.delu;
  if (id && confirm('Xoá người dùng?')) { await api('/api/users/' + id, { method: 'DELETE' }); loadAdmin(); }
});

// ===== Tài khoản =====
$('#btnLogout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
$('#btnPwd').addEventListener('click', async () => {
  const data = await openForm($('#dlgPwd'));
  if (data) { await api('/api/me/password', { method: 'POST', body: data }); toast('Đã đổi mật khẩu'); }
});

init();
