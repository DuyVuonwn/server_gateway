const vmsCore = require('./build/Release/vms_core');

const cameras = [
  { deviceId: 'A', connectionStatus: 'ONLINE', gatewayId: '192.168.1.1' }, // Realistic
  { deviceId: 'B', connectionStatus: 'OFFLINE' }
];

const incoming = [
  { deviceId: 'B', connectionStatus: 'ONLINE' }
];

const res = vmsCore.processSyncLogic(cameras, '192.168.1.1', incoming);
console.log(JSON.stringify(cameras, null, 2));
