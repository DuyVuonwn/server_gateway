const { startGroupMix } = require('./src/services/groupAudioService');

const groupId = 'test_group';
const deviceIds = ['cam1'];
const options = { talkStream: 'talk_group_grp_1775632384767_aac', includeSelf: true, mediaHost: '127.0.0.1', audioBitrate: '128k', onlineSet: new Set(['cam1']), mirrorToTalk: true };

console.log('Starting mix...');
startGroupMix(groupId, deviceIds, options);

// Keep alive
setInterval(() => {}, 1000);
