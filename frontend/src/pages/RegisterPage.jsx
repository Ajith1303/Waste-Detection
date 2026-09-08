import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Resident Registration & Management:
 * - Simple registration form capturing: name, email, phone (optional), zone.
 * - Displays registered residents for the community / admin.
 */
export default function RegisterPage() {
  const [zones, setZones] = useState([]);
  const [residents, setResidents] = useState([]);
  const [form, setForm] = useState({ name: '', email: '', phone: '', zoneId: '' });
  const [msg, setMsg] = useState({ ok: '', err: '' });
  const [loading, setLoading] = useState(false);

  const loadData = async () => {
    try {
      const [zList, rList] = await Promise.all([api.getZones(), api.getResidents()]);
      setZones(zList);
      setResidents(rList);
      if (zList.length > 0 && !form.zoneId) {
        setForm((f) => ({ ...f, zoneId: String(zList[0].id) }));
      }
    } catch (e) {
      setMsg((m) => ({ ...m, err: e.message }));
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setMsg({ ok: '', err: '' });

    if (!form.name.trim() || !form.email.trim()) {
      setMsg({ err: 'Name and email are required.' });
      return;
    }
    if (form.phone && form.phone.trim() && !/^\+?[0-9\s-]{8,15}$/.test(form.phone.trim())) {
      setMsg({ err: 'Enter a valid mobile number (8-15 digits, optional +country code).' });
      return;
    }

    setLoading(true);
    try {
      const res = await api.registerResident({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone ? form.phone.trim() : undefined,
        zoneId: form.zoneId ? Number(form.zoneId) : undefined,
      });
      setMsg({ ok: `Registered successfully as resident #${res.id}. You will receive email/SMS alerts for ${res.zone_name || 'your zone'}.` });
      setForm((prev) => ({ ...prev, name: '', email: '', phone: '' }));
      await loadData();
    } catch (err) {
      setMsg({ err: err.message });
    } finally {
      setLoading(false);
    }
  };

  const deleteResident = async (id, name) => {
    if (!window.confirm(`Remove resident "${name}"?`)) return;
    try {
      await api.deleteResident(id);
      setMsg({ ok: `Removed resident "${name}".` });
      await loadData();
    } catch (err) {
      setMsg({ err: err.message });
    }
  };

  return (
    <div>
      <h1>📝 Resident & Community Registration</h1>

      {msg.ok && <div className="notice ok">{msg.ok}</div>}
      {msg.err && <div className="notice err">{msg.err}</div>}

      <div className="grid-2">
        <div className="card">
          <h2>Register for Alerts</h2>
          <p className="muted">
            Register to receive automated email & SMS notifications whenever illegal waste dumping
            is detected in your neighborhood.
          </p>

          <form onSubmit={submit}>
            <label>Full Name *</label>
            <input value={form.name} onChange={set('name')} placeholder="e.g. Priya Sharma" required />

            <label>Email Address * (primary alert channel)</label>
            <input type="email" value={form.email} onChange={set('email')} placeholder="priya.sharma@example.com" required />

            <label>Mobile Number (optional for SMS)</label>
            <input value={form.phone} onChange={set('phone')} placeholder="+91 98765 43210" />

            <label>Locality / Zone *</label>
            <select value={form.zoneId} onChange={set('zoneId')} required>
              {zones.length === 0 ? (
                <option value="">No zones configured yet</option>
              ) : (
                zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} — {z.area}
                  </option>
                ))
              )}
            </select>

            <div style={{ marginTop: 16 }}>
              <button className="btn primary" type="submit" disabled={loading || zones.length === 0}>
                {loading ? 'Registering…' : 'Register for Alerts'}
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <h2>Registered Residents ({residents.length})</h2>
          {residents.length === 0 ? (
            <p className="muted">No residents registered yet. Fill out the form to add the first one.</p>
          ) : (
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {residents.map((r) => (
                <div key={r.id} className="zone-item" style={{ alignItems: 'center' }}>
                  <div>
                    <strong>{r.name}</strong>
                    <div className="muted" style={{ fontSize: 12 }}>
                      📧 {r.email} {r.phone ? `· 📱 ${r.phone}` : ''}
                    </div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      📍 {r.zone_name}
                    </div>
                  </div>
                  <button className="btn sm danger" onClick={() => deleteResident(r.id, r.name)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}