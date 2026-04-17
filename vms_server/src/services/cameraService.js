const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

let vmsCore;
try {
  vmsCore = require('../../build/Release/vms_core.node');
} catch (err) {
  logger.error("Lỗi: Không thể load C++ Addon. Hãy chạy 'npx node-gyp rebuild'.", err);
  process.exit(1);
}

const DB_FILE = path.join(__dirname, '../../data/cameras.json');

function getCameras() {
  try {
    const jsonStr = vmsCore.readCamerasFile(DB_FILE);
    return JSON.parse(jsonStr || '[]');
  } catch (err) {
    logger.error("Lỗi đọc DB từ C++: " + err.message);
    return [];
  }
}

function saveCameras(camsArray) {
  try {
    vmsCore.writeCamerasFile(DB_FILE, JSON.stringify(camsArray, null, 2));
  } catch (err) {
    logger.error("Lỗi ghi DB từ C++: " + err.message);
  }
}

function resetCamerasOfflineOnBoot() {
  const cams = getCameras();
  if (!Array.isArray(cams) || cams.length === 0) return;

  let changed = false;
  cams.forEach(cam => {
    if (cam.connectionStatus !== 'OFFLINE' || cam.gatewayId) {
      cam.connectionStatus = 'OFFLINE';
      cam.gatewayId = null;
      cam.onlineSince = null;
      changed = true;
    }
  });

  if (changed) {
    saveCameras(cams);
    logger.info('[VMS] Khởi động: đặt tất cả camera về OFFLINE cho đến khi có sync từ Gateway');
  }
}

function updateCameraCoordinates(deviceId, paras = {}) {
  if (!deviceId) return false;

  const latitude = Number(paras.latitude);
  const longitude = Number(paras.longitude);
  const hasValidCoordinates = Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && !(latitude === 0 && longitude === 0);

  if (!hasValidCoordinates) return false;

  const cameras = getCameras();
  const cam = cameras.find(c => c.deviceId === deviceId);
  if (!cam) return false;

  const changed = cam.latitude !== latitude || cam.longitude !== longitude;

  if (!changed) return false;

  cam.latitude = latitude;
  cam.longitude = longitude;
  saveCameras(cameras);
  logger.info(`[VMS] Đã cập nhật GPS cho camera ${deviceId}: lat=${cam.latitude}, lng=${cam.longitude}`);
  return true;
}

function syncDevicesLogic(gatewayIp, incomingDevices) {
  let cameras = getCameras();
  let oldStatusArr = {};
  cameras.forEach(c => oldStatusArr[c.deviceId] = c.connectionStatus);

  const result = vmsCore.processSyncLogic(cameras, gatewayIp, incomingDevices);

  if (result && result.changed) {
    cameras.forEach(c => {
       if (oldStatusArr[c.deviceId] !== 'ONLINE' && c.connectionStatus === 'ONLINE') {
          c.onlineSince = Date.now();
       } else if (c.connectionStatus === 'OFFLINE') {
          c.onlineSince = null;
       }
    });

    saveCameras(cameras);
    logger.info(`[VMS] Đã đồng bộ Device Status vào cameras.json (Bởi C++ module). Changed devices count: ${incomingDevices.length}`);
    return true;
  } else {
    logger.info(`[VMS] Sync xong nhưng không có thay đổi gì trong DB. Devices received: ${incomingDevices.length}`);
    return false;
  }
}

module.exports = {
  getCameras,
  saveCameras,
  resetCamerasOfflineOnBoot,
  updateCameraCoordinates,
  syncDevicesLogic
};
