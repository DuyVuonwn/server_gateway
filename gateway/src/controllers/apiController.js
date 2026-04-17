/**
 * ============================================================
 * GATEWAY SERVER — apiController.js
 * ============================================================
 */
'use strict';

const config = require('../config');
const db = require('../services/databaseService');
const { startGroupMix, stopGroupMix, statusGroupMixes } = require('../services/groupAudioService');
const {
  publishCommand,
  pushDeviceSync,
  registerDevicePresence,
  pendingResponses,
  onlineDevices,
} = require('../services/mqttService');

const simpleResponse = (ok, code) => ({
  status: ok ? 'success' : 'error',
  code,
});

const commandResponse = (ok, code, mid = null) => ({
  status: ok ? 'success' : 'error',
  code,
  mid,
});

function sendCommand(req, res) {
  const payload = req.body || {};
  const deviceId = (payload.deviceId || '').trim();
  const serviceId = (payload.serviceId || '').trim();
  const paras = payload.paras || {};
  if (!deviceId || !serviceId) {
    return res.json(commandResponse(false, 201));
  }
  console.log(`[VMS -> API] Nhận lệnh từ VMS: deviceId=${deviceId}, serviceId=${serviceId}`);
  try {
    const result = publishCommand(serviceId, deviceId, paras);
    console.log(`[API -> VMS] Trả về mid: ${result.mid}`);
    return res.json(commandResponse(true, 200, result.mid));
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('MQTT client chưa kết nối broker')) {
      return res.json(commandResponse(false, 202));
    }
    return res.json(commandResponse(false, 299));
  }
}

function activateDevice(req, res) {
  const deviceId = ((req.body || {}).deviceId || '').trim();
  if (!deviceId) return res.json(simpleResponse(false, 299));
  console.log(`[API] Nhận yêu cầu KÍCH HOẠT (activate) từ thiết bị: ${deviceId}`);
  
  registerDevicePresence(deviceId);
  return res.json(simpleResponse(true, 200));
}

function createUser(_req, res) {
  return res.json(simpleResponse(false, 299));
}

function loginUser(req, res) {
  const payload = req.body || {};
  const deviceId = (payload.deviceId || '').trim();
  const userId = (payload.uId || payload.uid || '').trim();
  const fullname = (payload.fullname || '').trim();

  console.log(`[API] Nhận yêu cầu ĐĂNG NHẬP (login): Device=${deviceId}, User=${userId}, Name=${fullname}`);

  if (!deviceId || !userId || !fullname) {
    console.log(`[API] Đăng nhập thất bại: Thiếu thông tin`);
    return res.json(simpleResponse(false, 299));
  }

  const deviceContext = db.upsertDeviceSession(deviceId, { userId, fullname });
  if (!deviceContext) {
    console.log(`[API] Đăng nhập thất bại: Lỗi DB`);
    return res.json(simpleResponse(false, 299));
  }

  console.log(`[API] Đăng nhập thành công -> Sync lên VMS`);
  registerDevicePresence(deviceId);
  pushDeviceSync([deviceContext]);
  return res.json(simpleResponse(true, 200));
}

function logoutUser(req, res) {
  const deviceId = ((req.body || {}).deviceId || '').trim();

  console.log(`[API] Nhận yêu cầu ĐĂNG XUẤT (logout) từ thiết bị: ${deviceId}`);

  const deviceContext = db.clearDeviceUser(deviceId);

  if (!deviceContext) {
    console.log(`[API] Đăng xuất thất bại: Không tìm thấy device ${deviceId}`);
    return res.json(simpleResponse(false, 299));
  }

  console.log(`[API] Đăng xuất thành công -> Sync lên VMS`);
  pushDeviceSync([deviceContext]);
  return res.json(simpleResponse(true, 200));
}

function buildDeviceInventory() {
  const nowMs = Date.now();
  const merged = new Map();
  const toDelete = [];

  db.listDevices().forEach(dev => {
    const userLabel = dev.userId ? `${dev.userId} - ${dev.fullname || 'Unknown'}` : 'Unknown';
    merged.set(dev.deviceId, {
      deviceId: dev.deviceId,
      connectionStatus: dev.connectionStatus || 'OFFLINE',
      lastSeen: null,
      area: 'Unknown',
      user: userLabel,
      userId: dev.userId,
      username: dev.username,
      fullname: dev.fullname,
      deviceStatus: dev.userId ? 'in_use' : 'pending_login',
      battery: dev.battery,
      longitude: dev.longitude,
      latitude: dev.latitude,
      wifiState: dev.wifiState,
      simState: dev.simState,
      bluetoothState: dev.bluetoothState,
      tfState: dev.tfState,
      tfCapacity: dev.tfCapacity,
      workState: dev.workState,
      workTime: dev.workTime,
    });
  });

  for (const [deviceId, info] of onlineDevices) {
    const idleMs = nowMs - info.lastSeen;
    if (idleMs >= 60000) {
      toDelete.push(deviceId);
      continue;
    }

    const ctx = info.deviceContext || {};
    const userId = ctx.userId || null;
    const fullname = ctx.fullname || null;
    const userLabel = userId ? `${userId} - ${fullname || 'Unknown'}` : 'Unknown';
    const base = merged.get(deviceId) || { deviceId };

    merged.set(deviceId, {
      ...base,
      deviceId,
      connectionStatus: 'ONLINE',
      status: 'Online',
      lastSeen: new Date(info.lastSeen).toISOString(),
      area: 'Unknown',
      user: userLabel,
      userId: userId ?? base.userId,
      username: ctx.username ?? base.username,
      fullname: fullname ?? base.fullname,
      deviceStatus: userId ? 'in_use' : 'pending_login',
      battery: ctx.battery ?? base.battery,
      longitude: ctx.longitude ?? base.longitude,
      latitude: ctx.latitude ?? base.latitude,
      wifiState: ctx.wifiState ?? base.wifiState,
      simState: ctx.simState ?? base.simState,
      bluetoothState: ctx.bluetoothState ?? base.bluetoothState,
      tfState: ctx.tfState ?? base.tfState,
      tfCapacity: ctx.tfCapacity ?? base.tfCapacity,
      workState: ctx.workState ?? base.workState,
      workTime: ctx.workTime ?? base.workTime,
    });
  }

  toDelete.forEach(id => onlineDevices.delete(id));
  return Array.from(merged.values());
}

function getDevices(_req, res) {
  const devices = buildDeviceInventory();
  return res.json({
    status: 'success',
    gatewayId: config.GATEWAY_ID,
    devices,
  });
}

function groupAudioMix(req, res) {
  try {
    const { groupId, deviceIds, talkStream = null, includeSelf = false, mediaHost = null, audioBitrate, includeOffline = true, mirrorToTalk = true } = req.body || {};
    if (!groupId || !Array.isArray(deviceIds) || deviceIds.length === 0) {
      return res.status(400).json({ status: 'error', message: 'groupId and deviceIds required' });
    }
    // Inputs should come from online devices; outputs still created for all targets (includeOffline handled in service).
    const onlineSet = new Set(Array.from(onlineDevices.keys()));
    const result = startGroupMix(groupId, deviceIds, { talkStream, includeSelf, mediaHost, audioBitrate, onlineSet, mirrorToTalk });
    return res.json({ status: 'success', ...result });
  } catch (err) {
    console.error('[GroupMix] start error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
}

function groupAudioStop(req, res) {
  const { groupId } = req.body || {};
  if (!groupId) return res.status(400).json({ status: 'error', message: 'groupId required' });
  const stopped = stopGroupMix(groupId);
  return res.json({ status: stopped ? 'success' : 'error', stopped });
}

function groupAudioStatus(_req, res) {
  return res.json({ status: 'success', mixes: statusGroupMixes() });
}

module.exports = {
  sendCommand,
  activateDevice,
  createUser,
  loginUser,
  logoutUser,
  getDevices,
  groupAudioMix,
  groupAudioStop,
  groupAudioStatus
};
