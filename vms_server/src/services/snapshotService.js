const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { parseEventTimestampMs, sanitizeName, buildEventName, getImageExtension } = require('../utils/helpers');

const MAX_HISTORY = 500;
const SNAPSHOT_DIR = path.join(__dirname, '../../data/snapshots');

if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function loadEventsFromSnapshots() {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR);
    const events = [];

    files.forEach(file => {
      const parts = file.split('__');
      if (parts.length < 3) return;
      const tsStr = parts.shift();
      const deviceIdRaw = parts.shift();
      const rest = parts.join('__');
      const dotIdx = rest.lastIndexOf('.');
      if (dotIdx === -1) return;
      const eventTypeRaw = rest.slice(0, dotIdx);
      const ext = rest.slice(dotIdx + 1);
      const ts = Number(tsStr);
      if (!Number.isFinite(ts)) return;

      const deviceId = deviceIdRaw;
      const eventType = eventTypeRaw;
      const iso = new Date(ts).toISOString();
      const snapshotPath = `/snapshots/${file}`;

      events.push({
        type: 'gateway-data',
        receivedAt: iso,
        data: {
          type: eventType,
          eventName: buildEventName(eventType),
          deviceId,
          gatewayId: null,
          eventTime: iso,
          paras: {
            format: ext,
            timestamp: tsStr
          },
          snapshotPath
        }
      });
    });

    return events
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
      .slice(0, MAX_HISTORY);
  } catch (err) {
    logger.error(`[VMS] Lỗi đọc lịch sử từ snapshot: ${err.message}`);
    return [];
  }
}

function persistIncomingImage(deviceId, payload = {}) {
  const paras = payload.paras || {};
  if (!deviceId || !paras.image) return null;

  try {
    const eventType = sanitizeName(payload.type || paras.eventType || paras.type || 'event');
    const tsMs = parseEventTimestampMs(payload);
    const safeDeviceId = sanitizeName(deviceId);

    const buffer = Buffer.from(paras.image, 'base64');
    const ext = getImageExtension(paras.format);
    const fileName = `${tsMs}__${safeDeviceId}__${eventType}.${ext}`;
    const filePath = path.join(SNAPSHOT_DIR, fileName);

    fs.writeFileSync(filePath, buffer);
    delete paras.image;

    logger.info(`[VMS] Đã lưu ảnh event từ Gateway vào: ${filePath}`);
    return `/snapshots/${fileName}`;
  } catch (err) {
    logger.error(`[VMS] Lỗi khi save base64 image: ${err.message}`);
    return null;
  }
}

module.exports = {
  loadEventsFromSnapshots,
  persistIncomingImage
};
