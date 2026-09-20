import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const TYPE_META = {
  correct:  { label: 'Correct disposal', cls: 'badge-correct' },
  full:     { label: 'Dustbin full',     cls: 'badge-full' },
  illegal:  { label: 'Illegal dumping',  cls: 'badge-illegal' },
  near:     { label: 'Near bin',         cls: 'badge-near' },
};
const NOTIF_META = (s) => {
  if (s === 'sent') return { label: 'sent', cls: 'badge-sent' };
  if (s === 'console' || s === 'cooldown_skipped' || s === 'cooldown') return { label: s, cls: 'badge-cooldown_skipped' };
  if (s === 'failed') return { label: 'failed', cls: 'badge-failed' };
  if (s === 'not_triggered') return { label: 'no alert', cls: 'badge-no_waste' };
  return { label: s || '-', cls: 'badge-no_waste' };
};

function SnapshotModal({ url, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, zIndex:1000, background:'rgba(0,0,0,0.82)', display:'flex', alignItems:'center', justifyContent:'center', cursor:'zoom-out' }}>
      <img src={url} alt="Snapshot enlarged" onClick={(e) => e.stopPropagation()}
        style={{ maxWidth:'92vw', maxHeight:'88vh', borderRadius:8, boxShadow:'0 4px 40px #0008', cursor:'default' }} />
      <button onClick={onClose}
        style={{ position:'absolute', top:16, right:20, background:'rgba(255,255,255,0.15)', border:'none', color:'#fff', fontSize:24, borderRadius:6, cursor:'pointer', padding:'2px 12px', lineHeight:1.4 }}
        title="Close (Esc)">x</button>
    </div>
  );
}

export default function DashboardPage() {
  const [zones, setZones] = useState([]);
  const [stats, setStats] = useState(null);
  const [events, setEvents] = useState([]);
  const [filters, setFilters] = useState({ zoneId: '', type: '', from: '', to: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modalUrl, setModalUrl] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const loadStats = useCallback(() => { api.getStats().then(setStats).catch(() => {}); }, []);

  const loadEvents = useCallback(async (f) => {
    setLoading(true); setError('');
    try { setEvents(await api.getEvents(f)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { api.getZones().then(setZones).catch(() => {}); loadStats(); }, [loadStats]);
  useEffect(() => { loadEvents(filters); }, [filters, loadEvents]);

  const handleDelete = async (ev) => {
    if (!window.confirm(`Delete this event (ID ${ev.id}) and its snapshot? This cannot be undone.`)) return;
    setDeletingId(ev.id);
    try {
      await api.deleteEvent(ev.id);
      setEvents((prev) => prev.filter((e) => e.id !== ev.id));
    } catch (e) {
      alert(`Failed to delete: ${e.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const setFilter = (k) => (e) => setFilters((prev) => ({ ...prev, [k]: e.target.value }));
  const fmt = (iso) => {
    if (!iso) return '-';
    const d = new Date(String(iso).includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
    return d.toLocaleString();
  };

  return (
    <div>
      {modalUrl && <SnapshotModal url={modalUrl} onClose={() => setModalUrl(null)} />}

      <h1>Admin Dashboard</h1>

      <div className="stats-grid">
        <div className="stat"><div className="num">{stats ? stats.eventsToday : '-'}</div><div className="lbl">Events today</div></div>
        <div className="stat"><div className="num" style={{ color: '#b91c1c' }}>{stats ? stats.illegal : '-'}</div><div className="lbl">Illegal dumping</div></div>
        <div className="stat"><div className="num" style={{ color: '#b45309' }}>{stats ? stats.full : '-'}</div><div className="lbl">Dustbin full</div></div>
        <div className="stat"><div className="num" style={{ color: '#15803d' }}>{stats ? stats.correct : '-'}</div><div className="lbl">Correct disposal</div></div>
        <div className="stat"><div className="num">{stats ? stats.zones : '-'}</div><div className="lbl">Zones</div></div>
        <div className="stat"><div className="num">{stats ? stats.residents : '-'}</div><div className="lbl">Residents</div></div>
      </div>

      <div className="card">
        <div className="row">
          <label>Zone</label>
          <select style={{ width: 210 }} value={filters.zoneId} onChange={setFilter('zoneId')}>
            <option value="">All zones</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <label>Type</label>
          <select style={{ width: 160 }} value={filters.type} onChange={setFilter('type')}>
            <option value="">All types</option>
            {Object.entries(TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
          </select>
          <label>From</label>
          <input type="date" style={{ width: 150 }} value={filters.from} onChange={setFilter('from')} />
          <label>To</label>
          <input type="date" style={{ width: 150 }} value={filters.to} onChange={setFilter('to')} />
          <button className="btn gray" onClick={() => setFilters({ zoneId: '', type: '', from: '', to: '' })}>Reset</button>
        </div>
        {loading && <p className="muted">Loading...</p>}
        {error && <div className="notice err">{error}</div>}
      </div>

      <div className="card">
        <h2>Detection events {events.length ? `(${events.length})` : ''}</h2>
        {events.length === 0 ? (
          <p className="muted">No events match the current filters.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="events">
              <thead>
                <tr>
                  <th>Snapshot</th><th>Time</th><th>Zone</th><th>Type</th>
                  <th>Objects</th><th>Fill est.</th><th>GPS</th><th>Notification</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>
                      {ev.snapshotUrl ? (
                        <img className="thumb" src={ev.snapshotUrl} alt={`event ${ev.id}`} loading="lazy"
                          title="Click to enlarge" style={{ cursor: 'zoom-in' }}
                          onClick={() => setModalUrl(ev.snapshotUrl)} />
                      ) : <span className="muted">-</span>}
                    </td>
                    <td>{fmt(ev.created_at)}</td>
                    <td>{ev.zone_name || 'deleted zone'}<br /><span className="muted">{ev.camera_id}</span></td>
                    <td>
                      <span className={`badge ${(TYPE_META[ev.classification] || {}).cls || 'badge-no_waste'}`}>
                        {(TYPE_META[ev.classification] || { label: ev.classification }).label}
                      </span>
                      {ev.classification === 'illegal' || ev.classification === 'full' ? (
                        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{ev.reason}</div>
                      ) : null}
                    </td>
                    <td>{ev.object_count}</td>
                    <td>{ev.fill_estimate != null ? `${Math.round(ev.fill_estimate * 100)}%` : '-'}</td>
                    <td>
                      {ev.gps_lat != null ? (
                        <a target="_blank" rel="noreferrer"
                          href={`https://www.google.com/maps?q=${ev.gps_lat},${ev.gps_lng}`}
                          style={{ fontSize: 12 }}>
                          {ev.gps_lat.toFixed(4)}, {ev.gps_lng.toFixed(4)}
                        </a>
                      ) : <span className="muted">-</span>}
                    </td>
                    <td>
                      <span className={`badge ${NOTIF_META(ev.notification_status).cls}`}>
                        {NOTIF_META(ev.notification_status).label}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn danger sm"
                        title="Delete this event"
                        disabled={deletingId === ev.id}
                        onClick={() => handleDelete(ev)}
                      >
                        {deletingId === ev.id ? '…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
