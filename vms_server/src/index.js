const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const logger = require('./utils/logger');
const cameraService = require('./services/cameraService');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 6060;
const SNAPSHOT_DIR = path.join(__dirname, '../data/snapshots');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// Phục vụ giao diện Frontend
app.use(express.static(path.join(__dirname, '../public')));

// Phục vụ file map PMTiles qua route static. Ở Frontend đang sử dụng 'pmtiles://map.pmtiles'
app.use('/map.pmtiles', express.static(path.join(__dirname, '../data/pmtiles')));

// Phục vụ ảnh snapshot
app.use('/snapshots', express.static(SNAPSHOT_DIR));

// Setup Routes
app.use('/api', apiRoutes);

// Khởi chạy xử lý camera offline
cameraService.resetCamerasOfflineOnBoot();

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`VMS Server (Node + C++) started on port ${PORT}`);
});
