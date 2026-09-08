import { useEffect, useState } from 'react';
import { api } from '../api';

const CLASS_META = {
  correct:  { label: 'Correct disposal',  cls: 'badge-correct',  color: '#16a34a' },
  full:     { label: 'Dustbin full',      cls: 'badge-full',     color: '#d97706' },
  illegal:  { label: 'Illegal dumping',   cls: 'badge-illegal',  color: '#dc2626' },
  near:     { label: 'Near bin (logged)', cls: 'badge-near',     color: '#ca8a04' },
  no_waste: { label: 'No waste',          cls: 'badge-no_waste', color: '#6b7280' },
};

/** Normalized (0..1) box -> absolute % div, so overlay scales with any size. */
function Box({ box, color, label }) {
  const x = box.x1 * 100, y = box.y1 * 100;
  const w = (box.x2 - box.x1) * 100, h = (box.y2 - box.y1) * 100;
  return (
    <div
      style={{
        position: 'absolute', left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%`,
        border: `2px solid ${color}`, borderRadius: 4, pointerEvents: 'none',
        font: '600 11px system-ui', color
      }}
    >
      {label ? <span style={{ position: 'absolute', left: 4, top: -16, background: 'rgba(15,23,42,0.75)', color, padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap' }}>{label}</span> : null}
    </div>
  );
}

function LiveCard({ cam, zone, tick }) {
  const connected = !!cam.connected;
  const live = connected && cam.ageMs != null && cam.ageMs < 5000;
  const meta = CLASS_META[cam.classification?.type] || CLASS_META.no_waste;
  const src = api.liveFrameUrl(cam.cameraId) + `?t=${tick}`;
  const zoneBox = zone?.zone_box ?? null;
  const [reqState, setReqState] = useState('idle'); // idle | sending | sent | error

  // PC → phone remote start: posts a one-shot signal the phone's Monitor page polls.
  const sendStart = async () => {
    setReqState('sending');
    try { await api.requestRemoteStart(cam.cameraId); setReqState('sent'); }
    catch (_) { setReqState('error'); }
  };
  const btnLabel = reqState === 'idle' ? '▶ Start camera'
    : reqState === 'sending' ? 'Sending…'
    : reqState === 'sent' ? '✓ Signal sent' : '↻ Try again';

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div className="row" style={{ padding: '10px 14px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', margin: 0 }}>
        <span className={`badge ${!connected ? 'badge-no_waste' : live ? 'badge-sent' : 'badge-failed'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: live ? '#16a34a' : '#64748b', animation: live ? 'pulse 1.6s infinite' : 'none' }} />
          {live ? 'LIVE' : !connected ? 'STANDBY' : 'OFFLINE'}
        </span>
        <b style={{ fontSize: 14 }}>{cam.zoneName || cam.cameraId}</b>
        <span className="muted" style={{ fontSize: 11 }}>{cam.cameraId}</span>
        <span className="grow" />
        {connected ? (
          <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            {cam.ageMs < 1000 ? 'just now' : `last frame ${Math.round(cam.ageMs / 1000)}s ago`}
          </span>
        ) : null}
      </div>

      {/* ── Image area (connected) / placeholder (not connected) ──────── */}
      {connected ? (
        <div style={{ position: 'relative', background: '#000', minHeight: 180 }}>
          <img
            src={src}
            alt={`live feed ${cam.cameraId}`}
            onError={(e) => { e.currentTarget.style.opacity = 0.25; }}
            onLoad={(e) => { e.currentTarget.style.opacity = 1; }}
            style={{ width: '100%', display: 'block' }}
          />
          <div style={{ position: 'absolute', inset: 0 }}>
            {zoneBox ? <Box box={zoneBox} color="#22c55e" label={cam.zoneName || 'Dustbin zone'} /> : null}
            {(cam.detections || []).map((d, i) => {
              const color = d.placement === 'outside' ? '#dc2626' : d.placement === 'near' ? '#d97706' : '#16a34a';
              return (
                <Box
                  key={i}
                  box={{ x1: d.x - d.w / 2, y1: d.y - d.h / 2, x2: d.x + d.w / 2, y2: d.y + d.h / 2 }}
                  color={color}
                  label={`${d.class} ${Math.round((d.confidence || 0) * 100)}%`}
                />
              );
            })}
          </div>
          {!live ? <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', background: 'rgba(0,0,0,0.6)', fontSize: 13 }}>Waiting for frames…</div> : null}
        </div>
      ) : (
        <div style={{ background: '#0b1220', color: '#94a3b8', minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, fontSize: 13 }}>
          <div>
            📷 This camera has never streamed.<br />
            <span style={{ fontSize: 12 }}>Phone-la Monitor page open vachikonga + oru vaati <b>▶ Start Monitoring</b> → <b>Allow</b> pannirundha — inga <b>Start camera</b> click panna ~3s-la auto-start aagum.</span>
          </div>
        </div>
      )}

      {/* ── Footer: classification (connected) / Start button (not) ──── */}
      <div style={{ padding: '10px 14px' }}>
        {!connected ? (
          <button
            className="btn amber"
            onClick={sendStart}
            disabled={reqState === 'sending'}
            style={{ width: '100%' }}
            title="Signal the phone to start this camera (phone Monitor page open + camera permission previously granted once)"
          >
            {btnLabel}
          </button>
        ) : (
          <>
            <div className="row" style={{ margin: 0 }}>
              <span className={`badge ${meta.cls}`}>{meta.label}</span>
              {cam.classification?.reason ? (
                <span className="muted" style={{ fontSize: 12, flex: 1 }}>{cam.classification.reason}</span>
              ) : null}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
              {cam.width && cam.height ? `${cam.width}×${cam.height} · ` : ''}
              {cam.gps?.lat != null ? (
                <a target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${cam.gps.lat},${cam.gps.lng}`}>
                  📍 {cam.gps.lat.toFixed(5)}, {cam.gps.lng.toFixed(5)}
                </a>
              ) : '📍 GPS not captured'}
            </div>
          </>
        )}
        {!live && reqState === 'sent' ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>
            📡 Signal sent — phone app open + Allow panna permission irundha auto-start aagum (~3s).
          </div>
        ) : reqState === 'error' ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>Signal send failed — server reachable-aa check pannunga.</div>
        ) : null}
      </div>
    </div>
  );
}

export default function LiveViewPage() {
  const [cameras, setCameras] = useState([]);
  const [zones, setZones] = useState([]);
  const [tick, setTick] = useState(Date.now());
  const [error, setError] = useState('');

  useEffect(() => {
    api.getZones().then(setZones).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const list = await api.getLive();
        if (alive) { setCameras(list); setTick(Date.now()); setError(''); }
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    poll();
    const t = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const zoneMap = new Map(zones.map((z) => [String(z.camera_id), z]));

  return (
    <div>
      <h1>📡 Live View <span className="muted" style={{ fontSize: 13 }}>
        (phone camera feed → this screen, ~1 frame/sec)
      </span></h1>

      {error && <div className="notice err">{error}</div>}

      {cameras.length === 0 ? (
        <div className="notice">
          <b>No camera zones configured yet.</b><br />
          Admin-la oru dustbin zone create pannunga — avlodhu camera card inga varum.
          Phone-la Monitor page open vachu camera&nbsp;<b>Start</b> pannina feed inga Live-la varum. 📱→🖥️
        </div>
      ) : (
        <div className="live-grid">
          {cameras.map((cam) => (
            <LiveCard key={cam.cameraId} cam={cam} zone={zoneMap.get(cam.cameraId) || null} tick={tick} />
          ))}
        </div>
      )}

      <p className="muted">
        {cameras.length
          ? `${cameras.length} camera${cameras.length > 1 ? 's' : ''} configured — those streaming show LIVE. Frames expire after 60s without contact.`
          : 'No camera zones configured.'}
      </p>
    </div>
  );
}