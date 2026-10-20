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
| `DATABASE_URL` | Chuỗi kết nối PostgreSQL; nếu không đặt, dữ liệu lưu vào file JSON |
| `DB_FILE` | Đường dẫn file JSON khi không dùng PostgreSQL (mặc định `data/db.json`) |

## Triển khai lên Railway

1. Đăng nhập https://railway.com bằng GitHub → **New Project** → **Deploy from GitHub repo** → chọn `Baocaotaichinh`.
2. Trong project bấm **+ Create → Database → PostgreSQL**.
3. Vào service web → tab **Variables**, thêm:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (tham chiếu tới service Postgres)
   - `SESSION_SECRET` = chuỗi ngẫu nhiên dài (≥ 32 ký tự)
   - `COOKIE_SECURE` = `1`
   - `ADMIN_PASSWORD` = mật khẩu admin ban đầu
4. Tab **Settings → Networking** → **Generate Domain** để có địa chỉ `https://xxx.up.railway.app`.
5. Mỗi lần push lên nhánh `main`, Railway tự động build & deploy lại.

Khi khởi động, hệ thống tự tạo bảng trong PostgreSQL và nạp dữ liệu mẫu nếu CSDL còn trống.
Phiên đăng nhập cũng lưu trong PostgreSQL nên người dùng không bị đăng xuất khi deploy lại.
Kiểm tra: `https://<domain>/healthz` trả về `"store":"postgres"`.

Cấu hình build/khởi động nằm trong `railway.json`.

## Bảo mật & chống DDoS

Hệ thống bảo vệ theo nhiều lớp. Lớp L3/L4 (ngập băng thông, SYN/UDP flood) **không thể chặn trong ứng dụng**:
lưu lượng phải được lọc ở biên mạng trước khi tới máy chủ. Vì vậy cần đặt Cloudflare phía trước Railway.

| Lớp | Mối đe doạ | Biện pháp | Ở đâu |
|---|---|---|---|
| L3/L4 | SYN flood, UDP flood, ngập băng thông | Mạng chống DDoS Anycast | Cloudflare (+ Railway Edge) |
| L7 | HTTP flood | Rate limiting, WAF, Bot Fight, Under Attack mode | Cloudflare |
| L7 | HTTP flood lọt qua biên | Giới hạn 300 req/phút/IP, API 120 req/phút/IP; vượt nhiều lần → tự chặn IP 60 phút | Ứng dụng |
| L7 | Quá tải | Đo độ trễ xử lý; quá 300 ms thì từ chối bớt request lạ, ưu tiên người đã đăng nhập | Ứng dụng |
| L7 | Slowloris, kết nối treo | Cắt kết nối gửi header quá 15 giây, request quá 30 giây | Ứng dụng |
| L7 | Dò mật khẩu | 10 lần/15 phút/IP; khoá tài khoản 15 phút sau 5 lần sai; thời gian phản hồi như nhau | Ứng dụng |
| L7 | Quét lỗ hổng (.env, .git, wp-admin, .php, ../) | Trả 404 và cộng điểm vi phạm → chặn IP | Ứng dụng |
| L7 | XSS, clickjacking, MIME sniffing | Content-Security-Policy chặn script lạ, chặn nhúng iframe, HSTS | Ứng dụng |
| L7 | CSRF | Cookie SameSite=Strict, chỉ nhận JSON cùng nguồn gốc | Ứng dụng |
| L7 | Chiếm phiên | Cookie HttpOnly/Secure, tự đăng xuất sau 30 phút không thao tác, tối đa 8 giờ | Ứng dụng |
| Dữ liệu | CSV injection | Vô hiệu hoá ô bắt đầu bằng = + - @ khi xuất CSV | Ứng dụng |
| Kiểm soát | Truy vết | Nhật ký đăng nhập, thao tác dữ liệu, IP bị chặn (lưu 12 tháng) | Quản trị → Nhật ký |

Mật khẩu mới: tối thiểu 10 ký tự, có chữ hoa, chữ thường, chữ số và ký tự đặc biệt.

### Đưa Cloudflare đứng trước Railway (bắt buộc để chống DDoS L3/L4)

Cần một tên miền riêng (ví dụ `baocao.congty.vn`).

1. Thêm tên miền vào Cloudflare (gói Free là đủ), đổi nameserver tại nhà cung cấp tên miền theo hướng dẫn của Cloudflare.
2. Railway → service web → **Settings → Networking → Custom Domain** → nhập `baocao.congty.vn`, Railway cho một bản ghi CNAME.
3. Cloudflare → **DNS** → thêm bản ghi CNAME đó, bật **Proxied** (đám mây màu cam).
4. Cloudflare → **SSL/TLS** → chế độ **Full (strict)**.
5. Cloudflare → **Security**: bật **Bot Fight Mode**; tạo **WAF → Rate limiting rule**: đường dẫn `/api/login`, 5 request / 10 giây / IP → Block.
   Khi đang bị tấn công: **Overview → Under Attack Mode**.
6. Chặn truy cập vòng qua Cloudflare (đi thẳng vào `*.up.railway.app`):
   - Tạo một chuỗi bí mật ngẫu nhiên dài.
   - Cloudflare → **Rules → Transform Rules → Modify Request Header** → áp dụng cho mọi request → **Set static** header `X-Origin-Secret` = chuỗi bí mật.
   - Railway → **Variables**: `CF_ORIGIN_SECRET` = cùng chuỗi bí mật.
   - Từ đây mọi request không đi qua Cloudflare bị trả 403 (trừ `/healthz` cho Railway kiểm tra).
7. Kiểm tra: tab **Quản trị → Tường lửa & bảo mật** hiển thị "Chỉ nhận truy cập qua Cloudflare: Bật".

### Biến môi trường bảo mật (tuỳ chọn)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CF_ORIGIN_SECRET` | (trống) | Chỉ nhận request đi qua Cloudflare có header `X-Origin-Secret` khớp |
| `ALLOWED_IPS` | (trống = mọi IP) | Chỉ cho phép IP/dải IP, ví dụ `113.160.10.5,203.113.0.0/16` (IP văn phòng) |
| `RATE_LIMIT_PER_MIN` | 300 | Số request tối đa / IP / phút |
| `API_RATE_LIMIT_PER_MIN` | 120 | Số request API tối đa / IP / phút |
| `LOGIN_RATE_LIMIT` | 10 | Số lần thử đăng nhập / IP / 15 phút |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCK_MINUTES` | 5 / 15 | Khoá tài khoản sau N lần sai liên tiếp |
| `BAN_SCORE` / `BAN_MINUTES` | 20 / 60 | Điểm vi phạm để tự chặn IP / thời gian chặn |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | 30 / 8 | Tự đăng xuất khi không thao tác / thời hạn tối đa phiên |
| `EVENT_LOOP_LAG_LIMIT_MS` | 300 | Ngưỡng quá tải để từ chối bớt request lạ |

Danh sách IP bị chặn và tài khoản bị khoá lưu trong bộ nhớ, được xoá khi deploy lại.

## Cấu trúc

```
server.js              API + xác thực (Express)
lib/security.js        Tường lửa L7: giới hạn tần suất, chặn IP, chống dò mật khẩu, CSRF
lib/categories.js      Danh mục dòng tiền ↔ mã số B03-DN
lib/store/pg.js        Lưu trữ PostgreSQL (bảng users, projects, transactions, settings)
lib/store/json.js      Lưu trữ file JSON (chạy thử trên máy)
lib/seed.js            Dữ liệu mẫu
public/login.html      Trang đăng nhập
public/index.html      Giao diện chính
public/assets/         CSS + JS phía trình duyệt
```

## Lộ trình đề xuất

- [x] Lưu trữ PostgreSQL
- [ ] Báo cáo KQKD (B02-DN), Bảng CĐKT (B01-DN)
- [ ] Nhập dữ liệu từ Excel, xuất báo cáo Excel/PDF theo mẫu
- [ ] Công nợ phải thu CĐT / phải trả NCC, thầu phụ (tuổi nợ)
- [ ] Dự báo dòng tiền theo tiến độ thi công & điều khoản thanh toán HĐ
- [ ] Nhật ký thao tác (audit log), phê duyệt chứng từ
