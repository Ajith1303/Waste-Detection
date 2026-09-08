// Thin REST client for the Express backend (proxied under /api in dev).
const API_BASE = '/api';

async function request(path, options = {}) {
  const resp = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      msg = j.error || msg;
    } catch (_) { /* keep default */ }
    throw new Error(msg);
  }
  return resp.json();
}

function toQs(params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return qs ? `?${qs}` : '';
}

export const api = {
  health: () => request('/health'),
  getZones: () => request('/zones'),
  createZone: (payload) => request('/zones', { method: 'POST', body: JSON.stringify(payload) }),
  updateZone: (id, payload) => request(`/zones/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteZone: (id) => request(`/zones/${id}`, { method: 'DELETE' }),
  getEvents: (params) => request(`/events${toQs(params)}`),
  getStats: () => request('/stats'),
  getLive: () => request('/live'),
  liveFrameUrl: (cameraId) => `/api/live/${encodeURIComponent(cameraId)}.jpg`,
  requestRemoteStart: (cameraId) => request(`/live/${encodeURIComponent(cameraId)}/start`, { method: 'POST' }),
  checkRemoteStart: (cameraId) => request(`/live/remote-start?cameraId=${encodeURIComponent(cameraId)}`),
  getResidents: (params) => request(`/residents${toQs(params)}`),
  registerResident: (payload) => request('/residents', { method: 'POST', body: JSON.stringify(payload) }),
  deleteResident: (id) => request(`/residents/${id}`, { method: 'DELETE' }),
  getAdmins: () => request('/admins'),
  createAdmin: (payload) => request('/admins', { method: 'POST', body: JSON.stringify(payload) }),
  deleteAdmin: (id) => request(`/admins/${id}`, { method: 'DELETE' }),
  sendFrame: (payload) => request('/frames', { method: 'POST', body: JSON.stringify(payload) }),
};