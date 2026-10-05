# Khóa cửa từ xa (chỉ xem)

Bản deploy GitHub Pages của thư mục `web/` trong project
[AESD_project](https://github.com/anh-phi-dao/AESD_project). Đừng sửa trực tiếp ở đây: sửa trong `web/`
của project rồi copy sang repo này.

Trang kết nối tới broker HiveMQ Cloud qua `wss://` (cổng 8884) để xem khóa ESP32-S3:

- Trạng thái trực tuyến / ngoại tuyến (Last Will)
- Lịch sử ra vào và cảnh báo, xem được cả khi khóa offline (topic retained `recent`)
- Cảnh báo: banner, âm báo, rung, nháy tiêu đề tab; báo cả cảnh báo bị lỡ khi đóng trang
- Cài như app (PWA)

**Chế độ chỉ xem: không có cách nào mở cửa qua mạng.** Không có topic hay nút gửi lệnh mở cửa. Cửa chỉ mở
bằng keypad/NFC tại chỗ.

Topic và payload: xem `docs/mqtt_protocol.md` trong project (tiền tố `lock/<device_id>/`).

`config.js` chỉ điền sẵn URL broker và mã thiết bị. File này công khai, **không ghi mật khẩu vào đây**.
Đăng nhập bằng tài khoản web trên broker, không dùng tài khoản của thiết bị.
