/**
 * ============================================================
 * GATEWAY SERVER — config/index.js
 * (Refactored configuration file)
 * Đọc biến môi trường từ .env và export object config
 * ============================================================
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { randomBytes } = require('crypto');

const config = {
  // ── Chung ────────────────────────────────────────────────
  GATEWAY_ID:   process.env.GATEWAY_ID    || 'GW001',
  HTTP_PORT:    parseInt(process.env.HTTP_PORT || '3000', 10),
  LOG_LEVEL:    process.env.LOG_LEVEL     || 'info',

  // ── MQTT ─────────────────────────────────────────────────
  MQTT_URL:      process.env.MQTT_BROKER_URL || 'mqtt://localhost',
  MQTT_USERNAME: process.env.MQTT_USERNAME   || null,
  MQTT_PASSWORD: process.env.MQTT_PASSWORD   || null,

  // ── VMS Server (Webhook callback) ────────────────────────
  SERVER_API_BASE_URL:        (process.env.SERVER_API_BASE_URL || 'http://localhost:5001').replace(/\/$/, ''),
  SERVER_RESPONSE_PATH:       process.env.SERVER_RESPONSE_PATH       || '/api/response',
  SERVER_DEVICE_SYNC_PATH:    process.env.SERVER_DEVICE_SYNC_PATH    || '/api/device/sync',
  SERVER_DEVICE_SNAPSHOT_PATH: process.env.SERVER_DEVICE_SNAPSHOT_PATH || '/api/device/snapshot',
  SERVER_API_TIMEOUT:         parseInt(process.env.SERVER_API_TIMEOUT || '5000', 10),
  SERVER_SNAPSHOT_TIMEOUT:    parseInt(
    process.env.SERVER_SNAPSHOT_TIMEOUT
      || process.env.SERVER_API_TIMEOUT
      || '15000',
    10
  ),

  // ── Database ──────────────────────────────────────────────
  GATEWAY_DB_PATH:            process.env.GATEWAY_DB_PATH
    || require('path').join(__dirname, '../../data/gateway_db.db'),

  GATEWAY_PUBLIC_IP:          process.env.GATEWAY_PUBLIC_IP || '127.0.0.1',
  MEDIA_HOST:                 process.env.MEDIA_HOST || process.env.GATEWAY_PUBLIC_IP || '127.0.0.1',

  // Thời gian (giây) không có heartbeat thì coi device là offline
  DEVICE_DISCONNECT_AFTER_SECONDS: parseInt(
    process.env.DEVICE_DISCONNECT_AFTER_SECONDS || '60', 10
  ),

  // ── MQTT Client Options ───────────────────────────────────
  get MQTT_OPTIONS() {
    return {
      clientId:      `Gateway_Bridge_${randomBytes(4).toString('hex')}`,
      username:      this.MQTT_USERNAME || undefined,
      password:      this.MQTT_PASSWORD || undefined,
      keepalive:     60,
      reconnectPeriod: 5000,
      connectTimeout:  30000,
      clean: true,
    };
  },
};

module.exports = config;
