/**
 * ============================================================
 * GATEWAY SERVER — databaseService.js
 * Port từ database_service.py (Python / sqlite3)
 * Dùng better-sqlite3 (synchronous API, phù hợp với logic gốc)
 * ============================================================
 */
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const config   = require('../config');

class GatewayDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath || config.GATEWAY_DB_PATH;
    // Khởi tạo DB ngay khi tạo instance, đảm bảo schema tồn tại
    this._init();
  }

  /**
   * Mở kết nối và trả về instance DB.
   * better-sqlite3 là synchronous nên không cần async/await.
   * Mỗi lần gọi mở một kết nối mới (giống pattern connect() của Python).
   */
  _open() {
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL'); // Tăng hiệu suất concurrent reads
    return db;
  }

  /**
   * Tạo bảng `device` nếu chưa tồn tại.
   * Tương đương _ensure_schema() trong Python.
   * Chỉ gọi một lần khi khởi động.
   */
  _init() {
    // Tạo thư mục chứa DB nếu chưa tồn tại (tránh lỗi "directory does not exist")
    const fs  = require('fs');
    const dir = require('path').dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[DB] Đã tạo thư mục: ${dir}`);
    }

    const db = this._open();
    db.exec(`
      CREATE TABLE IF NOT EXISTS device (
        id               TEXT PRIMARY KEY,
        user_in_use      TEXT,
        username_in_use  TEXT,
        fullname_in_use  TEXT,
        battery          INTEGER,
        longitude        REAL,
        latitude         REAL,
        wifi_state       INTEGER,
        sim_state        INTEGER,
        bluetooth_state  INTEGER,
        tf_state         INTEGER,
        tf_capacity      REAL,
        work_state       INTEGER,
        work_time        TEXT
      )
    `);

    // Di cư (Migration) cho các bảng đã tồn tại: thêm cột nếu chưa có
    const tableInfo = db.prepare('PRAGMA table_info(device)').all();
    const existingColumns = tableInfo.map(c => c.name);
    const newColumns = [
      ['battery', 'INTEGER'],
      ['longitude', 'REAL'],
      ['latitude', 'REAL'],
      ['wifi_state', 'INTEGER'],
      ['sim_state', 'INTEGER'],
      ['bluetooth_state', 'INTEGER'],
      ['tf_state', 'INTEGER'],
      ['tf_capacity', 'REAL'],
      ['work_state', 'INTEGER'],
      ['work_time', 'TEXT']
    ];

    for (const [col, type] of newColumns) {
      if (!existingColumns.includes(col)) {
        try {
          db.prepare(`ALTER TABLE device ADD COLUMN ${col} ${type}`).run();
          console.log(`[DB] Đã thêm cột mới: ${col}`);
        } catch (err) {
          console.error(`[DB] Lỗi khi thêm cột ${col}: ${err.message}`);
        }
      }
    }

    db.close();
    console.log(`[DB] Database sẵn sàng tại: ${this.dbPath}`);
  }


  /**
   * Xóa toàn bộ device khi gateway khởi động.
   * Tương đương clear_devices() trong Python.
   */
  clearDevices() {
    const db = this._open();
    db.prepare('DELETE FROM device').run();
    db.close();
  }

  /**
   * Đảm bảo device tồn tại trong DB (INSERT OR IGNORE).
   * Tương đương ensure_device_exists() trong Python.
   * @param {string} deviceId
   * @returns {object|null} deviceContext
   */
  ensureDeviceExists(deviceId) {
    deviceId = (deviceId || '').trim();
    if (!deviceId) return null;

    const db = this._open();
    db.prepare(`
      INSERT OR IGNORE INTO device (id, user_in_use, username_in_use, fullname_in_use)
      VALUES (?, NULL, NULL, NULL)
    `).run(deviceId);
    db.close();

    return this.getDeviceContext(deviceId);
  }

  /**
   * Ghi hoặc cập nhật thông tin user đang dùng thiết bị.
   * Tương đương upsert_device_session() trong Python.
   * @param {string} deviceId
   * @param {object} param1 - { userId, username, fullname }
   * @returns {object|null} deviceContext
   */
  upsertDeviceSession(deviceId, { userId = null, username = null, fullname = null } = {}) {
    deviceId = (deviceId || '').trim();
    if (!deviceId) return null;

    userId   = (userId   || '').trim() || null;
    username = (username || '').trim() || null;
    fullname = (fullname || '').trim() || null;

    const db = this._open();
    // Đảm bảo device tồn tại trước khi UPDATE
    db.prepare(`
      INSERT OR IGNORE INTO device (id, user_in_use, username_in_use, fullname_in_use)
      VALUES (?, NULL, NULL, NULL)
    `).run(deviceId);
    db.prepare(`
      UPDATE device
      SET user_in_use = ?, username_in_use = ?, fullname_in_use = ?
      WHERE id = ?
    `).run(userId, username, fullname, deviceId);
    db.close();

    return this.getDeviceContext(deviceId);
  }

  /**
   * Cập nhật thông tin telemetry của thiết bị.
   * @param {string} deviceId
   * @param {object} telemetry - object chứa các trường telemetry
   */
  updateDeviceTelemetry(deviceId, telemetry = {}) {
    deviceId = (deviceId || '').trim();
    if (!deviceId) return null;

    const db = this._open();
    // Đảm bảo device tồn tại
    db.prepare('INSERT OR IGNORE INTO device (id) VALUES (?)').run(deviceId);

    const fields = [];
    const values = [];

    const map = {
      battery: 'battery',
      longitude: 'longitude',
      latitude: 'latitude',
      wifiState: 'wifi_state',
      simState: 'sim_state',
      bluetoothState: 'bluetooth_state',
      tfState: 'tf_state',
      tfCapacity: 'tf_capacity',
      workState: 'work_state',
      workTime: 'work_time'
    };

    for (const [key, column] of Object.entries(map)) {
      if (telemetry[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(telemetry[key]);
      }
    }

    if (fields.length > 0) {
      values.push(deviceId);
      db.prepare(`UPDATE device SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    db.close();
    return this.getDeviceContext(deviceId);
  }

  /**
   * Xóa thông tin user khỏi device (logout).
   * Tương đương clear_device_user() trong Python.
   * @param {string} deviceId
   * @returns {object|null} deviceContext sau khi xóa, hoặc null nếu không tìm thấy
   */
  clearDeviceUser(deviceId) {
    deviceId = (deviceId || '').trim();
    if (!deviceId) return null;

    const db = this._open();
    const row = db.prepare('SELECT id FROM device WHERE id = ?').get(deviceId);
    if (!row) { db.close(); return null; }

    db.prepare(`
      UPDATE device
      SET user_in_use = NULL, username_in_use = NULL, fullname_in_use = NULL
      WHERE id = ?
    `).run(deviceId);
    db.close();

    return this.getDeviceContext(deviceId);
  }

  /**
   * Xóa một device khỏi DB (khi timeout).
   * Tương đương delete_device() trong Python.
   * @param {string} deviceId
   */
  deleteDevice(deviceId) {
    deviceId = (deviceId || '').trim();
    if (!deviceId) return;

    const db = this._open();
    db.prepare('DELETE FROM device WHERE id = ?').run(deviceId);
    db.close();
  }

  /**
   * Lấy danh sách tất cả device trong DB.
   * Tương đương list_devices() trong Python.
   * @returns {Array} mảng deviceContext
   */
  listDevices() {
    const db = this._open();
    const rows = db.prepare(`
      SELECT *
      FROM device ORDER BY id
    `).all();
    db.close();

    return rows.map(row => ({
      deviceId:         row.id,
      userId:           row.user_in_use,
      username:         row.username_in_use,
      fullname:         row.fullname_in_use,
      battery:          row.battery,
      longitude:        row.longitude,
      latitude:         row.latitude,
      wifiState:        row.wifi_state,
      simState:         row.sim_state,
      bluetoothState:   row.bluetooth_state,
      tfState:          row.tf_state,
      tfCapacity:       row.tf_capacity,
      workState:        row.work_state,
      workTime:         row.work_time,
      // Status ONLINE khi có người dùng, OFFLINE khi logout (NULL)
      connectionStatus: row.user_in_use ? 'ONLINE' : 'OFFLINE',
    }));
  }

  /**
   * Lấy thông tin context của một device.
   * Tương đương get_device_context() trong Python.
   * @param {string} deviceId
   * @returns {object|null}
   */
  getDeviceContext(deviceId) {
    deviceId = (deviceId || '').trim();
    if (!deviceId) return null;

    const db = this._open();
    const row = db.prepare(`
      SELECT * FROM device WHERE id = ?
    `).get(deviceId);
    db.close();

    if (!row) return null;

    return {
      deviceId:         row.id,
      // Status ONLINE khi có người dùng, OFFLINE khi logout
      connectionStatus: row.user_in_use ? 'ONLINE' : 'OFFLINE',
      userId:           row.user_in_use,
      username:         row.username_in_use,
      fullname:         row.fullname_in_use,
      battery:          row.battery,
      longitude:        row.longitude,
      latitude:         row.latitude,
      wifiState:        row.wifi_state,
      simState:         row.sim_state,
      bluetoothState:   row.bluetooth_state,
      tfState:          row.tf_state,
      tfCapacity:       row.tf_capacity,
      workState:        row.work_state,
      workTime:         row.work_time,
    };
  }
}

// Singleton instance — dùng chung toàn bộ ứng dụng
const dbService = new GatewayDatabase();
module.exports = dbService;
