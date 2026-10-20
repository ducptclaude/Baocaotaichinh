// Danh mục dòng tiền, ánh xạ theo mã số chỉ tiêu mẫu B03-DN (phương pháp trực tiếp, TT200/2014/TT-BTC)
// activity: KD = hoạt động kinh doanh, DT = hoạt động đầu tư, TC = hoạt động tài chính
const CATEGORIES = [
  { code: 'KD_THU_CDT', activity: 'KD', flow: 'in', ms: '01', name: 'Thu tiền từ Chủ đầu tư (tạm ứng, nghiệm thu thanh toán)' },
  { code: 'KD_THU_KHAC', activity: 'KD', flow: 'in', ms: '06', name: 'Thu khác từ hoạt động kinh doanh' },
  { code: 'KD_CHI_VATTU', activity: 'KD', flow: 'out', ms: '02', name: 'Chi trả nhà cung cấp vật tư' },
  { code: 'KD_CHI_THAUPHU', activity: 'KD', flow: 'out', ms: '02', name: 'Chi trả thầu phụ' },
  { code: 'KD_CHI_MAY', activity: 'KD', flow: 'out', ms: '02', name: 'Chi phí máy thi công' },
  { code: 'KD_CHI_NHANCONG', activity: 'KD', flow: 'out', ms: '03', name: 'Chi trả người lao động / nhân công' },
  { code: 'KD_CHI_LAIVAY', activity: 'KD', flow: 'out', ms: '04', name: 'Chi trả lãi vay' },
  { code: 'KD_CHI_THUE', activity: 'KD', flow: 'out', ms: '05', name: 'Chi nộp thuế TNDN' },
  { code: 'KD_CHI_CPC', activity: 'KD', flow: 'out', ms: '07', name: 'Chi phí chung, quản lý công trường & chi khác' },
  { code: 'DT_CHI_TSCD', activity: 'DT', flow: 'out', ms: '21', name: 'Mua sắm TSCĐ, máy móc thiết bị' },
  { code: 'DT_THU_TSCD', activity: 'DT', flow: 'in', ms: '22', name: 'Thu thanh lý, nhượng bán TSCĐ' },
  { code: 'TC_THU_VON', activity: 'TC', flow: 'in', ms: '31', name: 'Nhận vốn góp của chủ sở hữu' },
  { code: 'TC_THU_VAY', activity: 'TC', flow: 'in', ms: '33', name: 'Tiền thu từ đi vay' },
  { code: 'TC_CHI_VAY', activity: 'TC', flow: 'out', ms: '34', name: 'Tiền trả nợ gốc vay' },
  { code: 'TC_CHI_COTUC', activity: 'TC', flow: 'out', ms: '36', name: 'Cổ tức, lợi nhuận đã trả cho chủ sở hữu' }
];

const ACTIVITIES = {
  KD: 'Lưu chuyển tiền từ hoạt động kinh doanh',
  DT: 'Lưu chuyển tiền từ hoạt động đầu tư',
  TC: 'Lưu chuyển tiền từ hoạt động tài chính'
};

const byCode = Object.fromEntries(CATEGORIES.map(c => [c.code, c]));

module.exports = { CATEGORIES, ACTIVITIES, byCode };
