'use strict';

const { spawn } = require('child_process');
const config = require('../config');

// groupId -> { targets: Map<targetId, { process, inputUrls, outputUrl, args }>, deviceIds, startedAt, host, options, restarting }
const groupMixes = new Map();

function buildRtmpUrl(host, app, stream) {
  return `rtmp://${host}/${app}/${stream}`;
}

function buildRtspUrl(host, app, stream) {
  if (!app) return `rtsp://${host}:8554/${stream}`;
  return `rtsp://${host}:8554/${app}/${stream}`;
}

function startGroupMix(groupId, deviceIds = [], options = {}) {
  if (!groupId) throw new Error('groupId required');
  if (!Array.isArray(deviceIds) || deviceIds.length === 0) throw new Error('deviceIds required');

  const host = options.mediaHost || config.MEDIA_HOST || config.GATEWAY_PUBLIC_IP || '127.0.0.1';
  const app = options.app || 'live';
  const talkStream = options.talkStream; // optional, e.g. 'vms_talk'
  const includeSelf = Boolean(options.includeSelf);
  const audioBitrate = options.audioBitrate || '128k';
  const allowedSet = options.onlineSet instanceof Set ? options.onlineSet : null;
  const mirrorToTalk = Boolean(options.mirrorToTalk); // also publish to talk_<id>_aac

  // Tear down existing mix for this group, if any (rare; not per-PTT).
  stopGroupMix(groupId);

  const targets = new Map();
  const filteredTargets = deviceIds; // always create outputs for all targets

  filteredTargets.forEach((targetId) => {
    // Inputs: only online cams (if allowedSet provided) plus optional talk stream
    // Inputs: only online cams if allowedSet provided; outputs still created for all targets
    const sourceList = allowedSet ? deviceIds.filter(id => allowedSet.has(id)) : deviceIds;
    let inputs = sourceList.filter(id => includeSelf ? true : id !== targetId);
    if (talkStream) inputs.push(talkStream);

    // talk_* streams publish at rtsp://host:8554/talk_* (no /live prefix)
    const inputUrls = inputs.map(id => {
      if (id.startsWith('talk_')) {
        return buildRtspUrl('127.0.0.1', null, id);
      }
      return buildRtspUrl('127.0.0.1', app, id);
    });
    const outputLive = buildRtmpUrl('127.0.0.1', app, `${targetId}_aac`);
    const outputTalk = mirrorToTalk ? buildRtmpUrl('127.0.0.1', app, `talk_${targetId}_aac`) : null;

    const ffArgs = [
      '-hide_banner', '-loglevel', 'warning',
    ];
    inputUrls.forEach(url => { ffArgs.push('-rtsp_transport', 'tcp', '-i', url); });

    // If no inputs (all offline and no talk), keep path alive with silent source
    const useSilence = inputUrls.length === 0;
    if (useSilence) {
      ffArgs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=48000');
    }

    const totalInputs = inputUrls.length + (useSilence ? 1 : 0);
    const padList = Array.from({ length: totalInputs }, (_v, idx) => `[${idx}:a]`).join('');
    const amix = `${padList}amix=inputs=${totalInputs}:dropout_transition=2,volume=1.0`;

    ffArgs.push('-filter_complex', amix, '-vn', '-c:a', 'aac', '-b:a', audioBitrate);

    if (outputTalk) {
      // tee to live and talk
      const teeSpec = `[f=flv]${outputLive}|[f=flv]${outputTalk}`;
      ffArgs.push('-f', 'tee', teeSpec);
    } else {
      ffArgs.push('-f', 'flv', outputLive);
    }

    const hadInputs = inputUrls.length > 0;

    const child = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    targets.set(targetId, { process: child, inputUrls, outputLive, outputTalk, args: ffArgs, hadInputs });
    child.on('exit', (code, signal) => {
      console.log(`[GroupMix] group=${groupId} target=${targetId} exited code=${code} signal=${signal}`);

      const current = groupMixes.get(groupId);
      const attempt = options.retryAttempt || 0;
      const MAX_RETRIES = 15;
      const shouldRetry = code !== 0 && attempt < MAX_RETRIES;

      if (shouldRetry && current && !current.restarting) {
        current.restarting = true;
        const delay = 2000; // Fixed 2-second delay between retries
        console.log(`[GroupMix] group=${groupId} scheduling retry #${attempt + 1}/${MAX_RETRIES} in ${delay}ms (likely missing WebRTC talk_group stream)`);
        setTimeout(() => {
          startGroupMix(groupId, deviceIds, { ...options, retryAttempt: attempt + 1 });
        }, delay);
      } else if (code !== 0 && attempt >= MAX_RETRIES - 1) {
        // Final fallback: publish silence so paths exist for VLC/cameras even if inputs never appeared.
        console.log(`[GroupMix] group=${groupId} target=${targetId} starting silent fallback after ${MAX_RETRIES} failed attempts`);
        const silentArgs = [
          '-hide_banner', '-loglevel', 'warning',
          '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=48000',
          '-vn', '-c:a', 'aac', '-b:a', audioBitrate,
        ];
        if (outputTalk) {
          const teeSpec = `[f=flv]${outputLive}|[f=flv]${outputTalk}`;
          silentArgs.push('-f', 'tee', teeSpec);
        } else {
          silentArgs.push('-f', 'flv', outputLive);
        }
        spawn('ffmpeg', silentArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
      }
    });
  });

  groupMixes.set(groupId, { targets, deviceIds: filteredTargets, startedAt: Date.now(), host, options, restarting: false });
  return {
    groupId,
    targets: Array.from(targets.keys()),
    host,
    app,
    filteredOut: deviceIds.filter(id => !(filteredTargets.includes(id))),
  };
}

function stopGroupMix(groupId) {
  const mix = groupMixes.get(groupId);
  if (!mix) return false;
  mix.targets.forEach(({ process }, targetId) => {
    try { process.kill('SIGTERM'); } catch (e) { }
    console.log(`[GroupMix] stopped target=${targetId} group=${groupId}`);
  });
  groupMixes.delete(groupId);
  return true;
}

function stopAllGroupMixes() {
  Array.from(groupMixes.keys()).forEach(stopGroupMix);
}

function statusGroupMixes() {
  return Array.from(groupMixes.entries()).map(([groupId, mix]) => ({
    groupId,
    host: mix.host,
    targets: Array.from(mix.targets.keys()),
    deviceIds: mix.deviceIds,
    startedAt: mix.startedAt,
  }));
}

module.exports = {
  startGroupMix,
  stopGroupMix,
  stopAllGroupMixes,
  statusGroupMixes,
};
