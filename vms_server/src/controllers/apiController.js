const logger = require('../utils/logger');
const sseService = require('../services/sseService');
const cameraService = require('../services/cameraService');
const snapshotService = require('../services/snapshotService');

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || 'http://localhost:3001';
const GATEWAY_URL = `${GATEWAY_BASE_URL}/api/command`;

async function getHistoricalEvents(req, res) {
  const events = snapshotService.loadEventsFromSnapshots();
  res.json({ success: true, events });
}

function streamLogs(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: {"type": "connected", "message": "SSE connected"}\n\n`);
  sseService.addClient(res);
  req.on('close', () => sseService.removeClient(res));
}

function getCameras(req, res) {
  const mediaServerIp = process.env.MEDIA_SERVER_IP || '10.10.50.253';
  const cameras = cameraService.getCameras().map(c => ({
    ...c,
    streamUrl: `http://${mediaServerIp}:8889/live/${c.deviceId}_opus`
  }));
  res.json({ success: true, cameras });
}

async function addCamera(req, res) {
  const { id, name, deviceId } = req.body;
  if (!id || !name || !deviceId) return res.status(400).json({ success: false, message: 'Thiếu thông tin' });

  try {
    const fetch = global.fetch;
    const response = await fetch(`${GATEWAY_BASE_URL}/api/devices`);
    if (!response.ok) {
      return res.status(502).json({ success: false, message: `Lỗi từ Gateway: ${response.statusText}` });
    }
    const data = await response.json();
    const found = (data.devices || []).find(d => d.deviceId === deviceId);
    if (!found) {
      return res.status(404).json({ success: false, message: "DeviceID không tồn tại trên Gateway" });
    }
  } catch (e) {
    return res.status(503).json({ success: false, message: "Gateway không phản hồi. Bắt buộc Gateway phải chạy để thêm Camera." });
  }

  const cameras = cameraService.getCameras();
  if (cameras.find(c => c.id === id)) return res.status(409).json({ success: false, message: 'Duplicate ID' });

  const mediaServerIp = process.env.MEDIA_SERVER_IP || '10.10.50.253';
  const streamUrl = `http://${mediaServerIp}:8889/live/${deviceId}_opus`;
  const newCam = { id, name, deviceId, streamUrl, connectionStatus: 'OFFLINE', createdAt: new Date().toISOString() };
  cameras.push(newCam);
  cameraService.saveCameras(cameras);
  res.status(201).json({ success: true, camera: newCam });
}

function deleteCamera(req, res) {
  const { id } = req.params;
  const cameras = cameraService.getCameras();
  const updated = cameras.filter(c => c.id !== id);
  if (cameras.length === updated.length) return res.status(404).json({ success: false });
  cameraService.saveCameras(updated);
  res.json({ success: true });
}

async function sendCommand(req, res) {
  const { deviceId, serviceId, paras = {} } = req.body;
  logger.info(`[UI -> VMS] Nhận lệnh từ UI: deviceId=${deviceId}, serviceId=${serviceId}`);

  if (serviceId === 'startLiveAction' || serviceId === 'stopLiveAction') {
    const cameras = cameraService.getCameras();
    const cam = cameras.find(c => c.deviceId === deviceId);
    if (cam) {
      cam.isStreaming = (serviceId === 'startLiveAction');
      cameraService.saveCameras(cameras);
      sseService.broadcast({ type: 'stream-status', deviceId, isStreaming: cam.isStreaming });
    }
  }

  try {
    const fetch = global.fetch;
    logger.info(`[VMS -> GATEWAY] Đang chuyển tiếp lệnh tới Gateway: ${GATEWAY_URL}`);
    const response = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, serviceId, paras })
    });
    const text = await response.text();
    logger.info(`[GATEWAY -> VMS] Gateway phản hồi: status=${response.status}, body=${text}`);
    res.json({ success: true, gatewayStatus: response.status, gatewayResponse: text });
  } catch (err) {
    logger.error(`[VMS -> GATEWAY] Lỗi khi chuyển tiếp lệnh: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

async function groupAudioMix(req, res) {
  const { groupId, deviceIds = [], includeOffline = true, includeSelf = false, talkStream = null, mediaHost = null, audioBitrate = undefined, mirrorToTalk = true } = req.body || {};
  if (!groupId || !Array.isArray(deviceIds)) {
    return res.status(400).json({ success: false, message: 'Missing groupId or deviceIds' });
  }
  try {
    const fetch = global.fetch;
    const response = await fetch(`${GATEWAY_BASE_URL}/api/group-audio/mix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, deviceIds, includeOffline, includeSelf, talkStream, mediaHost, audioBitrate, mirrorToTalk })
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    logger.error('[VMS] group-audio/mix error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

function receiveData(req, res) {
  const payload = req.body || {};
  const receivedAt = new Date().toISOString();
  logger.info(`[GATEWAY -> VMS] Nhận dữ liệu (receive-data): type=${payload.type}, deviceId=${payload.deviceId}`);

  if ((payload.type === 'device-snapshot' || payload.type === 'sos-alarm' || payload.type === 'event-message') && payload.paras?.image) {
    payload.paras.eventType = payload.type;
    const snapshotPath = snapshotService.persistIncomingImage(payload.deviceId, payload);
    if (snapshotPath) payload.snapshotPath = snapshotPath;
  }

  cameraService.updateCameraCoordinates(payload.deviceId, payload.paras);

  const eventPayload = { type: 'gateway-data', receivedAt, data: payload };
  sseService.broadcast(eventPayload);
  res.json({ success: true });
}

function receiveCommandResponse(req, res) {
  logger.info(`[GATEWAY -> VMS] Nhận Command Response: mid=${req.body.mid}`);
  const eventPayload = { type: 'command-response', receivedAt: new Date().toISOString(), ...req.body };
  sseService.broadcast(eventPayload);
  res.json({ success: true });
}

function deviceSync(req, res) {
  try {
    const payload = req.body;
    const gatewayIp = payload.gatewayIp;
    const incomingDevices = payload.devices || [];
    logger.info(`[GATEWAY -> VMS] Nhận Device Sync: gatewayIp=${gatewayIp}, devices=${incomingDevices.length}`);

    cameraService.syncDevicesLogic(gatewayIp, incomingDevices);

    sseService.broadcast({ type: 'device-sync', ...payload });
    res.json({ success: true });
  } catch (err) {
    logger.error(`[VMS] Lỗi trong sync: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = {
  getHistoricalEvents,
  streamLogs,
  getCameras,
  addCamera,
  deleteCamera,
  sendCommand,
  groupAudioMix,
  receiveData,
  receiveCommandResponse,
  deviceSync
};
