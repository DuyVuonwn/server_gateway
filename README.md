# Body Camera Gateway & VMS Server System

Hệ thống quản lý Body Camera bao gồm hai thành phần chính: **Gateway** (xử lý kết nối thiết bị, âm thanh nhóm) và **VMS Server** (quản lý tập trung, dashboard, đồng bộ dữ liệu).

## 1. Yêu cầu hệ thống (Prerequisites)

Trước khi cài đặt code, bạn cần cài đặt các phần mềm hệ thống sau:

### Linux (Ubuntu/Debian)
```bash
# Cập nhật hệ thống
sudo apt update

# Cài đặt FFmpeg (Bắt buộc cho Audio Mixing)
sudo apt install ffmpeg -y

# Cài đặt công cụ Build (Để biên dịch SQLite và C++ Addon)
sudo apt install build-essential python3 g++ make -y

# Cài đặt Node.js (Yêu cầu v18+)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

### Windows
- Cài đặt **Node.js** từ trang chủ.
- Cài đặt **FFmpeg** và thêm vào biến môi trường `PATH`.
- Cài đặt **Visual Studio Build Tools** (để biên dịch node-gyp).

---

## 2. Các thành phần bổ trợ (External Binaries)

### MediaMTX
Dự án sử dụng **MediaMTX** làm media server.
- Tải bản phù hợp từ [MediaMTX GitHub Releases](https://github.com/bluenviron/mediamtx/releases).
- Giải nén và đặt file thực thi (ví dụ: `mediamtx` hoặc `mediamtx.exe`) vào thư mục `gateway/`.
- Cấu hình tệp `mediamtx.yml` đã được cung cấp sẵn trong thư mục đó.

---

## 3. Cài đặt chi tiết (Installation)

### Bước 1: Cài đặt thư viện Node.js
Bạn cần chạy lệnh cài đặt trong cả 2 thư mục:

```bash
# Cài cho Gateway
cd gateway
npm install

# Cài cho VMS Server
cd ../vms_server
npm install
```

### Bước 2: Cấu hình môi trường (.env)
Copy file mẫu và điền thông tin thực tế (IP, Port, MQTT...):

```bash
# Tại gateway/
cp .env.example .env

# Tại vms_server/
cp .env.example .env
```

---

## 4. Cách khởi chạy (Running)

### Khởi chạy Gateway
Chỉ cần chạy server Gateway, tệp thực thi `mediamtx` (nếu đã đặt đúng chỗ) sẽ được tự động khởi chạy:

```bash
cd gateway
npm start  # Hoặc "npm run dev"
```

### Khởi chạy VMS Server
```bash
cd vms_server
npm start
```

---

## 5. Cấu trúc dự án
- `gateway/`: Xử lý giao tiếp thiết bị (MQTT), Audio Mixing (FFmpeg), và MediaMTX.
- `vms_server/`: Dashboard quản lý, xử lý Logic Sync bằng C++ Addon hiệu năng cao.
- `.gitignore`: Đã được cấu hình để loại bỏ tệp rác và bảo mật dữ liệu.
