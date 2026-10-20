// Tạo dữ liệu mẫu: tài khoản quản trị, 3 dự án, kế hoạch & thực tế dòng tiền năm 2026
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./store');

const newId = () => crypto.randomUUID();

// Bộ sinh số giả ngẫu nhiên cố định để dữ liệu mẫu ổn định giữa các lần chạy
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

async function seed({ force = false } = {}) {
  if (!force && !(await store.isEmpty())) return false;
  const state = {};

  const rand = rng(20260101);
  const round = v => Math.round(v / 1e6) * 1e6; // làm tròn triệu đồng

  state.users = [{
    id: newId(),
    username: process.env.ADMIN_USER || 'admin',
    fullName: 'Quản trị hệ thống',
    role: 'admin',
    passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Admin@123', 10),
    createdAt: new Date().toISOString()
  }];

  state.settings = { openingBalance: 5_000_000_000, companyName: 'Công ty CP Xây dựng (mẫu)', year: 2026 };

  state.projects = [
    { code: 'DA01', name: 'Nhà xưởng KCN Bắc Ninh', client: 'Công ty TNHH ABC', contractValue: 45_000_000_000, start: '2026-01-01', end: '2026-10-31' },
    { code: 'DA02', name: 'Trường THCS Quận 9', client: 'Ban QLDA Quận 9', contractValue: 28_000_000_000, start: '2026-03-01', end: '2026-12-31' },
    { code: 'DA03', name: 'Chung cư Green Tower', client: 'Công ty CP Địa ốc XYZ', contractValue: 62_000_000_000, start: '2026-05-01', end: '2027-06-30' }
  ].map(p => ({ id: newId(), ...p }));

  const tx = [];
  const add = (date, projectId, category, amount, kind, description) =>
    tx.push({ id: newId(), date, projectId, category, amount: round(amount), kind, description, createdBy: 'seed', createdAt: new Date().toISOString() });

  const actualUntilMonth = 9; // thực tế đến hết tháng 9/2026
  for (const p of state.projects) {
    const startM = Number(p.start.slice(5, 7));
    const months = [];
    for (let m = startM; m <= 12; m++) months.push(m);
    const monthly = p.contractValue / Math.max(months.length, 8);

    months.forEach((m, i) => {
      const d = day => `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const plan = {
        thu: i === 0 ? p.contractValue * 0.15 : monthly * 0.9,
        vattu: monthly * 0.42, thauphu: monthly * 0.2, may: monthly * 0.08, nc: monthly * 0.12, cpc: monthly * 0.04
      };
      add(d(25), p.id, 'KD_THU_CDT', plan.thu, 'plan', i === 0 ? 'Tạm ứng hợp đồng 15%' : `Thanh toán khối lượng đợt ${i}`);
      add(d(10), p.id, 'KD_CHI_VATTU', plan.vattu, 'plan', 'Vật tư chính (thép, xi măng, bê tông)');
      add(d(15), p.id, 'KD_CHI_THAUPHU', plan.thauphu, 'plan', 'Thanh toán thầu phụ');
      add(d(12), p.id, 'KD_CHI_MAY', plan.may, 'plan', 'Thuê máy thi công');
      add(d(5), p.id, 'KD_CHI_NHANCONG', plan.nc, 'plan', 'Lương nhân công');
      add(d(28), p.id, 'KD_CHI_CPC', plan.cpc, 'plan', 'Chi phí chung công trường');

      if (m <= actualUntilMonth) {
        const f = () => 0.8 + rand() * 0.35; // lệch thực tế so với kế hoạch
        // Thu thực tế thường chậm hơn kế hoạch
        add(d(27), p.id, 'KD_THU_CDT', plan.thu * (i === 0 ? 1 : 0.7 + rand() * 0.35), 'actual', i === 0 ? 'CĐT chuyển tạm ứng' : `CĐT thanh toán đợt ${i}`);
        add(d(11), p.id, 'KD_CHI_VATTU', plan.vattu * f(), 'actual', 'Thanh toán NCC vật tư');
        add(d(16), p.id, 'KD_CHI_THAUPHU', plan.thauphu * f(), 'actual', 'Thanh toán thầu phụ');
        add(d(13), p.id, 'KD_CHI_MAY', plan.may * f(), 'actual', 'Chi phí ca máy');
        add(d(6), p.id, 'KD_CHI_NHANCONG', plan.nc * f(), 'actual', 'Trả lương nhân công');
        add(d(28), p.id, 'KD_CHI_CPC', plan.cpc * f(), 'actual', 'Chi phí chung công trường');
      }
    });
  }

  // Dòng tiền cấp doanh nghiệp (không gắn dự án)
  for (const kind of ['plan', 'actual']) {
    add('2026-02-10', null, 'TC_THU_VAY', 10_000_000_000, kind, 'Giải ngân vay vốn lưu động NH');
    add('2026-04-05', null, 'DT_CHI_TSCD', 3_500_000_000, kind, 'Mua cẩu tháp');
    add('2026-07-20', null, 'DT_THU_TSCD', 400_000_000, kind, 'Thanh lý máy xúc cũ');
    add('2026-08-30', null, 'TC_CHI_VAY', 3_000_000_000, kind, 'Trả nợ gốc kỳ 1');
    if (kind === 'plan') add('2026-12-30', null, 'TC_CHI_VAY', 4_000_000_000, kind, 'Trả nợ gốc kỳ 2');
    add('2026-03-30', null, 'KD_CHI_THUE', 600_000_000, kind, 'Tạm nộp thuế TNDN');
    for (let m = 1; m <= (kind === 'plan' ? 12 : actualUntilMonth); m++) {
      add(`2026-${String(m).padStart(2, '0')}-25`, null, 'KD_CHI_LAIVAY', m >= 2 ? 85_000_000 : 0, kind, 'Lãi vay ngân hàng');
    }
  }

  state.transactions = tx.filter(t => t.amount > 0);
  await store.replaceAll(state);
  return true;
}

module.exports = { seed };

if (require.main === module) {
  (async () => {
    await store.init();
    await seed({ force: process.argv.includes('--force') });
    console.log('Đã tạo dữ liệu mẫu tại', store.location);
    if (store.pool) await store.pool.end();
  })().catch(e => { console.error(e); process.exit(1); });
}
