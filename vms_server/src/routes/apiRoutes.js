const express = require('express');
const router = express.Router();
const apiController = require('../controllers/apiController');

router.get('/events', apiController.getHistoricalEvents);
router.get('/stream-logs', apiController.streamLogs);
router.get('/cameras', apiController.getCameras);
router.post('/cameras', apiController.addCamera);
router.delete('/cameras/:id', apiController.deleteCamera);

router.post('/ui/send-command', apiController.sendCommand);
router.post('/ui/group-audio/mix', apiController.groupAudioMix);

router.post('/vms/receive-data', apiController.receiveData);
router.post('/response', apiController.receiveCommandResponse);
router.post('/device/sync', apiController.deviceSync);

module.exports = router;
