// Chọn nơi lưu trữ: PostgreSQL khi có DATABASE_URL (Railway), ngược lại dùng file JSON (chạy thử trên máy)
module.exports = process.env.DATABASE_URL ? require('./pg') : require('./json');
