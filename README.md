# Khóa cửa từ xa

Trang web tĩnh để theo dõi khóa cửa thông minh (ESP32-S3) **từ bất kỳ mạng nào**, chạy trên GitHub Pages.
Trang không nói chuyện trực tiếp với ESP32 mà đi qua broker MQTT HiveMQ Cloud bằng WebSocket bảo mật (`wss://`, cổng 8884).

- Xem trạng thái khóa (trực tuyến / ngoại tuyến)
- Lịch sử ra vào (20 sự kiện gần nhất từ ESP32 + các sự kiện trình duyệt đã lưu)
- Cảnh báo đột nhập: nền đỏ, kêu bíp, rung, nháy tiêu đề tab
- Bảng giả lập (bản test): gửi lệnh `open` / `denied` / `intrusion` / `voice_in` xuống ESP32

Đăng nhập bằng tài khoản HiveMQ Cloud của nhóm. Repo này **không chứa mật khẩu nào**, đừng thêm vào.

## Topic MQTT (phải khớp `mqtt_client_tcp.h` trong firmware)

| Topic | Chiều | Nội dung |
|---|---|---|
| `doorlock/event` | ESP32 → web | JSON một sự kiện `{"ts","type","method","detail"}` |
| `doorlock/history` | ESP32 → web (retained) | Mảng JSON các sự kiện gần nhất |
| `doorlock/status` | ESP32 → web (retained) | `online` / `offline` (Last Will) |
| `doorlock/cmd` | web → ESP32 | `open`, `denied`, `intrusion`, `voice_in` |

## Cập nhật trang

Sửa file rồi commit + push lên nhánh `main`, GitHub Pages tự cập nhật sau 1-2 phút
(trình duyệt có thể giữ bản cũ thêm ~10 phút, bấm Ctrl+F5 để tải lại).

Đổi broker thì sửa **cả hai chỗ**: `BROKER_URL` trong `app.js` và `connect-src` trong thẻ meta CSP của `index.html`.

`mqtt.min.js` là [MQTT.js](https://github.com/mqttjs/MQTT.js) 5.16.0 (giấy phép MIT), đặt kèm để không phụ thuộc CDN.
