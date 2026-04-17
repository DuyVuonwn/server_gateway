function parseCompactUtc(str) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(str || '');
  if (!match) return null;
  const [, y, m, d, hh, mm, ss] = match.map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

function parseEventTimestampMs(payload = {}) {
  const parasTs = payload.paras?.timestamp;
  const eventTime = payload.eventTime;
  const candidates = [parasTs, eventTime].filter(Boolean);

  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const compact = parseCompactUtc(String(value));
    if (compact) return compact;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function sanitizeName(input, fallback = 'unknown') {
  const safe = String(input || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  return safe || fallback;
}

function buildEventName(eventType = '') {
  const map = {
    'device-snapshot': 'Snapshot Captured',
    'sos-alarm': 'SOS Alarm',
    'event-message': 'Event Message',
    'device-event': 'Device Event'
  };
  return map[eventType] || 'Event';
}

function getImageExtension(format) {
  const normalized = String(format || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized || 'jpg';
}

module.exports = {
  parseCompactUtc,
  parseEventTimestampMs,
  sanitizeName,
  buildEventName,
  getImageExtension
};
