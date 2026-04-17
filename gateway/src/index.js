/**
 * ============================================================
 * GATEWAY SERVER — src/index.js  (Entrypoint)
 * ============================================================
 */
'use strict';

require('./config/index'); // ensures dotenv loads first if needed
const express = require('express');
const config  = require('./config');
const db      = require('./services/databaseService');
const {
  connectMqtt,
  startDeviceMonitor,
  pushDeviceSync,
} = require('./services/mqttService');
const { startMediaMTX } = require('./services/processService');
const apiRouter = require('./routes/apiRoutes');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/api', apiRouter);

app.listen(config.HTTP_PORT, '0.0.0.0', () => {
  console.log('================================================');
  console.log(`[*] Gateway HTTP API chạy tại http://0.0.0.0:${config.HTTP_PORT}`);
  console.log(`[*] Gateway ID: ${config.GATEWAY_ID}`);
  console.log(`[*] MQTT Broker: ${config.MQTT_URL}`);
  console.log(`[*] VMS Server: ${config.SERVER_API_BASE_URL}`);
  console.log('================================================');

  startMediaMTX();

  db.clearDevices();
  console.log('[*] Device table đã được xóa khi gateway khởi động');

  startDeviceMonitor();
  connectMqtt();
  pushDeviceSync([]);
  console.log('[*] Gateway MQTT Client đang khởi tạo...');
});

function shutdown() {
  console.log('\n[*] Gateway đang tắt...');
  require('./services/processService').stopMediaMTX();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
