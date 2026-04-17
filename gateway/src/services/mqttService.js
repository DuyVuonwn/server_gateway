/**
 * ============================================================
 * GATEWAY SERVER — mqttService.js
 * Port từ mqtt_service.py (Python / paho-mqtt)
 * Dùng mqtt.js v5 (npm package: mqtt)
 * ============================================================
 */
'use strict';

const mqtt = require('mqtt');
const config = require('../config');
const db = require('./databaseService');

// ============================================================
// STORE TOÀN CỤC (tương đương dict/map trong Python)
// ============================================================

/**
 * pendingResponses: Map lưu kết quả lệnh cho đến khi gửi webhook.
 * key = mid (String), value = payload object từ Camera
 * Dùng để log/debug; không còn endpoint polling.
 */
const pendingResponses = new Map();

/**
 * onlineDevices: Map theo dõi thiết bị đang online.
 * key = deviceId, value = { lastSeen (ms), paras, deviceContext }
 * Tương đương `online_devices = {}` trong Python.
 */
const onlineDevices = new Map();

// State kết nối MQTT
let mqttClient = null;
let mqttConnected = false;

// ============================================================
// HTTP HELPER — Gửi dữ liệu về VMS Server (webhook)
// Tương đương _post_to_server() + threading.Thread trong Python
// ============================================================

/**
 * Gửi HTTP POST tới VMS Server. Retry tối đa 3 lần.
 * Chạy bất đồng bộ, không block event loop.
 * @param {string} path  - ví dụ: '/api/response'
 * @param {object} payload
 * @param {string} eventName - tên sự kiện để log
 */
async function postToServer(path, payload, eventName) {
  const url = `${config.SERVER_API_BASE_URL}${path}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.SERVER_API_TIMEOUT),
      });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log(`[GATEWAY -> VMS] Đã gửi webhook "${eventName}" tới VMS thành công`);
      return; // Thành công, thoát

    } catch (err) {
      console.log(`[GATEWAY -> VMS] Gửi webhook "${eventName}" thất bại lần ${attempt} tới VMS: ${err.message}`);
      if (attempt < 3) {
        // Chờ 1 giây trước khi retry (tương đương time.sleep(1) trong Python)
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  console.log(`[SERVER API] Bỏ cuộc gửi "${eventName}" tới ${url}`);
}

// ============================================================
// DEVICE SYNC HELPER
// ============================================================

/**
 * Xây dựng payload deviceSync để gửi về VMS.
 * Tương đương _build_device_sync_payload() trong Python.
 */
function buildDeviceSyncPayload(devices) {
  return {
    gatewayId: config.GATEWAY_ID,
    gatewayIp: config.GATEWAY_PUBLIC_IP,
    updatedAt: new Date().toISOString(),
    devices: devices || [],
  };
}

/**
 * Gửi device sync về VMS trong background (không await).
 * Tương đương push_device_sync() + threading.Thread trong Python.
 * @param {Array} devices
 */
function pushDeviceSync(changedDevices = []) {
  // Thay vì chỉ gửi thiết bị thay đổi, ta gom TOÀN BỘ các thiết bị đang online
  // Điều này đảm bảo VMS Server có đủ danh sách để không bị hiểu lầm là snapshot thiếu.
  const allDevicesMap = new Map();
  
  // 1. Thêm toàn bộ các thiết bị đang online
  for (const [deviceId, info] of onlineDevices) {
    if (info.deviceContext) {
      allDevicesMap.set(deviceId, info.deviceContext);
    }
  }

  // 2. Override bằng các thiết bị vừa có thay đổi (vd timeout OFFLINE)
  for (const cam of changedDevices) {
    if (cam && cam.deviceId) {
      allDevicesMap.set(cam.deviceId, cam);
    }
  }

  const payload = buildDeviceSyncPayload(Array.from(allDevicesMap.values()));
  
  postToServer(config.SERVER_DEVICE_SYNC_PATH, payload, 'device/sync')
    .then(() => console.log(`[GW -> VMS] Đã đồng bộ trạng thái thiết bị (${allDevicesMap.size} devices)`))
    .catch(err => console.error(`[GW -> VMS] Lỗi đồng bộ:`, err.message));
}

// ============================================================
// DEVICE PRESENCE — Đăng ký thiết bị online
// Tương đương register_device_presence() trong Python
// ============================================================

/**
 * Cập nhật lastSeen và đảm bảo device tồn tại trong DB.
 * Nếu device xuất hiện lần đầu → gọi pushDeviceSync.
 * @param {string} deviceId
 * @param {object} paras - tham số từ heartbeat
 * @returns {object|null} deviceContext
 */
function registerDevicePresence(deviceId, paras = {}) {
  deviceId = (deviceId || '').trim();
  if (!deviceId) return null;

  const previousContext = db.getDeviceContext(deviceId);

  // Trích xuất telemetry từ paras
  const telemetry = {
    battery: paras.battery,
    longitude: paras.longitude,
    latitude: paras.latitude,
    wifiState: paras.wifiState,
    simState: paras.simState,
    bluetoothState: paras.bluetoothState,
    tfState: paras.tfState,
    tfCapacity: paras.tfCapacity,
    workState: paras.workState,
    workTime: paras.workTime
  };

  // Cập nhật DB với telemetry mới
  const deviceContext = db.updateDeviceTelemetry(deviceId, telemetry) || {};
  
  // Đảm bảo connectionStatus là ONLINE vì vừa nhận được bản tin từ thiết bị
  deviceContext.connectionStatus = 'ONLINE';

  onlineDevices.set(deviceId, {
    lastSeen: Date.now(),
    paras: paras || {},
    deviceContext: deviceContext,
  });

  // Nếu device chưa từng có trong DB (lần đầu xuất hiện) hoặc có thay đổi quan trọng -> sync về VMS
  if (previousContext === null || JSON.stringify(deviceContext) !== JSON.stringify(previousContext)) {
    pushDeviceSync([deviceContext]);
  }

  return deviceContext;
}

// ============================================================
// MONITOR DEVICE STATUSES — Watchdog timeout
// Tương đương monitor_device_statuses() + threading.Thread trong Python
// ============================================================

/**
 * Mỗi giây scan onlineDevices, xóa device không gửi heartbeat quá thời gian cho phép.
 * Dùng setInterval thay cho vòng while + time.sleep(1) của Python.
 */
function startDeviceMonitor() {
  const disconnectAfterMs = config.DEVICE_DISCONNECT_AFTER_SECONDS * 1000;

  setInterval(() => {
    const nowMs = Date.now();
    const changedDevices = [];

    for (const [deviceId, info] of onlineDevices) {
      const idleMs = nowMs - info.lastSeen;

      if (idleMs >= disconnectAfterMs) {
        db.deleteDevice(deviceId);
        onlineDevices.delete(deviceId);
        changedDevices.push({
          deviceId: deviceId,
          userId: null,
          fullname: null,
          connectionStatus: 'OFFLINE',
        });
        console.log(
          `[DEVICE] ${deviceId} bị xóa sau ${config.DEVICE_DISCONNECT_AFTER_SECONDS}s không có heartbeat`
        );
      }
    }

    if (changedDevices.length > 0) {
      pushDeviceSync(changedDevices);
    }
  }, 1000); // Chạy mỗi 1 giây
}

// ============================================================
// MQTT MESSAGE HANDLER
// Tương đương on_message() trong Python
// ============================================================

/**
 * Xử lý message MQTT nhận được.
 * Logic gốc giữ nguyên 100%, chỉ đổi cú pháp Python → JS.
 */
function handleMqttMessage(topic, rawPayload) {
  let payload;

  try {
    payload = JSON.parse(rawPayload.toString());
  } catch (err) {
    // Không parse được thành JSON, có thể là Raw String từ broker ($SYS)
    if (topic.startsWith('$SYS')) {
        const logMsg = rawPayload.toString();
        if (logMsg.toLowerCase().includes('connect') || logMsg.toLowerCase().includes('client') || logMsg.toLowerCase().includes('drop')) {
            console.log(`[BROKER SYS ALERT] ${topic}: ${logMsg}`);
        }
        return;
    }
    console.error(`[MQTT Error] Parse error tại topic ${topic}: ${err.message}`);
    return;
  }
  
  if (topic.startsWith('$SYS')) {
      // Đã parse nhưng vẫn là $SYS (hiếm nhưng có thể)
      console.log(`[BROKER SYS ALERT] ${topic}: ${JSON.stringify(payload)}`);
      return;
  }

  // ── 1. Command Response từ Camera ────────────────────────
  // Topic: /v1/devices/{GATEWAY_ID}/commandResponse
  if (topic.includes('commandResponse')) {
    const mid = payload.mid;

    if (mid) {
      pendingResponses.set(mid, payload);
      console.log(`[Gateway] Đã lưu response cho mid: ${mid}`);
      console.log(`[MQTT] Current Keys: [${[...pendingResponses.keys()].join(', ')}]`);

      // Gửi kết quả về VMS ngay lập tức qua webhook
      const serverPayload = {
        status: 'completed',
        mid: mid,
        gatewayId: config.GATEWAY_ID,
        response: payload,
      };
      postToServer(config.SERVER_RESPONSE_PATH, serverPayload, 'response')
        .catch(err => console.error(`[MQTT commandResponse] postToServer error: ${err.message}`));
    }

    // ── 2. Các thông điệp từ Camera (Telemetry, SOS, Event, Snapshot) ─
    // Tất cả đều được đẩy lên: /v1/bodycam/dev/{gatewayId}/{deviceId}/{messageType}
  } else if (topic.includes('/bodycam/dev/')) {
    const parts = topic.split('/');
    // Topic: /v1/bodycam/dev/{gatewayId}/{deviceId}/telemetry
    let deviceId = parts[parts.length - 2];

    // Fallback nếu topic không có thì mới chọc vào payload
    if (!deviceId || deviceId === 'dev' || deviceId === config.GATEWAY_ID) {
        deviceId = payload.deviceId || 'unknown';
    }

    // --- LOG DEBUG ---
    console.log(`\n[DEBUG MQTT RAW] Topic: ${topic}`);
    console.log(`[DEBUG MQTT RAW] Payload: ${rawPayload.toString()}`);
    // -----------------

    if (payload.serviceId === 'telemetryDataUpload') {
      if (deviceId !== 'unknown') {
        // console.log(`[MQTT -> GATEWAY] Heartbeat từ ${deviceId}`); // Tạm tắt log cũ
        registerDevicePresence(deviceId, payload.paras || {});
      }
    } else if (payload.serviceId === 'sosMessage') {
      console.log(`[SOS ALARM] Thiết bị ${deviceId} khẩn cấp!`);
      const serverPayload = {
        type: 'sos-alarm',
        eventName: 'SOS Alarm',
        deviceId: deviceId,
        gatewayId: config.GATEWAY_ID,
        eventTime: payload.eventTime,
        paras: payload.paras
      };
      postToServer('/api/vms/receive-data', serverPayload, 'sos-alarm').catch(err => console.error(err));
    } else if (payload.serviceId === 'eventMessage') {
      console.log(`[EVENT MESSAGE] Thiết bị ${deviceId} gửi event khẩn.`);
      const serverPayload = {
        type: 'event-message',
        eventName: 'Event Message',
        deviceId: deviceId,
        gatewayId: config.GATEWAY_ID,
        eventTime: payload.eventTime,
        paras: payload.paras || {}
      };
      postToServer('/api/vms/receive-data', serverPayload, 'event-message').catch(err => console.error(err));
    } else if (payload.serviceId === 'snapshotMessage') {
      console.log(`[MQTT -> GATEWAY] Snapshot từ ${deviceId} (Base64)`);
      const serverPayload = {
        type: 'device-snapshot',
        eventName: 'Snapshot Captured',
        deviceId: deviceId,
        gatewayId: config.GATEWAY_ID,
        eventTime: payload.eventTime,
        paras: payload.paras || {}
      };
      postToServer('/api/vms/receive-data', serverPayload, 'device-snapshot').catch(err => console.error(err));
    } else if (payload.serviceId === 'event') {
      console.log(`[MQTT -> GATEWAY] Event từ ${deviceId}: ${payload.eventName || 'System Event'}`);
      const serverPayload = {
        type: 'device-event',
        eventName: 'System Event',
        deviceId: deviceId,
        gatewayId: config.GATEWAY_ID,
        eventTime: payload.eventTime,
        paras: payload.paras || payload
      };
      postToServer('/api/vms/receive-data', serverPayload, 'device-event').catch(err => console.error(err));
    }
  }
}

// ============================================================
// CONNECT MQTT
// Tương đương connect_mqtt() trong Python
// mqtt.js tự động reconnect, không cần vòng while như Python
// ============================================================

/**
 * Kết nối tới MQTT Broker và subscribe các topic cần thiết.
 * mqtt.js tự động reconnect khi mất kết nối (dựa vào reconnectPeriod trong options).
 */
function connectMqtt() {
  const { GATEWAY_ID, MQTT_URL, MQTT_OPTIONS } = config;

  console.log(`[MQTT] Đang kết nối tới broker: ${MQTT_URL}`);
  mqttClient = mqtt.connect(MQTT_URL, MQTT_OPTIONS);

  // ── Sự kiện: Kết nối thành công ──────────────────────────
  mqttClient.on('connect', () => {
    mqttConnected = true;
    console.log('[MQTT] Connected to broker successfully');

    // Subscribe topics
    const topics = {
      [`/v1/devices/${GATEWAY_ID}/commandResponse`]: { qos: 1 },
      [`/v1/bodycam/dev/${GATEWAY_ID}/+/+`]: { qos: 1 },
      ['$SYS/broker/log/#']: { qos: 0 },
      ['$SYS/broker/clients/#']: { qos: 0 }
    };

    mqttClient.subscribe(topics, (err, granted = []) => {
      if (err) {
        console.error(`[MQTT] Subscribe error: ${err.message}`);
      } else {
        const grantedSummary = granted.map(item => `${item.topic}:${item.qos}`).join(', ');
        const rejectedTopics = granted.filter(item => item.qos === 128).map(item => item.topic);

        console.log(`[MQTT] Subscribe ACK: ${grantedSummary}`);
        if (rejectedTopics.length > 0) {
          console.error(`[MQTT] Broker từ chối subscribe các topic: ${rejectedTopics.join(', ')}`);
        }
      }
    });
  });

  // ── Sự kiện: Message nhận được ───────────────────────────
  mqttClient.on('message', (topic, message) => {
    console.log(`[MQTT] Received message | topic=${topic} | payload=${message.toString()}`);
    handleMqttMessage(topic, message);
  });

  // ── Sự kiện: Mất kết nối ─────────────────────────────────
  mqttClient.on('close', () => {
    mqttConnected = false;
    console.log('[MQTT] Disconnected from broker');
  });

  // ── Sự kiện: Lỗi kết nối ─────────────────────────────────
  mqttClient.on('error', (err) => {
    console.error(`[MQTT] Connection error: ${err.message}`);
    // mqtt.js tự động reconnect — không cần xử lý thủ công như Python
  });

  // ── Sự kiện: Đang reconnect ───────────────────────────────
  mqttClient.on('reconnect', () => {
    console.log('[MQTT] Đang thử kết nối lại broker...');
  });
}

// ============================================================
// PUBLISH COMMAND — Gửi lệnh xuống Camera
// Tương đương publish_command() trong Python
// ============================================================

/**
 * Publish lệnh xuống một Body Camera qua MQTT.
 * Topic: /v1/bodycam/dev/{GATEWAY_ID}/{deviceId}/command
 * @param {string} serviceId - tên lệnh, ví dụ: 'getDeviceTime'
 * @param {string} deviceId  - deviceId của camera
 * @param {object} paras     - tham số bổ sung (có thể rỗng)
 * @returns {object} { mid }
 * @throws Error nếu MQTT chưa kết nối hoặc publish thất bại
 */
function publishCommand(serviceId, deviceId, paras = {}) {
  if (!mqttClient || !mqttConnected) {
    throw new Error('MQTT client chưa kết nối broker');
  }

  const topic = `/v1/bodycam/dev/${config.GATEWAY_ID}/${deviceId}/command`;

  // Sinh mid duy nhất — giống format Python: CMD_{GW}_{timestamp_ms}
  const mid = `CMD_${config.GATEWAY_ID}_${Date.now()}`;

  // Format thời gian YYYYMMDDTHHMMSSZ — giống formatEventTime trong Node.js gốc
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const eventTime = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const data = {
    deviceId: deviceId,
    serviceId: serviceId,
    eventTime: eventTime,
    mid: mid,
    paras: paras,
  };

  // mqtt.js publish trả về void, lỗi được truyền qua callback
  mqttClient.publish(topic, JSON.stringify(data), { qos: 1 }, (err) => {
    if (err) {
      console.error(`[GATEWAY -> MQTT] Gửi lệnh THẤT BẠI: ${serviceId} → ${topic} | Lỗi: ${err.message}`);
    } else {
      console.log(`[GATEWAY -> MQTT] Đã bắn lệnh tới Camera: ${serviceId} | mid: ${mid} | topic: ${topic}`);
    }
  });

  // Trả về mid ngay lập tức để HTTP response trả về VMS
  // (publish là async nhưng mid đã có sẵn)
  return { mid };
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  connectMqtt,
  startDeviceMonitor,
  publishCommand,
  pushDeviceSync,
  registerDevicePresence,
  pendingResponses,
  onlineDevices,
};
