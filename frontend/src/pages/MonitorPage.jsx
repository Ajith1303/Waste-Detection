import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const CLASS_META = {
  correct:  { label: 'Correct disposal',  cls: 'badge-correct',  color: '#16a34a' },
  full:     { label: 'Dustbin full',      cls: 'badge-full',     color: '#d97706' },
  illegal:  { label: 'Illegal dumping',   cls: 'badge-illegal',  color: '#dc2626' },
  near:     { label: 'Near bin (logged)', cls: 'badge-near',     color: '#ca8a04' },
  no_waste: { label: 'No waste',          cls: 'badge-no_waste', color: '#6b7280' },
  error:    { label: 'Error',             cls: 'badge-no_waste', color: '#6b7280' },
};

const SCENARIOS = [
  ['', 'random (varied feed)'],
  ['correct', 'correct disposal'],
  ['full', 'bin full'],
  ['illegal', 'illegal dumping'],
  ['near', 'pile-up beside bin'],
  ['none', 'empty frame'],
];

/**
 * Camera capture page.
 * - getUserMedia() streams the phone camera (simulates a CCTV feed).
 * - A frame is captured to a canvas every `intervalMs` (default 1.5s) and
 *   posted to POST /api/frames together with GPS + camera/session ids.
 * - A live overlay draws the configured dustbin zone and the latest AI
 *   bounding boxes (green=inside, amber=near band, red=outside).
 */
export default function MonitorPage() {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);   // visible overlay canvas (video + boxes)
  const captureRef = useRef(null);   // hidden capture canvas (frame snapshots)
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const rafRef = useRef(null);
  const sendingRef = useRef(false);
  const lastBoxesRef = useRef([]);
  const lastTracksRef = useRef([]);
  const locRef = useRef(null);

  const [zones, setZones] = useState([]);
  const [zoneId, setZoneId] = useState('');
  const [monitoring, setMonitoring] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [location, setLocation] = useState(null);
  const [intervalMs, setIntervalMs] = useState(1500);
  const [scenario, setScenario] = useState('');
  const [activity, setActivity] = useState([]);

  // Refs mirroring state so timer/RAF callbacks never see stale closures.
  const zoneIdRef = useRef(zoneId);       zoneIdRef.current = zoneId;
  const scenarioRef = useRef(scenario);   scenarioRef.current = scenario;
  const intervalRef = useRef(intervalMs); intervalRef.current = intervalMs;
  const zoneMapRef = useRef(new Map());
  zoneMapRef.current = new Map(zones.map((z) => [String(z.id), z]));
  const monitoringRef = useRef(monitoring);   monitoringRef.current = monitoring;
  const wakeLockRef = useRef(null);

  useEffect(() => {
    api.getZones()
      .then((z) => { setZones(z); if (z.length) setZoneId((prev) => prev || String(z[0].id)); })
      .catch((e) => setCameraError(e.message));
  }, []);

  const pushActivity = (entry) => setActivity((prev) => [entry, ...prev].slice(0, 40));

  const sendFrameRef = useRef(async () => {});
  const drawOverlayRef = useRef(() => {});

  const stopEverything = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };
  // ---- frame capture & send --------------------------------------------
  const sendFrame = async () => {
    const video = videoRef.current;
    const canvas = captureRef.current;
    if (!video || !video.videoWidth || !canvas || sendingRef.current) return;
    sendingRef.current = true;
    try {
      const frameW = Math.min(1280, video.videoWidth);
      const frameH = Math.round(video.videoHeight * (frameW / video.videoWidth));
      canvas.width = frameW;
      canvas.height = frameH;
      canvas.getContext('2d').drawImage(video, 0, 0, frameW, frameH);
      const imageBase64 = canvas.toDataURL('image/jpeg', 0.72);

      const zone = zoneMapRef.current.get(String(zoneIdRef.current));
      const res = await api.sendFrame({
        zoneId: zoneIdRef.current || null,
        cameraId: zone ? zone.camera_id : null,
        sessionId: 'browser-session',
        imageBase64,
        width: frameW,
        height: frameH,
        gps: locRef.current || {},
        mockScenario: scenarioRef.current || undefined,
        sampledAt: Date.now(),
      });

      lastBoxesRef.current = res.detections || [];
      lastTracksRef.current = res.tracks || [];
      const meta = CLASS_META[res.classification.type] || CLASS_META.no_waste;
      pushActivity({
        ts: new Date().toLocaleTimeString(),
        type: res.classification.type,
        text: res.classification.reason || meta.label,
        notif: res.notification ? res.notification.status : '-',
      });
    } catch (err) {
      pushActivity({ ts: new Date().toLocaleTimeString(), type: 'error', text: `Frame send failed: ${err.message}`, notif: '-' });
    } finally {
      sendingRef.current = false;
    }
  };

  // ---- live overlay (zone box + latest detections) ---------------------
  const drawOverlay = () => {
    const video = videoRef.current;
    const ov = overlayRef.current;
    if (!video || !ov || !video.videoWidth) return;
    const maxW = 1280;
    const scale = Math.min(1, maxW / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    if (ov.width !== w) { ov.width = w; ov.height = h; }
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(video, 0, 0, w, h);

    const zone = zoneMapRef.current.get(String(zoneIdRef.current));
    if (zone) drawBox(ctx, zone.zone_box, '#22c55e', 'Dustbin zone', w, h);

    for (const d of lastBoxesRef.current) {
      const color = d.placement === 'outside' ? '#dc2626'
        : d.placement === 'near' ? '#d97706' : '#16a34a';
      drawBox(ctx, {
        x1: d.x - d.w / 2, y1: d.y - d.h / 2,
        x2: d.x + d.w / 2, y2: d.y + d.h / 2,
      }, color, `${d.class} ${Math.round((d.confidence || 0) * 100)}%`, w, h);
    }

    // ---- tracked object overlay (ByteTrack trails + movement arrows) ----
    for (const t of lastTracksRef.current) {
      const trail = (t.movement && t.movement.trail) || t.history || [];
      const tx = t.x * w, ty = t.y * h;
      // 1) trail polyline (oldest -> newest, fading alpha)
      if (trail.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(trail[0][0] * w, trail[0][1] * h);
        for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i][0] * w, trail[i][1] * h);
        ctx.strokeStyle = 'rgba(59,130,246,0.55)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // 2) direction arrow (from newest history point toward current center)
      const mv = t.movement || {};
      const moving = mv.direction && mv.direction !== 'stationary' && mv.speed > 0.0005;
      if (moving && trail.length >= 2) {
        const from = trail[trail.length - 1];
        const dx = tx - from[0] * w, dy = ty - from[1] * h;
        const len = Math.hypot(dx, dy);
        if (len > 3) {
          const ux = dx / len, uy = dy / len;
          const ax = tx - ux * 22, ay = ty - uy * 22;
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          // arrowhead
          const ang = Math.atan2(dy, dx);
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - 10 * Math.cos(ang - 0.4), ty - 10 * Math.sin(ang - 0.4));
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - 10 * Math.cos(ang + 0.4), ty - 10 * Math.sin(ang + 0.4));
          ctx.stroke();
        }
      }
      // 3) track ID + movement label chip
      const label = `#${t.track_id} ${mv.direction || ''}`.trim();
      ctx.font = 'bold 11px system-ui';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(15,23,42,0.75)';
      ctx.fillRect(tx - tw / 2 - 4, Math.max(0, ty - 18), tw + 8, 16);
      ctx.fillStyle = '#facc15';
      ctx.fillText(label, tx - tw / 2, Math.max(0, ty - 6));
    }
  };

  function drawBox(ctx, box, color, label, w, h) {
    const x = box.x1 * w, y = box.y1 * h, bw = (box.x2 - box.x1) * w, bh = (box.y2 - box.y1) * h;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, bw, bh);
    ctx.fillStyle = color;
    ctx.font = 'bold 14px system-ui';
    ctx.fillText(label, x + 4, y + 16);
  }
  // ---- monitoring lifecycle -------------------------------------------------
  useEffect(() => {
    sendFrameRef.current = sendFrame;
    drawOverlayRef.current = drawOverlay;
  });

  // Start/stop everything when the monitoring flag flips.
  useEffect(() => {
    if (!monitoring) return;
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play().catch(() => {});

        // GPS tag for every capture (optional - failure is tolerated).
        if (navigator.geolocation && locRef.current === null) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              locRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              setLocation(locRef.current);
            },
            () => setLocation(null),
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
          );
        }

        // Sample 1 frame every intervalMs (1-2s recommended) to control API cost.
        timerRef.current = setInterval(() => sendFrameRef.current(), intervalRef.current);

        const loop = () => {
          drawOverlayRef.current();
          rafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        setCameraError(`Camera access blocked. Run in https:// (or localhost) and allow permission. ${err.message}`);
        setMonitoring(false);
      }
    })();

    return () => {
      cancelled = true;
      stopEverything();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoring]);

  // ---- screen wake-lock: keep the phone awake while monitoring -------------
  // Without this, the phone locks after ~30s, the capture timers freeze and the
  // PC Live View flips to OFFLINE. Wake Lock (HTTPS only) keeps the screen on.
  const requestWakeLock = async () => {
    if (!('wakeLock' in navigator) || wakeLockRef.current) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen');
      wakeLockRef.current.addEventListener('release', () => { wakeLockRef.current = null; });
    } catch (_) { /* wake lock unsupported/denied - feed still works */ }
  };
  const releaseWakeLock = () => {
    if (wakeLockRef.current) wakeLockRef.current.release().catch(() => {});
    wakeLockRef.current = null;
  };

  useEffect(() => {
    if (monitoring) requestWakeLock(); else releaseWakeLock();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        if (monitoringRef.current) requestWakeLock(); // re-acquire after tab switch
      } else {
        wakeLockRef.current = null; // browser auto-releases while hidden
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); releaseWakeLock(); };
  }, [monitoring]);

  // ---- remote start: PC Live View "▶ Start camera" --------------------------
  // While idle, poll for a PC-initiated start signal every 3s. If the phone's
  // camera permission was ALREADY granted (user tapped Allow at least once),
  // getUserMedia() works without another tap -> camera auto-starts. If not,
  // the normal "camera access blocked..." error guides the user to tap Start.
  useEffect(() => {
    if (monitoring) return; // already streaming; nothing to do
    const cam = zoneMapRef.current.get(String(zoneIdRef.current))?.camera_id;
    if (!cam) return;
    const tick = setInterval(async () => {
      try {
        const r = await api.checkRemoteStart(cam);
        if (r && r.start) {
          pushActivity({ ts: new Date().toLocaleTimeString(), type: 'correct', text: '📡 Remote start signal from PC — camera starting automatically…', notif: '-' });
          setMonitoring(true);
        }
      } catch (_) { /* backend offline - keep polling */ }
    }, 3000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitoring]);
  /* ================================ UI ================================ */
  const currentZone = zoneMapRef.current.get(String(zoneIdRef.current));

  return (
    <div>
      <h1>📹 Live Monitor <span className="muted" style={{ fontSize: 13 }}>(browser camera = simulated CCTV)</span></h1>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <label style={{ margin: 0 }}>Dustbin zone</label>
          <select style={{ width: 240 }} value={zoneId} disabled={monitoring} onChange={(e) => setZoneId(e.target.value)}>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>{z.name} — {z.area}</option>
            ))}
          </select>

          <label style={{ margin: 0 }}>Sample every</label>
          <select style={{ width: 130 }} value={intervalMs} disabled={monitoring} onChange={(e) => setIntervalMs(Number(e.target.value))}>
            <option value={1000}>1 second</option>
            <option value={1500}>1.5 sec</option>
            <option value={2500}>2.5 sec</option>
            <option value={5000}>5 sec (cheapest)</option>
          </select>

          <label style={{ margin: 0 }}>Demo scenario*</label>
          <select style={{ width: 200 }} value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {SCENARIOS.map(([v, l]) => <option key={v || 'random'} value={v}>{l}</option>)}
          </select>

          <button
            className={`btn ${monitoring ? 'danger' : 'primary'}`}
            onClick={() => { setCameraError(''); setMonitoring((m) => !m); }}
          >
            {monitoring ? '■ Stop Monitoring' : '▶ Start Monitoring'}
          </button>
        </div>

        <p className="muted">
          * Demo scenario is only used by the backend MOCK detector (no Roboflow API key needed). With a real
          model it is ignored — detections come from the actual camera feed.
        </p>

        <div className="video-wrap">
          <video ref={videoRef} playsInline muted />
          <canvas ref={overlayRef} className="cv-overlay" />
        </div>

        <div className="legend">
          <span><span className="dot" style={{ background: '#22c55e' }} /> Dustbin zone</span>
          <span><span className="dot" style={{ background: '#16a34a' }} /> Correct disposal</span>
          <span><span className="dot" style={{ background: '#d97706' }} /> Near bin</span>
          <span><span className="dot" style={{ background: '#dc2626' }} /> Outside = illegal</span>
          <span><span className="dot" style={{ background: '#3b82f6' }} /> Movement trail</span>
          <span><span className="dot" style={{ background: '#facc15' }} /> Track ID / direction</span>
        </div>

        {cameraError && <div className="notice err">{cameraError}</div>}
        {!monitoring && !cameraError && (
          <div className="notice">
            Press <b>Start Monitoring</b> — the browser will ask for camera + location permissions. Only HTTPS
            (or localhost) can access them.
          </div>
        )}

        <p className="muted">
          {location
            ? `📍 GPS locked: ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} — every frame is geo-tagged.`
            : '📍 GPS not captured yet (optional).'}
          {currentZone ? `  Zone: ${currentZone.name} (${currentZone.area}) · camera "${currentZone.camera_id}"` : ''}
        </p>
        <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          {monitoring && 'wakeLock' in navigator
            ? '🔒 Screen wake-lock ON — phone screen stays awake while monitoring.'
            : (monitoring && !('wakeLock' in navigator)
              ? '⚠ This browser lacks Wake Lock — screen sleep will pause the feed.'
              : 'Phone idle: PC Live View-la "▶ Start camera" click pannina auto-start aagum.')}
        </p>
      </div>

      {/* hidden snapshot canvas */}
      <canvas ref={captureRef} style={{ display: 'none' }} />

      <div className="card">
        <h2>Live classification feed <span className="muted">(last 40 frames)</span></h2>
        {activity.length === 0 ? (
          <p className="muted">No frames analysed yet.</p>
        ) : (
          <ul className="log-list">
            {activity.map((a, i) => (
              <li key={i}>
                <span className="ts">{a.ts}</span>
                <span className={`badge ${(CLASS_META[a.type] || CLASS_META.no_waste).cls}`}>
                  {(CLASS_META[a.type] || CLASS_META.no_waste).label}
                </span>
                <span className="msg">{a.text}</span>
                <code style={{ fontSize: 11 }}>notify: {a.notif}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}