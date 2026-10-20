# Báo cáo Tài chính & Dòng tiền (bản sơ khai v0.1)

Ứng dụng web quản lý dòng tiền và lập báo cáo tài chính cho doanh nghiệp xây dựng, có đăng nhập và phân quyền.

## Chức năng

| Phân hệ | Nội dung |
|---|---|
| **Đăng nhập** | Mật khẩu mã hoá bcrypt, phiên làm việc 8 giờ, khoá tạm 15 phút sau 5 lần nhập sai, đổi mật khẩu |
| **Tổng quan** | KPI thu/chi/dòng tiền thuần/số dư; biểu đồ dòng tiền theo tháng, cơ cấu chi, số dư lũy kế kế hoạch vs thực tế |
| **Sổ thu chi** | Nhập/sửa/xoá giao dịch thực tế và kế hoạch, lọc theo kỳ/dự án, xuất CSV (mở được bằng Excel) |
| **Báo cáo LCTT (B03-DN)** | Báo cáo lưu chuyển tiền tệ theo phương pháp trực tiếp (TT200), mã số 01–70, theo kỳ & dự án, in trực tiếp |
| **Kế hoạch vs Thực tế** | Ma trận 12 tháng theo khoản mục, tỷ lệ TT/KH, số dư cuối tháng (cảnh báo khi < 80%) |
| **Dự án** | Giá trị HĐ, đã thu, % thu, còn phải thu, đã chi, dòng tiền thuần theo từng công trình |
| **Quản trị** | Số dư đầu kỳ, tên công ty, quản lý người dùng |

### Phân quyền

- `admin` – toàn quyền, quản lý người dùng & thiết lập
- `ketoan` – nhập liệu giao dịch, thêm dự án
- `xem` – chỉ xem báo cáo

## Cài đặt & chạy

Yêu cầu Node.js ≥ 18.

```bash
npm install
npm start          # http://localhost:3000
```

Lần chạy đầu tiên hệ thống tự tạo dữ liệu mẫu năm 2026 (3 dự án) và tài khoản:

- Tên đăng nhập: `admin`
- Mật khẩu: `Admin@123` → **đổi ngay sau khi đăng nhập**

Tạo lại dữ liệu mẫu: `npm run seed` (xoá toàn bộ dữ liệu hiện có).

### Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `PORT` | Cổng chạy (mặc định 3000) |
| `SESSION_SECRET` | Khoá ký phiên đăng nhập – **bắt buộc đặt khi triển khai thật** |
| `COOKIE_SECURE=1` | Bật khi chạy qua HTTPS |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Tài khoản admin khởi tạo lần đầu |
| `DB_FILE` | Đường dẫn file dữ liệu (mặc định `data/db.json`) |

## Cấu trúc

```
server.js              API + xác thực (Express)
lib/categories.js      Danh mục dòng tiền ↔ mã số B03-DN
lib/db.js              Lưu trữ JSON (sẽ thay bằng CSDL)
lib/seed.js            Dữ liệu mẫu
public/login.html      Trang đăng nhập
public/index.html      Giao diện chính
public/assets/         CSS + JS phía trình duyệt
```

## Lộ trình đề xuất

- [ ] Chuyển lưu trữ sang PostgreSQL / SQL Server
- [ ] Báo cáo KQKD (B02-DN), Bảng CĐKT (B01-DN)
- [ ] Nhập dữ liệu từ Excel, xuất báo cáo Excel/PDF theo mẫu
- [ ] Công nợ phải thu CĐT / phải trả NCC, thầu phụ (tuổi nợ)
- [ ] Dự báo dòng tiền theo tiến độ thi công & điều khoản thanh toán HĐ
- [ ] Nhật ký thao tác (audit log), phê duyệt chứng từ
