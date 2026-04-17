let cameras = [];
let selectedCameraId = null;
const deviceEvents = {}; // Dictionary to store events per deviceId

let viewMode = 'single'; // 'single', 'grid2x2', 'grid3x3'
let gridCameras = Array(9).fill(null);

let currentGridGroupId = null;
let currentGridPage = 0;

// DOM
const cameraListEl = document.getElementById('camera-list');
const cameraPanelEl = document.getElementById('camera-inventory');
const cameraContextMenu = document.getElementById('camera-context-menu');
const groupContextMenu = document.getElementById('group-context-menu');
const totalCamerasBadge = document.getElementById('total-cameras-badge');
const ctrlDeviceId = document.getElementById('ctrl-device-id');
const webrtcVideo = document.getElementById('webrtc-video');
const videoTitle = document.getElementById('video-title');
const videoSubtitle = document.getElementById('video-subtitle');
const noVideoPlaceholder = document.getElementById('no-video-placeholder');
const videoOverlayInfo = document.getElementById('video-overlay-info');
const eventFeedList = document.getElementById('event-feed-list');
const timelineEl = document.getElementById('global-timeline');
const timelineMarkersEl = document.getElementById('timeline-markers');
const timelineTicksEl = document.getElementById('timeline-event-ticks');
const timelineDateInput = document.getElementById('timeline-date');
const mapViewContainer = document.getElementById('map-view-container');
const videoRecordingBadge = document.getElementById('video-recording-badge');

const HANOI_CENTER = [21.0285, 105.8542];
const HANOI_DEFAULT_ZOOM = 16;
const OFFLINE_MAP_SOURCE = "pmtiles://map.pmtiles";

const TIMELINE_DAY_MINUTES = 24 * 60;
const TIMELINE_ZOOM_LEVELS = [1440, 720, 360, 180, 120, 60, 30, 15];
const timelineState = {
  zoomIndex: 0,
  startMinute: 0
};
const timelineEvents = [];
const allGlobalEvents = [];
const knownGlobalEventKeys = new Set();
const eventFilterState = {
  selectedDate: getLocalDateInputValue(new Date())
};
let cameraMap = null;
let cameraMarkers = [];
// WebRTC playback sessions mapped by deviceId (or custom key)
// { pc, tracks, url, stream }
const webrtcSessions = new Map();

async function startWhepPlayback(videoEl, streamUrl, sessionKey = null) {
  if (!videoEl || !streamUrl) return;
  const key = sessionKey || videoEl.id;

  // Reuse existing session: just attach stream to video
  const current = webrtcSessions.get(key);
  if (current && current.url === streamUrl && current.stream) {
    videoEl.srcObject = current.stream;
    videoEl.muted = false;
    videoEl.volume = 1;
    videoEl.classList.remove('hidden');
    return;
  }

  stopWhepPlayback(key);

  const pc = new RTCPeerConnection();
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log(`[WHEP] ${key} ice=${pc.iceConnectionState}`);
  });
  pc.addEventListener('connectionstatechange', () => {
    console.log(`[WHEP] ${key} conn=${pc.connectionState}`);
    if (pc.connectionState === 'failed') {
      showToast('WebRTC failed to connect (ICE failed)', true);
    }
  });
  const tracks = [];
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  let sessionStream = null;
  pc.addEventListener('track', (ev) => {
    tracks.push(ev.track);
    sessionStream = ev.streams[0] || new MediaStream([ev.track]);
    webrtcSessions.set(key, { pc, tracks, url: streamUrl, stream: sessionStream });
    videoEl.srcObject = sessionStream;
    videoEl.muted = false;
    videoEl.volume = 1;
    videoEl.classList.remove('hidden');
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  const whepUrl = buildWhepUrl(streamUrl);
  const res = await fetch(whepUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp
  });
  if (!res.ok) {
    const msg = `WHEP ${res.status}`;
    console.warn('[WHEP] fetch failed', msg);
    throw new Error(msg);
  }

  const answerSdp = await res.text();
  await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));

  // If track event hasn't fired yet, store session for later attachment
  if (!webrtcSessions.has(key)) {
    webrtcSessions.set(key, { pc, tracks, url: streamUrl, stream: sessionStream });
  }
}

function stopWhepPlayback(sessionKey) {
  const sess = webrtcSessions.get(sessionKey);
  if (sess) {
    try {
      sess.tracks?.forEach(t => t.stop());
      sess.pc?.close();
    } catch (e) { }
    webrtcSessions.delete(sessionKey);
  }
  const hidden = document.getElementById(`hidden-video-${sessionKey}`);
  if (hidden) hidden.srcObject = null;
}

function buildWhepUrl(streamUrl) {
  try {
    const u = new URL(streamUrl);
    return `${u.origin}${u.pathname.replace(/\/?$/, '')}/whep`;
  } catch (e) {
    return `${streamUrl.replace(/\/?$/, '')}/whep`;
  }
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, 2000);
  });
}

function buildWhepUrl(streamUrl) {
  try {
    const u = new URL(streamUrl);
    // MediaMTX WHEP pattern: /live/<path>/whep
    return `${u.origin}${u.pathname.replace(/\/?$/, '')}/whep`;
  } catch (e) {
    return `${streamUrl.replace(/\/?$/, '')}/whep`;
  }
}

function waitForIceGatheringComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    }, 2000);
  });
}

// Setup SSE
const sseIndicator = document.getElementById('sse-indicator');
const sseStatusText = document.getElementById('sse-status-text');

function initSSE() {
  const source = new EventSource('/api/stream-logs');
  source.onopen = () => {
    sseIndicator.classList.remove('bg-error'); sseIndicator.classList.add('bg-primary');
    sseStatusText.textContent = "System Online"; sseStatusText.classList.remove('text-error'); sseStatusText.classList.add('text-primary');
  };
  source.onerror = () => {
    sseIndicator.classList.remove('bg-primary'); sseIndicator.classList.add('bg-error');
    sseStatusText.textContent = "Offline (Reconnecting)"; sseStatusText.classList.remove('text-primary'); sseStatusText.classList.add('text-error');
  };
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'device-sync' || data.type === 'command-response' || data.type === 'gateway-data') {
        syncCameraStateFromGatewayEvent(data);
        focusCameraFromSosEvent(data);
        renderEventFeed(data);
        if (data.type === 'device-sync') {
          fetchCameras(); // Reload devices for online/offline status update
        }
      }
      if (data.type === 'stream-status') {
        const cam = cameras.find(c => c.deviceId === data.deviceId);
        if (cam) cam.isStreaming = data.isStreaming;
        if (selectedCameraId && selectedCameraId === cam?.id && viewMode === 'single') updateVideoUI(cam);
        if (viewMode === 'grid2x2' || viewMode === 'grid3x3') renderGrid();
        renderCameraList(); // re-render list if we want to show icons there later
      }
    } catch (err) { }
  };
}

function syncCameraStateFromGatewayEvent(data) {
  if (data.type !== 'gateway-data') return;

  const payload = data.data || {};
  const paras = payload.paras || {};
  const cam = cameras.find(item => item.deviceId === payload.deviceId);
  if (!cam) return;

  const latitude = Number(paras.latitude);
  const longitude = Number(paras.longitude);
  const hasValidCoordinates = Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && !(latitude === 0 && longitude === 0);

  if (!hasValidCoordinates) return;

  const changed = cam.latitude !== latitude || cam.longitude !== longitude;

  if (!changed) return;

  cam.latitude = latitude;
  cam.longitude = longitude;
  renderCameraList();
  renderMapMarkers();

  if (selectedCameraId === cam.id && viewMode === 'single') {
    updateVideoUI(cam);
  }

  if (viewMode === 'grid2x2' || viewMode === 'grid3x3') {
    renderGrid();
  }
}

function focusCameraFromSosEvent(data, allowRefresh = true) {
  if (data.type !== 'gateway-data' || data.data?.type !== 'sos-alarm') return;

  const deviceId = data.data?.deviceId;
  if (!deviceId) return;

  const cam = cameras.find(item => item.deviceId === deviceId);
  if (!cam) {
    if (!allowRefresh) return;
    fetchCameras()
      .then(() => focusCameraFromSosEvent(data, false))
      .catch(() => { });
    return;
  }

  if (selectedCameraId !== cam.id) {
    selectCamera(cam.id);
  } else {
    ctrlDeviceId.value = cam.deviceId;
    videoTitle.textContent = cam.name;
    updateVideoUI(cam);
    renderCameraList();
  }

  if (viewMode !== 'single') {
    setViewMode('single');
  }
}

function getGatewayEventTimestamp(data) {
  const paras = data.data?.paras || {};
  return paras.timestamp || paras.time || data.data?.eventTime || data.receivedAt;
}

function getLocalDateInputValue(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function getHiddenVideo(deviceId) {
  const id = `hidden-video-${deviceId}`;
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement('video');
  el.id = id;
  el.autoplay = true;
  el.playsInline = true;
  el.style.position = 'absolute';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);
  return el;
}

async function ensureHiddenWhepSession(deviceId, streamUrl) {
  const hiddenEl = getHiddenVideo(deviceId);
  await startWhepPlayback(hiddenEl, streamUrl, deviceId);
  return webrtcSessions.get(deviceId);
}

function parseEventDateValue(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'string') {
    const compactUtc = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (compactUtc) {
      const [, year, month, day, hour, minute, second] = compactUtc;
      // Trả về giờ địa phương (không dùng UTC) vì Camera gửi giờ VN nhưng đính Z
      return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      );
    }
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getEventReferenceDate(data) {
  return parseEventDateValue(getGatewayEventTimestamp(data))
    || parseEventDateValue(data.receivedAt)
    || new Date();
}

function matchesSelectedTimelineDate(data) {
  return getLocalDateInputValue(getEventReferenceDate(data)) === eventFilterState.selectedDate;
}

function buildGlobalEventKey(data) {
  const payload = data.data || {};
  return [
    data.type || '',
    data.receivedAt || '',
    payload.type || '',
    payload.deviceId || '',
    payload.eventName || '',
    payload.snapshotPath || '',
    getGatewayEventTimestamp(data) || ''
  ].join('|');
}

function clearDeviceEventCache() {
  Object.keys(deviceEvents).forEach(key => delete deviceEvents[key]);
}

function resetGlobalEventState() {
  allGlobalEvents.length = 0;
  knownGlobalEventKeys.clear();
  clearDeviceEventCache();
}

function registerGlobalEvent(data) {
  if (!shouldRenderGlobalEvent(data)) return false;

  const eventKey = buildGlobalEventKey(data);
  if (knownGlobalEventKeys.has(eventKey)) return false;

  knownGlobalEventKeys.add(eventKey);
  allGlobalEvents.push(data);

  const devId = data.data?.deviceId;
  if (devId) {
    if (!deviceEvents[devId]) deviceEvents[devId] = [];
    deviceEvents[devId].push(data);
  }

  return true;
}

function rerenderGlobalEventViews() {
  eventFeedList.innerHTML = '';
  timelineEvents.length = 0;
  renderTimeline();

  allGlobalEvents
    .filter(matchesSelectedTimelineDate)
    .sort((a, b) => getEventReferenceDate(b).getTime() - getEventReferenceDate(a).getTime())
    .forEach(ev => renderEventItem(ev, true));
}

function applyTimelineDateSelection(value) {
  eventFilterState.selectedDate = value || getLocalDateInputValue(new Date());
  timelineState.zoomIndex = 0;
  timelineState.startMinute = 0;
  rerenderGlobalEventViews();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimelineMinute(totalMinutes, isEndLabel = false) {
  const safeMinutes = Math.max(0, Math.min(TIMELINE_DAY_MINUTES, Math.round(totalMinutes)));
  if (safeMinutes >= TIMELINE_DAY_MINUTES) {
    return isEndLabel ? '24:00' : '23:59';
  }

  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}

function getTimelineWindowMinutes() {
  return TIMELINE_ZOOM_LEVELS[timelineState.zoomIndex];
}

function clampTimelineStart(startMinute, windowMinutes = getTimelineWindowMinutes()) {
  return Math.max(0, Math.min(TIMELINE_DAY_MINUTES - windowMinutes, startMinute));
}

function getTimelineEventMinute(timestamp) {
  const eventDate = new Date(timestamp);
  return (eventDate.getHours() * 60) + eventDate.getMinutes() + (eventDate.getSeconds() / 60);
}

function renderTimelineMarkers() {
  if (!timelineMarkersEl) return;

  const windowMinutes = getTimelineWindowMinutes();
  const startMinute = timelineState.startMinute;
  const stepCount = 4;
  const labels = [];

  for (let i = 0; i <= stepCount; i++) {
    const minuteValue = startMinute + ((windowMinutes / stepCount) * i);
    labels.push(formatTimelineMinute(minuteValue, i === stepCount));
  }

  timelineMarkersEl.innerHTML = labels
    .map(label => `<span class="text-[10px] font-bold text-on-surface-variant">${label}</span>`)
    .join('');
}

function renderTimelineTicks() {
  if (!timelineTicksEl) return;

  const windowMinutes = getTimelineWindowMinutes();
  const startMinute = timelineState.startMinute;
  const endMinute = startMinute + windowMinutes;

  timelineTicksEl.innerHTML = '';

  timelineEvents.forEach(event => {
    if (event.minuteOfDay < startMinute || event.minuteOfDay > endMinute) return;

    const relativePos = ((event.minuteOfDay - startMinute) / windowMinutes) * 100;
    const leftPos = Math.max(0.5, Math.min(99.5, relativePos));

    let colorClass = 'bg-primary/60';
    let height = 'h-4';

    if (event.type === 'live') {
      colorClass = 'bg-error shadow-lg shadow-error/50';
      height = 'h-8';
    } else if (event.type === 'sos') {
      colorClass = 'bg-error shadow-lg shadow-error/50';
      height = 'h-8';
    } else if (event.type === 'snapshot') {
      colorClass = 'bg-green-500';
      height = 'h-6';
    } else if (event.type === 'event-message') {
      colorClass = 'bg-amber-400 shadow-lg';
      height = 'h-8';
    } else if (event.type === 'stop') {
      colorClass = 'bg-error shadow-lg shadow-error/50';
      height = 'h-8';
    }

    const tickHtml = `
      <div class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-10 group cursor-pointer flex items-center justify-center" style="left: ${leftPos}%">
        <div class="${height} w-[2px] ${colorClass} transition-all duration-200 rounded-full"></div>
        <div class="hidden group-hover:block absolute bottom-full mb-2 left-1/2 -translate-x-1/2 px-2 py-1 bg-surface-container-high text-on-surface text-[10px] font-medium rounded shadow-lg whitespace-nowrap z-20 border border-outline-variant pointer-events-none">
          ${event.tooltipText}
        </div>
      </div>
    `;

    timelineTicksEl.insertAdjacentHTML('beforeend', tickHtml);
  });
}

function renderTimeline() {
  if (!timelineMarkersEl || !timelineTicksEl) return;

  if (timelineEvents.length === 0) {
    timelineTicksEl.innerHTML = '';
    timelineMarkersEl.classList.add('hidden');
    return;
  }

  timelineMarkersEl.classList.remove('hidden');
  renderTimelineMarkers();
  renderTimelineTicks();
}

function zoomTimeline(deltaY, pointerClientX) {
  if (!timelineEl) return;

  const direction = deltaY < 0 ? 1 : -1;
  const nextZoomIndex = Math.max(0, Math.min(TIMELINE_ZOOM_LEVELS.length - 1, timelineState.zoomIndex + direction));
  if (nextZoomIndex === timelineState.zoomIndex) return;

  const rect = timelineEl.getBoundingClientRect();
  const pointerRatio = rect.width > 0 ? Math.max(0, Math.min(1, (pointerClientX - rect.left) / rect.width)) : 0.5;
  const currentWindow = getTimelineWindowMinutes();
  const hoveredMinute = timelineState.startMinute + (pointerRatio * currentWindow);

  timelineState.zoomIndex = nextZoomIndex;
  const nextWindow = getTimelineWindowMinutes();
  const anchoredStart = hoveredMinute - (pointerRatio * nextWindow);
  timelineState.startMinute = clampTimelineStart(anchoredStart, nextWindow);

  renderTimeline();
}

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `px-4 py-3 rounded-lg text-white text-sm font-semibold shadow-xl transition-all ${isError ? 'bg-error' : 'bg-primary'}`;
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// Ticking Uptime Counter
setInterval(() => {
  document.querySelectorAll('.uptime-ticker').forEach(el => {
    const sinceStr = el.getAttribute('data-since');
    if (!sinceStr) return;
    const since = parseInt(sinceStr, 10);
    if (isNaN(since)) return;
    const diffSecs = Math.floor((Date.now() - since) / 1000);
    if (diffSecs >= 0) {
      const h = String(Math.floor(diffSecs / 3600)).padStart(2, '0');
      const m = String(Math.floor((diffSecs % 3600) / 60)).padStart(2, '0');
      const s = String(diffSecs % 60).padStart(2, '0');
      el.textContent = `${h}h:${m}m:${s}s`;
    }
  });
}, 1000);

// Fetch cameras
async function fetchCameras() {
  try {
    const res = await fetch('/api/cameras');
    const data = await res.json();
    if (data.success) {
      cameras = data.cameras;
      // Clean up groups for missing devices
      const validIds = new Set(cameras.map(c => c.deviceId));
      cameraGroups = cameraGroups.map(g => ({ ...g, deviceIds: g.deviceIds.filter(d => validIds.has(d)) }));
      saveGroupsToStorage();
      renderCameraList();
      renderMapMarkers();
      if (selectedCameraId) {
        const cam = cameras.find(c => c.id === selectedCameraId);
        if (cam) updateVideoUI(cam);
      }
      if (viewMode === 'map' && cameraMap) {
        requestAnimationFrame(() => cameraMap.resize());
      }
    }
  } catch (err) {
    showToast("Error connecting to server", true);
  }
}

// Fetch historical events from Server Memory (Resolves Reset on Reload)
async function fetchHistoricalEvents() {
  try {
    const res = await fetch('/api/events');
    const data = await res.json();
    if (data.success && data.events) {
      resetGlobalEventState();
      data.events.forEach(ev => registerGlobalEvent(ev));
      rerenderGlobalEventViews();
    }
  } catch (e) {
    console.warn("Could not fetch historical events:", e);
  }
}

function shouldRenderGlobalEvent(data) {
  if (data.type !== 'gateway-data') return false;
  const gatewayType = data.data?.type;
  return ['device-event', 'device-snapshot', 'sos-alarm', 'event-message'].includes(gatewayType);
}

function hasValidCoordinates(cam) {
  const lat = Number(cam.latitude);
  const lng = Number(cam.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
}

function ensureMapInitialized() {
  if (cameraMap || !mapViewContainer || typeof maplibregl === 'undefined') return;
  if (typeof pmtiles === 'undefined') {
    console.warn('[map] pmtiles library missing; map view disabled');
    showToast('Offline map library missing. Restore pmtiles.js or stay online.', true);
    return;
  }

  // --- BƯỚC QUAN TRỌNG: Đăng ký giao thức PMTiles ---
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);

  cameraMap = new maplibregl.Map({
    container: 'camera-map',
    // Cấu hình Style Offline thủ công
    style: {
      version: 8,
      sources: {
        "openmaptiles": {
          type: "vector",
          url: OFFLINE_MAP_SOURCE,
          attribution: '© OpenStreetMap'
        }
      },
      layers: [
        {
          "id": "background",
          "type": "background",
          "paint": { "background-color": "#f0f4f9" } // Màu nền bản đồ
        },
        {
          "id": "water",
          "type": "fill",
          "source": "openmaptiles",
          "source-layer": "water",
          "paint": { "fill-color": "#d8e2ff" } // Màu sông hồ
        },
        {
          "id": "roads",
          "type": "line",
          "source": "openmaptiles",
          "source-layer": "transportation",
          "paint": {
            "line-color": "#ffffff",
            "line-width": 2
          }
        },
        {
          "id": "buildings",
          "type": "fill",
          "source": "openmaptiles",
          "source-layer": "building",
          "paint": { "fill-color": "#e1e8f0" } // Màu nhà cửa
        },
        {
          "id": "poi-labels",
          "type": "symbol",
          "source": "openmaptiles",
          "source-layer": "poi",
          "layout": {
            "text-field": "{name}",
            "text-font": ["Inter"],
            "text-size": 11
          },
          "paint": { "text-color": "#43474e" }
        }
      ]
    },
    center: [HANOI_CENTER[1], HANOI_CENTER[0]], // MapLibre dùng [Lng, Lat]
    zoom: HANOI_DEFAULT_ZOOM
  });

  cameraMap.addControl(new maplibregl.NavigationControl(), 'top-right');

  cameraMap.on('load', () => {
    console.log("Map Offline Loaded!");
    if (typeof renderMapMarkers === 'function') renderMapMarkers();
  });
}

function buildCameraPopup(cam) {
  const statusColor = cam.connectionStatus === 'ONLINE' ? '#16a34a' : '#6b7280';
  const battery = cam.battery ?? '--';
  const lat = Number(cam.latitude).toFixed(5);
  const lng = Number(cam.longitude).toFixed(5);
  return `
    <div style="min-width: 220px;">
      <div style="font-weight: 700; font-size: 13px; margin-bottom: 6px;">${cam.name || cam.deviceId}</div>
      <div style="font-size: 12px; color: #4b5563; line-height: 1.5;">
        <div><strong>ID:</strong> ${cam.deviceId}</div>
        <div><strong>Status:</strong> <span style="color: ${statusColor}; font-weight: 700;">${cam.connectionStatus}</span></div>
        <div><strong>Last Seen Location:</strong> ${lat}, ${lng}</div>
        <div><strong>Battery:</strong> ${battery}%</div>
      </div>
      <button
        style="width:100%; margin-top:10px; background:#0f766e; color:#fff; padding:8px 10px; border-radius:10px; border:none; font-weight:600; cursor:pointer;"
        onclick="window.selectCameraByDeviceId && window.selectCameraByDeviceId('${cam.deviceId}')"
      >Xem live</button>
    </div>
  `;
}

// Helper được popup gọi để nhảy sang chế độ xem live
window.selectCameraByDeviceId = function (deviceId) {
  const cam = cameras.find(c => c.deviceId === deviceId);
  if (!cam) return;
  selectCamera(cam.id);
  setViewMode('single');
};

function renderMapMarkers() {
  ensureMapInitialized();
  if (!cameraMap) return;

  cameraMarkers.forEach(marker => marker.remove());
  cameraMarkers = [];

  cameras
    .filter(hasValidCoordinates)
    .forEach(cam => {
      const isOnline = cam.connectionStatus === 'ONLINE';
      const lngLat = [Number(cam.longitude), Number(cam.latitude)];
      const popup = new maplibregl.Popup({
        offset: 18,
        closeButton: false,
        closeOnClick: false
      }).setHTML(buildCameraPopup(cam));
      const marker = new maplibregl.Marker({
        color: isOnline ? '#14b8a6' : '#9ca3af',
        scale: isOnline ? 0.95 : 0.85
      })
        .setLngLat(lngLat)
        .addTo(cameraMap);

      const markerEl = marker.getElement();
      markerEl.style.cursor = 'pointer';
      markerEl.addEventListener('mouseenter', () => popup.setLngLat(lngLat).addTo(cameraMap));
      markerEl.addEventListener('mouseleave', () => popup.remove());
      markerEl.addEventListener('click', () => {
        // Focus vào camera khi click và đảm bảo zoom đúng mức mong muốn
        cameraMap.easeTo({ center: lngLat, zoom: HANOI_DEFAULT_ZOOM, duration: 600 });
        popup.setLngLat(lngLat).addTo(cameraMap);
      });

      cameraMarkers.push(marker);
    });
}

function resetMapView() {
  ensureMapInitialized();
  if (!cameraMap) return;

  renderMapMarkers();
  cameraMap.jumpTo({
    center: [HANOI_CENTER[1], HANOI_CENTER[0]],
    zoom: HANOI_DEFAULT_ZOOM
  });
  requestAnimationFrame(() => cameraMap.resize());
}

// Render cameras in the left panel
function renderCameraList() {
  cameraListEl.innerHTML = '';
  totalCamerasBadge.textContent = `${cameras.length} TOTAL`;

  const groupedIds = new Set(cameraGroups.flatMap(g => g.deviceIds));

  const createCameraCard = (cam) => {
    const isOnline = cam.connectionStatus === 'ONLINE';
    const isSelected = selectedCameraId === cam.id;

    const bgClass = isSelected ? 'bg-primary/5 border-primary border-2' : (isOnline ? 'bg-white border-surface-container-high border' : 'bg-white/60 border-surface-container-high border opacity-70');
    const textTheme = isSelected ? 'text-primary' : 'text-on-surface';
    const fillSettings = isSelected ? "'FILL' 1" : "'FILL' 0";

    const item = document.createElement('div');
    item.className = `p-4 rounded-xl shadow-sm cursor-pointer mb-2 transition-colors camera-card ${bgClass}`;
    item.draggable = true;
    item.ondragstart = (e) => {
      e.dataTransfer.setData('text/plain', cam.deviceId);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('opacity-50');
    };
    item.ondragend = () => item.classList.remove('opacity-50');
    item.onclick = (e) => { if (!e.target.closest('.delete-btn')) selectCamera(cam.id); };

    const wifiIcon = (isOnline && cam.wifiState > 0) ? 'wifi' : 'wifi_off';
    const wifiColor = (isOnline && cam.wifiState > 0) ? 'text-primary' : 'text-outline';
    const btColor = (isOnline && cam.bluetoothState > 0) ? 'text-primary' : 'text-outline';
    const wifiFill = (isOnline && cam.wifiState > 0) ? "'FILL' 1" : "'FILL' 0";
    const btFill = (isOnline && cam.bluetoothState > 0) ? "'FILL' 1" : "'FILL' 0";
    const locationStr = (cam.latitude && cam.longitude) ? `${cam.latitude.toFixed(4)}, ${cam.longitude.toFixed(4)}` : 'Unknown Sector';

    const battery = cam.battery ?? 0;
    const batteryIcon = battery > 80 ? 'battery_full' : (battery > 50 ? 'battery_5_bar' : (battery > 20 ? 'battery_2_bar' : 'battery_low'));
    const batteryColor = isOnline ? (battery > 20 ? 'text-primary' : 'text-error') : 'text-outline';
    const userStr = cam.fullname || cam.userId || 'No User';

    let workTimeStr = '--';
    let dataSinceAttr = '';
    if (isOnline && cam.onlineSince) {
      dataSinceAttr = `data-since="${cam.onlineSince}"`;
      const diffSecs = Math.floor((Date.now() - cam.onlineSince) / 1000);
      if (diffSecs >= 0) {
        const h = String(Math.floor(diffSecs / 3600)).padStart(2, '0');
        const m = String(Math.floor((diffSecs % 3600) / 60)).padStart(2, '0');
        const s = String(diffSecs % 60).padStart(2, '0');
        workTimeStr = `${h}h:${m}m:${s}s`;
      }
    }

    item.innerHTML = `
      <div class="flex flex-col gap-1.5 w-full">
        <div class="flex justify-between items-center w-full mb-1">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]' : 'bg-outline'} shrink-0"></div>
            <span class="text-[13px] font-bold ${textTheme} leading-none truncate max-w-[140px]" title="${cam.name}">${cam.name}</span>
          </div>
          <div class="flex items-center gap-1.5 leading-none shrink-0" style="font-variation-settings: ${fillSettings};">
            <span class="material-symbols-outlined ${btColor}" style="font-variation-settings: ${btFill}; font-size: 15px;">bluetooth</span>
            <span class="material-symbols-outlined ${wifiColor}" style="font-variation-settings: ${wifiFill}; font-size: 15px;">${wifiIcon}</span>
            <div class="flex items-center gap-1">
              <span class="material-symbols-outlined text-[15px] ${batteryColor}">${batteryIcon}</span>
              <span class="text-[11px] font-semibold ${batteryColor} leading-none">${battery}%</span>
            </div>
          </div>
        </div>
        <div class="flex justify-between items-end w-full">
          <div class="flex flex-col text-[10px] text-on-surface-variant opacity-85 space-y-[3px] ml-4">
            <div class="font-mono flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[11px] opacity-70">badge</span>
              <span class="font-medium text-on-surface w-6">ID:</span>
              <span>${cam.deviceId}</span>
            </div>
            <div class="font-mono flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[11px] opacity-70">person</span>
              <span class="font-medium text-on-surface w-6">User:</span>
              <span class="font-semibold text-[9px] text-primary bg-primary/10 px-1 py-[1px] rounded uppercase max-w-[120px] truncate" title="${userStr}">${userStr}</span>
            </div>
            <div class="font-mono flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[11px] opacity-70">schedule</span>
              <span class="font-medium text-on-surface w-6">Up:</span>
              <span class="text-on-surface uptime-ticker" ${dataSinceAttr}>${workTimeStr}</span>
            </div>
            <div class="font-mono flex items-center gap-1.5 truncate max-w-[180px]" title="${locationStr}">
              <span class="material-symbols-outlined text-[11px] opacity-70">location_on</span>
              <span class="font-medium text-on-surface w-6">Loc:</span>
              <span>${locationStr}</span>
            </div>
          </div>
          <button class="delete-btn material-symbols-outlined text-error bg-error/5 hover:bg-error/20 p-1.5 rounded-lg opacity-60 hover:opacity-100 text-[16px] transition-all shrink-0 mb-0.5 ml-2" title="Delete Device">delete</button>
        </div>
      </div>
    `;
    item.querySelector('.delete-btn').onclick = () => removeCamera(cam.id);
    return item;
  };

  // Render groups as tree
  cameraGroups.forEach(group => {
    const isExpanded = group.isExpanded !== false; // Default true
    const row = document.createElement('div');
    row.className = 'rounded-lg border border-surface-container-high bg-white shadow-sm mb-2 overflow-hidden';
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between px-3 py-2 hover:bg-surface-container-high transition-colors select-none';
    header.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="btn-toggle-expand material-symbols-outlined text-[18px] text-on-surface-variant cursor-pointer hover:bg-surface-container hover:text-primary rounded-full transition-all duration-200 ${isExpanded ? 'rotate-90' : ''}">chevron_right</span>
        <span class="material-symbols-outlined text-[16px] text-primary pointer-events-none">folder</span>
        <span class="btn-group-name font-semibold text-on-surface truncate cursor-pointer hover:text-primary transition-colors pointer-events-auto" title="Click to View Grid">${group.name}</span>
      </div>
      <span class="text-[10px] text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full pointer-events-none">${group.deviceIds.length} cams</span>
    `;
    const body = document.createElement('div');
    body.className = `pl-5 pr-3 pb-2 pt-1 flex-col gap-1 ${isExpanded ? 'flex' : 'hidden'}`;

    const toggleBtn = header.querySelector('.btn-toggle-expand');
    toggleBtn.onclick = (e) => {
      e.stopPropagation();
      if (e.button === 2) return;
      group.isExpanded = !isExpanded;
      saveGroupsToStorage();
      renderCameraList();
    };

    const nameBtn = header.querySelector('.btn-group-name');
    nameBtn.onclick = (e) => {
      e.stopPropagation();
      if (e.button === 2) return;
      currentGridGroupId = group.id;
      currentGridPage = 0;
      updateGroupGridView();
    };

    group.deviceIds.forEach(did => {
      const cam = cameras.find(c => c.deviceId === did);
      if (!cam) return;
      const card = createCameraCard(cam);
      card.classList.add('bg-primary/5', 'border-primary/20');
      body.appendChild(card);
    });

  const attachDrop = (el) => {
    el.ondragover = (e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; row.classList.add('ring-2', 'ring-primary', 'ring-inset'); };
    el.ondragleave = (e) => { e.stopPropagation(); row.classList.remove('ring-2', 'ring-primary', 'ring-inset'); };
    el.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('ring-2', 'ring-primary', 'ring-inset');
      const deviceId = e.dataTransfer.getData('text/plain');
      if (!deviceId) return;
      removeDeviceFromGroups(deviceId);
      const target = cameraGroups.find(g => g.id === group.id) || group;
      if (!target.deviceIds.includes(deviceId)) target.deviceIds.push(deviceId);
      saveGroupsToStorage();
      renderCameraList();
      showToast(`Added ${deviceId} to ${group.name}`);
    };
  };
  attachDrop(row);
  attachDrop(header);
  attachDrop(body);

  header.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!groupContextMenu) return;
    groupContextMenu.dataset.groupId = group.id;
    groupContextMenu.style.left = `${e.clientX}px`;
    groupContextMenu.style.top = `${e.clientY}px`;
    groupContextMenu.classList.remove('hidden');
    cameraContextMenu?.classList.add('hidden');
  };

  row.appendChild(header);
  row.appendChild(body);
  cameraListEl.appendChild(row);
});

  // Allow drop on empty space (ungroup)
  cameraListEl.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  cameraListEl.ondrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const deviceId = e.dataTransfer.getData('text/plain');
    if (!deviceId) return;
    // Only ungroup when dropping on empty space (not on a card)
    if (e.target.closest('.camera-card')) return;
    removeDeviceFromGroups(deviceId);
    saveGroupsToStorage();
    renderCameraList();
    showToast(`Removed ${deviceId} from groups`);
  };

  // Render ungrouped cameras
  const ungrouped = cameras.filter(c => !groupedIds.has(c.deviceId));
  ungrouped.forEach(cam => {
    const card = createCameraCard(cam);
    card.classList.add('camera-card');
    cameraListEl.appendChild(card);
  });
}

function updateVideoUI(cam) {
  const isRecording = cam.workState === 1;

  if (cam.connectionStatus !== 'ONLINE') {
    stopWhepPlayback(cam.deviceId || webrtcVideo.id);
    videoOverlayInfo.classList.add('hidden');
    noVideoPlaceholder.classList.remove('hidden');
    noVideoPlaceholder.innerHTML = `
        <span class="text-error font-bold text-xl uppercase tracking-wider">Camera Offline</span>
        <span class="text-[11px] mt-2 text-on-surface-variant">Cannot play live video while disconnected</span>
    `;
    videoSubtitle.textContent = `Device ID: ${cam.deviceId} • Connection: OFFLINE`;
    videoRecordingBadge.classList.add('hidden');
  } else {
    videoSubtitle.textContent = `Device ID: ${cam.deviceId} • Connection: ONLINE`;
    videoRecordingBadge.classList.toggle('hidden', !isRecording);
    if (cam.streamUrl) {
      const overlayText = isRecording ? `LIVE - ${cam.deviceId} • REC` : `LIVE - ${cam.deviceId}`;
      document.getElementById('video-overlay-text').textContent = overlayText;
    }

    if (cam.streamUrl) {
      noVideoPlaceholder.classList.add('hidden');
      videoOverlayInfo.classList.remove('hidden');
      ensureHiddenWhepSession(cam.deviceId, cam.streamUrl)
        .then(sess => {
          if (sess?.stream) {
            webrtcVideo.srcObject = sess.stream;
            webrtcVideo.classList.remove('hidden');
          }
        })
        .catch(() => {
          webrtcVideo.classList.add('hidden');
          noVideoPlaceholder.classList.remove('hidden');
          noVideoPlaceholder.innerHTML = `
              <span class="text-error font-bold text-xl uppercase tracking-wider">WebRTC Connect Failed</span>
              <span class="text-[11px] mt-2 text-on-surface-variant">Check MediaMTX 8889/WHEP</span>
          `;
        });
    }
    if (!cam.streamUrl) {
      videoRecordingBadge.classList.add('hidden');
      stopWhepPlayback(cam.deviceId || webrtcVideo.id);
      webrtcVideo.classList.add('hidden');
      noVideoPlaceholder.classList.remove('hidden');
      noVideoPlaceholder.innerHTML = `
          <span class="text-error font-bold text-xl uppercase tracking-wider">No stream URL</span>
          <span class="text-[11px] mt-2 text-on-surface-variant">Camera has no streamUrl configured</span>
      `;
    }
  }
}

function addTimelineEvent(type, tooltipText = '', timestamp = Date.now()) {
  timelineEvents.push({
    type,
    tooltipText,
    timestamp,
    minuteOfDay: getTimelineEventMinute(timestamp)
  });
  renderTimeline();
}

function selectCamera(id) {
  setViewMode('single');
  selectedCameraId = id;
  const cam = cameras.find(c => c.id === id);
  if (!cam) return;

  // Prewarm talk session for selected camera
  if (cam?.deviceId) {
    prewarmTalkSessionsForTargets([cam.deviceId]);
    currentTalkDeviceId = cam.deviceId;
  }

  renderCameraList();
  renderGroups();

  ctrlDeviceId.value = cam.deviceId;
  videoTitle.textContent = cam.name;

  // Timeline & Events are now GLOBAL. Do not clear them here!

  stopWhepPlayback(cam.deviceId || webrtcVideo.id);
  webrtcVideo.classList.add('hidden');
  videoOverlayInfo.classList.add('hidden');
  noVideoPlaceholder.classList.remove('hidden');
  noVideoPlaceholder.innerHTML = `
      <span class="material-symbols-outlined text-6xl mb-4">videocam_off</span>
      <span>Connecting...</span>
  `;

  updateVideoUI(cam);
}

async function removeCamera(id) {
  if (!confirm('Are you sure you want to delete this camera?')) return;
  const cam = cameras.find(c => c.id === id);
  try {
    const res = await fetch(`/api/cameras/${id}`, { method: 'DELETE' });
    if (res.ok) {
      if (selectedCameraId === id) {
        selectedCameraId = null;
        stopWhepPlayback(cam.deviceId || webrtcVideo.id);
        noVideoPlaceholder.classList.remove('hidden');
        videoOverlayInfo.classList.add('hidden');
        videoTitle.textContent = "Select Camera";
        videoSubtitle.textContent = "Device ID will be displayed here";
        ctrlDeviceId.value = '';
      }
      fetchCameras();
      showToast('Camera deleted successfully');
    }
  } catch (e) { showToast('Error deleting camera', true); }
}

// Group Grid Pagination Logic
function updateGroupGridView() {
  if (!currentGridGroupId) return;
  const group = cameraGroups.find(g => g.id === currentGridGroupId);
  if (!group || group.deviceIds.length === 0) {
    showToast('Group is empty', true);
    return;
  }
  
  const totalCams = group.deviceIds.length;
  const isLarge = totalCams > 4;
  const pageSize = isLarge ? 9 : 4;
  const totalPages = Math.ceil(totalCams / pageSize);
  
  if (currentGridPage >= totalPages) currentGridPage = totalPages - 1;
  if (currentGridPage < 0) currentGridPage = 0;
  
  const gridPaginationOverlay = document.getElementById('grid-pagination-overlay');
  const gridPageIndicator = document.getElementById('grid-page-indicator');
  const btnGridPrev = document.getElementById('btn-grid-prev');
  const btnGridNext = document.getElementById('btn-grid-next');

  if (totalPages > 1 && gridPaginationOverlay) {
    gridPaginationOverlay.classList.remove('hidden');
    gridPageIndicator.textContent = `PAGE ${currentGridPage + 1}/${totalPages}`;
    btnGridPrev.disabled = currentGridPage === 0;
    btnGridNext.disabled = currentGridPage === totalPages - 1;
    
    btnGridPrev.onclick = () => { if (currentGridPage > 0) { currentGridPage--; updateGroupGridView(); } };
    btnGridNext.onclick = () => { if (currentGridPage < totalPages - 1) { currentGridPage++; updateGroupGridView(); } };
  } else if (gridPaginationOverlay) {
    gridPaginationOverlay.classList.add('hidden');
  }

  // Prewarm ALL group sessions for Zero-Latency Remote Mic and WebRTC
  if (group.deviceIds && group.deviceIds.length > 0) {
    prewarmTalkSessionsForTargets([`group_${group.id}`])
      .then(() => {
        // Microphone enabled & WHIP SUCCEEDED. Include VMS talkStream.
        setTimeout(() => {
          fetch('/api/ui/group-audio/mix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              groupId: group.id,
              deviceIds: group.deviceIds,
              includeOffline: true,
              includeSelf: false,
              // use raw talk stream (Opus via RTSP); mixer will transcode to AAC
              talkStream: `talk_group_${group.id}`,
              mirrorToTalk: true
            })
          }).catch(() => {});
        }, 1500); // Wait 1.5s for MediaMTX to spin up the AAC transcoder
      })
      .catch((err) => {
        // Microphone FAILED or denied. Mix the cameras anyway, but DO NOT include VMS talkStream!
        console.warn('Microphone prewarm failed, starting intercom without VMS audio.', err);
        fetch('/api/ui/group-audio/mix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            groupId: group.id,
            deviceIds: group.deviceIds,
            includeOffline: true,
            includeSelf: false,
            talkStream: null, // Prevent 404 crash in ffmpeg
            mirrorToTalk: true
          })
        }).catch(() => {});
      });

    group.deviceIds.forEach(did => {
      const cam = cameras.find(c => c.deviceId === did);
      if (cam?.streamUrl) ensureHiddenWhepSession(did, cam.streamUrl).catch(() => {});
    });
  }
  
  const startIdx = currentGridPage * pageSize;
  const pageDeviceIds = group.deviceIds.slice(startIdx, startIdx + pageSize);

  for (let i = 0; i < 9; i++) gridCameras[i] = null;

  pageDeviceIds.forEach((did, idx) => {
    const cam = cameras.find(c => c.deviceId === did);
    if (cam) gridCameras[idx] = cam;
  });

  setViewMode(isLarge ? 'grid3x3' : 'grid2x2');

  // Auto-start streams
  pageDeviceIds.forEach(did => {
    const cam = cameras.find(c => c.deviceId === did);
    let rtmpUrl = `rtmp://10.10.50.253/live/${did}`;
    if (cam && cam.streamUrl) {
      try { rtmpUrl = `rtmp://${new URL(cam.streamUrl).hostname}/live/${did}`; } catch (e) { }
    }
    fetch('/api/ui/send-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: did, serviceId: 'startLiveAction', paras: { rtmpUrl } })
    }).catch(()=>{});
  });
  
  showToast(`Viewing Group: ${group.name}${totalPages > 1 ? ` (Page ${currentGridPage + 1})` : ''}`);
}

// Group helpers
function removeDeviceFromGroups(deviceId) {
  cameraGroups.forEach(g => {
    const idx = g.deviceIds.indexOf(deviceId);
    if (idx !== -1) g.deviceIds.splice(idx, 1);
  });
  saveGroupsToStorage();
}

// Backward compatibility: some flows still call renderGroups
function renderGroups() {
  renderCameraList();
}

function saveGroupsToStorage() {
  try { localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(cameraGroups)); } catch (e) { }
}

function loadGroupsFromStorage() {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) cameraGroups = parsed.map(g => ({ ...g, deviceIds: g.deviceIds || [] }));
  } catch (e) { cameraGroups = []; }
}

// Add Modal Logic
const addModal = document.getElementById('add-camera-modal');
const addModalContent = document.getElementById('add-camera-modal-content');
const addGroupModal = document.getElementById('add-group-modal');
const addGroupModalContent = document.getElementById('add-group-modal-content');
const inputGroupName = document.getElementById('input-group-name');

const renameGroupModal = document.getElementById('rename-group-modal');
const renameGroupModalContent = document.getElementById('rename-group-modal-content');
const inputRenameGroup = document.getElementById('input-rename-group');

const deleteGroupModal = document.getElementById('delete-group-modal');
const deleteGroupModalContent = document.getElementById('delete-group-modal-content');

let currentRenameGroupId = null;
let currentDeleteGroupId = null;

function showAddModal() {
  addModal.classList.remove('hidden');
  setTimeout(() => addModalContent.classList.remove('scale-95'), 10);
}

function hideAddModal() {
  addModalContent.classList.add('scale-95');
  setTimeout(() => addModal.classList.add('hidden'), 200);
}

document.getElementById('btn-cancel-add-camera').onclick = hideAddModal;
document.getElementById('add-camera-modal').addEventListener('click', (e) => {
  if (e.target === addModal) hideAddModal();
});

function showAddGroupModal() {
  addGroupModal.classList.remove('hidden');
  setTimeout(() => addGroupModalContent.classList.remove('scale-95'), 10);
  inputGroupName.value = '';
  inputGroupName.focus();
}

function hideAddGroupModal() {
  addGroupModalContent.classList.add('scale-95');
  setTimeout(() => addGroupModal.classList.add('hidden'), 200);
}

document.getElementById('btn-cancel-add-group').onclick = hideAddGroupModal;
addGroupModal?.addEventListener('click', (e) => {
  if (e.target === addGroupModal) hideAddGroupModal();
});

// Rename Modal
function showRenameGroupModal(groupId, oldName) {
  currentRenameGroupId = groupId;
  renameGroupModal.classList.remove('hidden');
  setTimeout(() => renameGroupModalContent.classList.remove('scale-95'), 10);
  inputRenameGroup.value = oldName;
  inputRenameGroup.focus();
}

function hideRenameGroupModal() {
  renameGroupModalContent.classList.add('scale-95');
  setTimeout(() => renameGroupModal.classList.add('hidden'), 200);
  currentRenameGroupId = null;
}

document.getElementById('btn-cancel-rename-group').onclick = hideRenameGroupModal;
renameGroupModal?.addEventListener('click', (e) => {
  if (e.target === renameGroupModal) hideRenameGroupModal();
});

document.getElementById('btn-save-rename-group').onclick = () => {
    if (!currentRenameGroupId) return;
    const newName = inputRenameGroup.value.trim();
    if (!newName) { showToast('Please enter a valid group name', true); return; }
    
    const groupIdx = cameraGroups.findIndex(g => g.id === currentRenameGroupId);
    if (groupIdx !== -1) {
      cameraGroups[groupIdx].name = newName;
      saveGroupsToStorage();
      renderCameraList();
      showToast(`Group renamed to "${newName}"`);
    }
    hideRenameGroupModal();
};

// Delete Modal
function showDeleteGroupModal(groupId, groupName) {
  currentDeleteGroupId = groupId;
  document.getElementById('delete-group-text').innerHTML = `Are you sure you want to delete group <b>"${groupName}"</b>? All cameras inside will be ungrouped.`;
  deleteGroupModal.classList.remove('hidden');
  setTimeout(() => deleteGroupModalContent.classList.remove('scale-95'), 10);
}

function hideDeleteGroupModal() {
  deleteGroupModalContent.classList.add('scale-95');
  setTimeout(() => deleteGroupModal.classList.add('hidden'), 200);
  currentDeleteGroupId = null;
}

document.getElementById('btn-cancel-delete-group').onclick = hideDeleteGroupModal;
deleteGroupModal?.addEventListener('click', (e) => {
  if (e.target === deleteGroupModal) hideDeleteGroupModal();
});

document.getElementById('btn-confirm-delete-group').onclick = () => {
    if (!currentDeleteGroupId) return;
    const groupIdx = cameraGroups.findIndex(g => g.id === currentDeleteGroupId);
    if (groupIdx !== -1) {
      cameraGroups.splice(groupIdx, 1);
      saveGroupsToStorage();
      renderCameraList();
      showToast(`Group deleted`);
    }
    hideDeleteGroupModal();
};

// Context menu on camera panel
cameraPanelEl?.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!cameraContextMenu) return;
  cameraContextMenu.style.left = `${e.clientX}px`;
  cameraContextMenu.style.top = `${e.clientY}px`;
  cameraContextMenu.classList.remove('hidden');
});

document.addEventListener('click', () => {
  cameraContextMenu?.classList.add('hidden');
  groupContextMenu?.classList.add('hidden');
});

groupContextMenu?.addEventListener('click', (e) => {
  const action = e.target?.dataset?.action;
  const groupId = groupContextMenu.dataset.groupId;
  groupContextMenu.classList.add('hidden');

  const groupIdx = cameraGroups.findIndex(g => g.id === groupId);
  if (groupIdx === -1) return;

  if (action === 'rename') {
    showRenameGroupModal(groupId, cameraGroups[groupIdx].name);
  } else if (action === 'delete') {
    showDeleteGroupModal(groupId, cameraGroups[groupIdx].name);
  }
});

cameraContextMenu?.addEventListener('click', (e) => {
  const action = e.target?.dataset?.action;
  cameraContextMenu.classList.add('hidden');
  if (action === 'add') {
    showAddModal();
  } else if (action === 'group') {
    showAddGroupModal();
  }
});

document.getElementById('btn-save-group').onclick = () => {
  const name = inputGroupName.value.trim();
  if (!name) { showToast('Please enter group name', true); return; }
  cameraGroups.push({ id: `grp_${Date.now()}`, name, deviceIds: [] });
  saveGroupsToStorage();
  hideAddGroupModal();
  renderCameraList();
  showToast(`Created group "${name}"`);
};

document.getElementById('btn-save-camera').onclick = async () => {
  const name = document.getElementById('input-cam-name').value.trim();
  const deviceId = document.getElementById('input-cam-device-id').value.trim();
  if (!name || !deviceId) { showToast('Please fill all fields', true); return; }

  const id = `cam_${Date.now()}`;
  document.getElementById('btn-save-camera').textContent = 'Saving...';

  try {
    const res = await fetch('/api/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, deviceId })
    });
    const result = await res.json();
    if (result.success) {
      document.getElementById('input-cam-name').value = '';
      document.getElementById('input-cam-device-id').value = '';
      document.getElementById('btn-cancel-add-camera').click();
      fetchCameras();
      showToast('Camera bound successfully');
    } else {
      showToast(result.message, true);
    }
  } catch (err) {
    showToast('Network error while saving', true);
  } finally {
    document.getElementById('btn-save-camera').textContent = 'Save Device';
  }
};

// Send Commands Logic
async function sendCommand(serviceId, customParas = null) {
  const deviceId = ctrlDeviceId.value;
  if (!deviceId) { showToast('Please select a camera first', true); return; }

  let paras = customParas || {};
  if (serviceId === 'startLiveAction') {
    const cam = cameras.find(c => c.deviceId === deviceId);
    let rtmpUrl = `rtmp://10.10.50.253/live/${deviceId}`;
    if (cam && cam.streamUrl) {
      try { rtmpUrl = `rtmp://${new URL(cam.streamUrl).hostname}/live/${deviceId}`; } catch (e) { }
    }
    paras = { rtmpUrl };
  }

  try {
    const res = await fetch('/api/ui/send-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, serviceId, paras })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`Command ${serviceId} queued for ${deviceId}`);

      // Tự động reload video sau 1.5 giây nếu là lệnh start/stop stream
      if (serviceId === 'startLiveAction' || serviceId === 'stopLiveAction') {
        setTimeout(() => {
          const video = document.getElementById('webrtc-video');
          const cam = cameras.find(c => c.deviceId === deviceId);
          if (!video || !cam) return;
          stopWhepPlayback(deviceId);
          if (serviceId === 'startLiveAction' && cam.streamUrl) {
            ensureHiddenWhepSession(deviceId, cam.streamUrl)
              .then(sess => { if (sess?.stream) video.srcObject = sess.stream; })
              .catch(() => {});
          }
          if (serviceId === 'stopLiveAction') {
            video.classList.add('hidden');
            noVideoPlaceholder.classList.remove('hidden');
          }
          console.log(`[UI] Reloaded WebRTC player after ${serviceId}`);
        }, 1500);
      }
    } else {
      showToast(`Command failed: ${result.message}`, true);
    }
  } catch (e) {
    showToast('Network error', true);
  }
}

document.getElementById('btn-start-stream').onclick = () => {
  const deviceId = ctrlDeviceId.value;
  if (!deviceId) { showToast('Please select a camera first', true); return; }

  const cam = cameras.find(c => c.deviceId === deviceId);
  if (!cam) return;

  if (viewMode !== 'single') {
    if (gridCameras.find(c => c && c.deviceId === deviceId)) {
      showToast(`${deviceId} is already in the grid`);
      return;
    }
    const maxCells = viewMode === 'grid3x3' ? 9 : 4;
    let emptyIdx = -1;
    for (let i = 0; i < maxCells; i++) {
      if (!gridCameras[i]) { emptyIdx = i; break; }
    }

    if (emptyIdx === -1) {
      showToast('Grid is full. Close a view first.', true);
      return;
    }
    gridCameras[emptyIdx] = cam;
    renderGrid();
    sendCommand('startLiveAction');
    showToast(`Added ${deviceId} to Grid View`);
  } else {
    sendCommand('startLiveAction');
    showToast(`Requesting stream for ${deviceId}...`);
  }
};

document.getElementById('btn-stop-stream').onclick = () => {
  const deviceId = ctrlDeviceId.value;
  if (!deviceId) { showToast('Please select a camera first', true); return; }
  sendCommand('stopLiveAction');
  showToast(`Stopping stream for ${deviceId}...`);
};

document.getElementById('btn-group-call').onclick = () => showToast('Feature: Group Call - Coming Soon', true);

// Remote Mic (Two-Way Audio)
let micStream = null;            // shared mic stream
let baseMicTrack = null;         // primary track to clone
const talkSessions = new Map();  // deviceId -> { pc, track, whipUrl, ready }
const talkSessionPromises = new Map(); // deviceId -> in-flight promise
let isMicActive = false;         // any track currently unmuted
let currentTalkDeviceId = '';
let cameraGroups = []; // {id, name, deviceIds:[]}
const GROUPS_STORAGE_KEY = 'vms_camera_groups_v1';

const btnRemoteMic = document.getElementById('btn-remote-mic');

async function ensureMicStream() {
  if (micStream && baseMicTrack) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Secure Origin (HTTPS/localhost) required for Mic!', true);
    throw new Error('getUserMedia not supported');
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    baseMicTrack = micStream.getAudioTracks()[0];
    if (baseMicTrack) baseMicTrack.enabled = false;
    return true;
  } catch (err) {
    showToast('Microphone access denied or error!', true);
    throw err;
  }
}

async function ensureRemoteMicSessionForDevice(deviceId) {
  if (!deviceId) { showToast('Please select a camera first', true); return false; }
  if (talkSessions.get(deviceId)?.ready) return true;
  if (talkSessionPromises.has(deviceId)) return talkSessionPromises.get(deviceId);

  const p = (async () => {
    await ensureMicStream();
    let mediamtxHost = window.location.hostname;
    if (!deviceId.startsWith('group_')) {
      const cam = cameras.find(c => c.deviceId === deviceId);
      if (cam && cam.streamUrl) {
        try { mediamtxHost = new URL(cam.streamUrl).hostname; } catch (e) { }
      }
    } else {
      const groupId = deviceId.substring(6);
      const groupData = cameraGroups.find(g => g.id === groupId);
      if (groupData && groupData.deviceIds && groupData.deviceIds.length > 0) {
        const firstCam = cameras.find(c => c.deviceId === groupData.deviceIds[0]);
        if (firstCam && firstCam.streamUrl) {
          try { mediamtxHost = new URL(firstCam.streamUrl).hostname; } catch (e) { }
        }
      }
    }

    const track = baseMicTrack.clone();
    track.enabled = false; // mute by default

    const pc = new RTCPeerConnection();
    pc.addTransceiver(track, { direction: 'sendonly' });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait ICE complete
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 2000);
    });

    const whipUrl = `http://${mediamtxHost}:8889/talk_${deviceId}/whip`;
    const res = await fetch(whipUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp
    });
    if (!res.ok) throw new Error(`WHIP ${res.status}`);

    const answerSdp = await res.text();
    if (!answerSdp) throw new Error('No answer SDP from MediaMTX');
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));

    talkSessions.set(deviceId, { pc, track, whipUrl, ready: true });
    return true;
  })().finally(() => talkSessionPromises.delete(deviceId));

  talkSessionPromises.set(deviceId, p);
  return p;
}

async function prewarmTalkSessionsForTargets(deviceIds = []) {
  const uniqueIds = Array.from(new Set(deviceIds));
  await Promise.all(uniqueIds.map(id => ensureRemoteMicSessionForDevice(id).catch(() => false)));
}

function getTalkTargets() {
  if (viewMode === 'single') {
    const cam = cameras.find(c => c.id === selectedCameraId || c.deviceId === selectedCameraId);
    return cam ? [cam.deviceId] : [];
  }
  // If viewing a group, target the GROUP instead of ALL cameras to avoid WHIP path conflicts
  if (currentGridGroupId) {
    return [`group_${currentGridGroupId}`];
  }
  if (viewMode === 'grid2x2' || viewMode === 'grid3x3') {
    return gridCameras.filter(Boolean).map(c => c.deviceId);
  }
  return [];
}

async function startRemoteMic() {
  const targets = getTalkTargets();
  if (targets.length === 0) { showToast('Please select a camera first', true); return; }

  // Ensure WHIP sessions already exist so PTT only toggles mute/unmute
  await Promise.all(targets.map(id => ensureRemoteMicSessionForDevice(id).catch(() => false)));

  targets.forEach(id => {
    const sess = talkSessions.get(id);
    if (sess?.track) {
      sess.track.enabled = true;
    }
  });

  isMicActive = true;
  btnRemoteMic.classList.add('bg-error', 'text-white', 'animate-pulse');
  btnRemoteMic.classList.remove('bg-surface-container-high', 'text-on-surface');
}

function stopRemoteMic() {
  const targets = getTalkTargets();
  targets.forEach(id => {
    const sess = talkSessions.get(id);
    if (sess?.track) sess.track.enabled = false;
  });
  isMicActive = false;
  btnRemoteMic.classList.remove('bg-error', 'text-white', 'animate-pulse');
  btnRemoteMic.classList.add('bg-surface-container-high', 'text-on-surface');
}

async function endRemoteMicSessionForDevice(deviceId) {
  const sess = talkSessions.get(deviceId);
  if (!sess) return;
  if (sess.pc) sess.pc.close();
  if (sess.track) sess.track.stop();
  if (sess.whipUrl) {
    try { fetch(sess.whipUrl, { method: 'DELETE' }).catch(() => { }); } catch (e) { }
  }
  talkSessions.delete(deviceId);
}

async function endAllTalkSessions() {
  const ids = Array.from(talkSessions.keys());
  await Promise.all(ids.map(id => endRemoteMicSessionForDevice(id)));
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; baseMicTrack = null; }
  isMicActive = false;
}

['mousedown', 'touchstart'].forEach(evt =>
  btnRemoteMic.addEventListener(evt, (e) => { e.preventDefault(); startRemoteMic(); })
);

['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt =>
  btnRemoteMic.addEventListener(evt, (e) => { e.preventDefault(); stopRemoteMic(); })
);

// Render Event Feed
function renderEventFeed(data) {
  if (!registerGlobalEvent(data)) return;
  if (!matchesSelectedTimelineDate(data)) return;
  renderEventItem(data, false);
}

function renderEventItem(data, isHistorical) {
  let title = "System Notification";
  let desc = "";
  let icon = "info";
  let colorClass = "text-primary";
  let bgClass = "bg-surface-container text-on-surface";
  let timeStr = getEventReferenceDate(data).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let unifiedType = null;
  let devId = null;
  let snapPath = null;
  let evtTimeText = data.receivedAt;
  let evtName = "System Notification";

  if (data.type === 'gateway-data') {
    const gType = data.data?.type;
    if (['device-event', 'device-snapshot', 'sos-alarm', 'event-message'].includes(gType)) {
      unifiedType = gType;
      devId = data.data?.deviceId;
      snapPath = data.data?.snapshotPath;
      evtTimeText = getGatewayEventTimestamp(data);
      evtName = data.data?.eventName || gType;
    } else {
      return; // Ignore other gateway webhooks
    }
  } else if (data.type === 'command-response') {
    // Keep it generic
    unifiedType = 'command-response';
    evtName = `Command Response: ${data.mid || 'Unknown'}`;
  } else {
    unifiedType = 'unknown';
  }

  if (['device-event', 'device-snapshot', 'sos-alarm', 'event-message'].includes(unifiedType)) {
    title = "Camera Event: " + evtName;
    desc = `Time: ${evtTimeText}`;
    if (unifiedType === 'sos-alarm') {
      icon = 'warning';
      colorClass = 'text-error';
      bgClass = 'bg-error/10 border-error/20';
    } else if (unifiedType === 'event-message') {
      icon = 'notification_important';
      colorClass = 'text-amber-700';
      bgClass = 'bg-amber-100 border-amber-200';
    } else if (unifiedType === 'device-snapshot') {
      icon = 'photo_camera';
      colorClass = 'text-primary';
      bgClass = 'bg-primary/5 border-primary/20';
    } else {
      icon = 'event';
      colorClass = 'text-primary';
      bgClass = 'bg-primary/5 border-primary/20';
    }

    const dt = getEventReferenceDate(data);
    const timeStr = dt.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tType = unifiedType === 'device-snapshot'
      ? 'snapshot'
      : (unifiedType === 'sos-alarm' ? 'sos' : (unifiedType === 'event-message' ? 'event-message' : 'event'));
    const tooltip = `[${timeStr}] ${evtName}`;
    addTimelineEvent(tType, tooltip, dt.getTime());

    if (snapPath && (unifiedType === 'device-snapshot' || unifiedType === 'sos-alarm' || unifiedType === 'event-message')) {
      const camObj = cameras.find(c => c.deviceId === devId);
      const displayName = camObj ? camObj.name : devId;
      const isSosSnapshot = unifiedType === 'sos-alarm';
      const isEventMessageSnapshot = unifiedType === 'event-message';
      const previewBgClass = isSosSnapshot
        ? 'bg-error/10 border-error/20'
        : (isEventMessageSnapshot ? 'bg-amber-100 border-amber-200' : bgClass);
      const metaTextClass = isSosSnapshot
        ? 'text-error'
        : (isEventMessageSnapshot ? 'text-amber-700' : colorClass);
      const el = document.createElement('div');
      el.className = `flex flex-col gap-2 p-3 rounded-xl border hover:shadow-md transition-all ${previewBgClass}`;
      el.innerHTML = `
              <div class="flex gap-3 items-start w-full">
                  <div class="w-[72px] h-[54px] bg-black/5 border border-surface-container-high rounded-lg overflow-hidden shrink-0 flex items-center justify-center relative">
                       ${snapPath ? `<img src="${snapPath}" class="object-cover w-full h-full cursor-pointer" onclick="window.open('${snapPath}', '_blank')" />` : '<span class="text-[8px] text-outline">No Img</span>'}
                  </div>
                  <div class="flex-1 min-w-0 flex flex-col justify-between h-[54px] py-0.5">
                      <div>
                          <div class="flex items-center gap-1 text-[10px] font-bold ${metaTextClass} uppercase truncate mb-0.5">
                              <span class="material-symbols-outlined text-sm shrink-0">${icon}</span> 
                              <span class="truncate pr-1" title="${displayName}">${displayName}</span>
                          </div>
                          <div class="text-[10px] text-on-surface font-semibold truncate capitalize">${evtName}</div>
                      </div>
                      <div class="flex justify-between items-end mt-auto">
                          <div class="text-[9px] text-on-surface-variant opacity-80">${evtTimeText}</div>
                          <span class="text-[9px] text-outline shrink-0 ml-1">${timeStr}</span>
                      </div>
                  </div>
              </div>
          `;
      isHistorical ? eventFeedList.appendChild(el) : eventFeedList.prepend(el);
      if (eventFeedList.children.length > 50) eventFeedList.lastChild.remove();
      return;
    }
  }

  const el = document.createElement('div');
  el.className = `flex gap-4 p-3 rounded-xl border hover:shadow-md transition-all ${bgClass}`;
  el.innerHTML = `
      <div class="flex-1 min-w-0">
          <div class="flex justify-between items-center">
              <span class="flex items-center gap-1 text-xs font-bold ${colorClass} uppercase truncate pr-2">
                  <span class="material-symbols-outlined text-sm shrink-0">${icon}</span> 
                  <span class="truncate">${title}</span>
              </span>
              <span class="text-[10px] text-outline whitespace-nowrap">${timeStr}</span>
          </div>
          <div class="text-[11px] text-on-surface-variant flex items-center justify-between mt-1">
              <span class="truncate">${desc}</span>
          </div>
      </div>
  `;
  isHistorical ? eventFeedList.appendChild(el) : eventFeedList.prepend(el);
  if (eventFeedList.children.length > 50) eventFeedList.lastChild.remove();
}

// Initial Boot
// ... (Bottom of file)
const btnSingle = document.getElementById('btn-view-single');
const btnGrid2 = document.getElementById('btn-view-grid2');
const btnGrid3 = document.getElementById('btn-view-grid3');
const btnMap = document.getElementById('btn-view-map');
const singleViewContainer = document.getElementById('single-view-container');
const gridViewContainer = document.getElementById('grid-view-container');

function setViewMode(mode) {
  const prevMode = viewMode;
  viewMode = mode;

  // Reset buttons
  [btnSingle, btnGrid2, btnGrid3, btnMap].forEach(btn => {
    btn.classList.remove('bg-primary', 'text-white', 'shadow-md');
    btn.classList.add('text-on-surface');
  });

  singleViewContainer.classList.add('hidden');
  gridViewContainer.classList.add('hidden');
  mapViewContainer.classList.add('hidden');

  // Stop unused WebRTC sessions when leaving a mode
  if ((prevMode === 'grid2x2' || prevMode === 'grid3x3') && mode !== 'grid2x2' && mode !== 'grid3x3') {
    for (let i = 0; i < 9; i++) stopWhepPlayback(`grid-video-${i}`);
  }
  if (prevMode === 'single' && mode !== 'single') {
    stopWhepPlayback(webrtcVideo.id);
  }

  if (mode === 'single') {
    btnSingle.classList.add('bg-primary', 'text-white', 'shadow-md');
    btnSingle.classList.remove('text-on-surface');

    singleViewContainer.classList.remove('hidden');
    if (selectedCameraId) {
      updateVideoUI(cameras.find(c => c.id === selectedCameraId || c.deviceId === selectedCameraId));
    }
  } else if (mode === 'map') {
    btnMap.classList.add('bg-primary', 'text-white', 'shadow-md');
    btnMap.classList.remove('text-on-surface');
    mapViewContainer.classList.remove('hidden');
    resetMapView();
  } else {
    gridViewContainer.classList.remove('hidden');
    gridViewContainer.className = `absolute inset-0 grid gap-[2px] bg-surface-container-high`;

    if (mode === 'grid2x2') {
      btnGrid2.classList.add('bg-primary', 'text-white', 'shadow-md');
      btnGrid2.classList.remove('text-on-surface');
      gridViewContainer.classList.add('grid-cols-2', 'grid-rows-2');
    } else {
      btnGrid3.classList.add('bg-primary', 'text-white', 'shadow-md');
      btnGrid3.classList.remove('text-on-surface');
      gridViewContainer.classList.add('grid-cols-3', 'grid-rows-3');
    }
    renderGrid();
  }
}

btnSingle.onclick = () => setViewMode('single');
// btnGrid2.onclick = () => setViewMode('grid2x2'); // Hidden from UI
// btnGrid3.onclick = () => setViewMode('grid3x3'); // Hidden from UI
btnMap.onclick = () => setViewMode('map');

if (timelineEl) {
  timelineEl.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomTimeline(event.deltaY, event.clientX);
  }, { passive: false });
}

window.clearGridCell = function (idx) {
  gridCameras[idx] = null;
  renderGrid();
};

function renderGrid() {
  const maxCells = viewMode === 'grid3x3' ? 9 : 4;

  for (let i = 0; i < 9; i++) {
    const wrapper = document.getElementById(`grid-wrapper-${i}`);
    if (!wrapper) continue;

    if (i >= maxCells) {
      wrapper.classList.add('hidden');
      continue;
    }
    wrapper.classList.remove('hidden');

    const camId = gridCameras[i]?.deviceId;
    // Find freshest state from cameras array
    const cam = camId ? cameras.find(c => c.deviceId === camId) : null;
    gridCameras[i] = cam; // Update reference

    const video = document.getElementById(`grid-video-${i}`);
    const placeholder = document.getElementById(`grid-placeholder-${i}`);
    const info = document.getElementById(`grid-info-${i}`);

    if (cam && cam.connectionStatus === 'ONLINE' && cam.streamUrl) {
      video.classList.remove('hidden');
      placeholder.classList.add('hidden');
      info.classList.remove('hidden');
      if (cam.workState === 1) {
        info.innerHTML = `<span class="inline-flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-error animate-pulse"></span><span>${cam.deviceId}</span></span>`;
      } else {
        info.textContent = cam.deviceId;
      }

      ensureHiddenWhepSession(cam.deviceId, cam.streamUrl)
        .then(sess => {
          if (sess?.stream) {
            video.srcObject = sess.stream;
            video.classList.remove('hidden');
          }
        })
        .catch(() => {
          video.classList.add('hidden');
          placeholder.classList.remove('hidden');
          info.classList.add('hidden');
        });
      // Prewarm talk session for grid cam
      prewarmTalkSessionsForTargets([cam.deviceId]);
    } else {
      video.srcObject = null;
      placeholder.classList.remove('hidden');
      info.classList.add('hidden');
    }
  }
}

// Setup Drag and Drop onto Grid Cells
for (let i = 0; i < 9; i++) {
  const wrapper = document.getElementById(`grid-wrapper-${i}`);
  if (!wrapper) continue;

  wrapper.ondragover = (e) => {
    e.preventDefault(); // Necessary to allow dropping
    wrapper.classList.add('ring-2', 'ring-primary', 'ring-inset');
  };

  wrapper.ondragleave = (e) => {
    wrapper.classList.remove('ring-2', 'ring-primary', 'ring-inset');
  };

  wrapper.ondrop = (e) => {
    e.preventDefault();
    wrapper.classList.remove('ring-2', 'ring-primary', 'ring-inset');
    const deviceId = e.dataTransfer.getData('text/plain');
    if (!deviceId) return;

    const cam = cameras.find(c => c.deviceId === deviceId);
    if (!cam) return;

    const existingIdx = gridCameras.findIndex(c => c && c.deviceId === deviceId);
    if (existingIdx !== -1) {
      if (existingIdx === i) return; // Kéo vào đúng ô cũ thì kệ
      gridCameras[existingIdx] = null; // Gỡ khỏi ô cũ
    }

    // Gán vào ô mới
    gridCameras[i] = cam;
    renderGrid();

    // Auto-select
    ctrlDeviceId.value = deviceId;

    if (existingIdx === -1) {
      // Cũ chưa có thì gọi lệnh start stream mới
      sendCommand('startLiveAction');
      showToast(`Added ${deviceId} to Grid Cell ${i + 1}`);
    } else {
      showToast(`Moved ${deviceId} to Grid Cell ${i + 1}`);
    }
  };
}

// Setup Drag and Drop onto Single View
if (singleViewContainer) {
  singleViewContainer.ondragover = (e) => {
    e.preventDefault();
    singleViewContainer.classList.add('ring-4', 'ring-primary', 'ring-inset');
  };

  singleViewContainer.ondragleave = (e) => {
    singleViewContainer.classList.remove('ring-4', 'ring-primary', 'ring-inset');
  };

  singleViewContainer.ondrop = (e) => {
    e.preventDefault();
    singleViewContainer.classList.remove('ring-4', 'ring-primary', 'ring-inset');
    const deviceId = e.dataTransfer.getData('text/plain');
    if (!deviceId) return;

    const cam = cameras.find(c => c.deviceId === deviceId);
    if (!cam) return;

    // Select camera in UI
    selectCamera(cam.id);

    // Auto-start stream
    sendCommand('startLiveAction');
    showToast(`Streaming ${deviceId} in Single View`);
  };
}

if (timelineDateInput) {
  timelineDateInput.value = eventFilterState.selectedDate;
  timelineDateInput.addEventListener('change', (event) => {
    applyTimelineDateSelection(event.target.value);
    if (!timelineDateInput.value) {
      timelineDateInput.value = eventFilterState.selectedDate;
    }
  });
}

loadGroupsFromStorage();
fetchCameras().then(() => {
  fetchHistoricalEvents();
});
initSSE();
