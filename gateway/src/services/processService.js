/**
 * ============================================================
 * GATEWAY SERVER — processService.js
 * (MediaMTX Automation Logic)
 * ============================================================
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

let mediaMtxProcess = null;

function startMediaMTX() {
  const exePath = path.join(__dirname, '../../mediamtx');
  const workingDir = path.join(__dirname, '../..');

  console.log(`[*] Đang khởi chạy MediaMTX: ${exePath}`);

  mediaMtxProcess = spawn(exePath, [], {
    cwd: workingDir,
    stdio: 'inherit',
  });

  mediaMtxProcess.on('error', (err) => {
    console.error(`[!] Lỗi khi chạy MediaMTX: ${err.message}`);
  });

  mediaMtxProcess.on('exit', (code, signal) => {
    console.log(`[!] MediaMTX đã thoát với mã: ${code}, signal: ${signal}`);
  });
}

function stopMediaMTX() {
  if (mediaMtxProcess) {
    console.log('[*] Đang dừng MediaMTX...');
    mediaMtxProcess.kill();
  }
}

module.exports = {
  startMediaMTX,
  stopMediaMTX
};
