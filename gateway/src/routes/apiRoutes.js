/**
 * ============================================================
 * GATEWAY SERVER — apiRoutes.js
 * ============================================================
 */
'use strict';

const express = require('express');
const router = express.Router();
const apiController = require('../controllers/apiController');

router.post('/command', apiController.sendCommand);
router.post('/device/activate', apiController.activateDevice);
router.post('/user/create', apiController.createUser);
router.post('/user/login', apiController.loginUser);
router.post('/user/logout', apiController.logoutUser);

router.get('/devices', apiController.getDevices);

router.post('/group-audio/mix', apiController.groupAudioMix);
router.post('/group-audio/stop', apiController.groupAudioStop);
router.get('/group-audio/status', apiController.groupAudioStatus);

module.exports = router;
