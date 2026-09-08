import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import ZoneDrawer from '../components/ZoneDrawer';

/**
 * Admin Zone Configuration & Corporation Contacts:
 *  - upload a reference snapshot of the dustbin location,
 *  - drag a box around the dustbin (normalized 0..1 => resolution independent),
 *  - create the zone + shop-area and corporation admin contact,
 *  - edit / delete existing zones,
 *  - manage admin/corporation contacts.
 */
export default function ZoneConfigPage() {
  const [zones, setZones] = useState([]);
  const [admins, setAdmins] = useState([]);
  const [form, setForm] = useState({ name: '', area: '', cameraId: '', adminEmail: '' });
  const [adminForm, setAdminForm] = useState({ name: '', email: '', phone: '', zoneId: '' });
  const [refImage, setRefImage] = useState('');
  const [draftBox, setDraftBox] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState({ ok: '', err: '' });
  const fileRef = useRef(null);

  const reload = async () => {
    try {
      const [zList, aList] = await Promise.all([api.getZones(), api.getAdmins()]);
      setZones(zList);
      setAdmins(aList);
    } catch (e) {
      setMsg({ ok: '', err: e.message });
    }
  };

  useEffect(() => { reload(); }, []);

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      setMsg({ ok: '', err: '' });
      setEditingId(null);
      setRefImage(fr.result);
      setDraftBox({ x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 });
    };
    fr.readAsDataURL(f);
  };

  const set = (k) => (ev) => setForm((f) => ({ ...f, [k]: ev.target.value }));

  const validate = () => {
    if (!form.name.trim() || !form.area.trim()) return 'Name and area are required.';
    if (!draftBox) return 'Draw the dustbin zone box on the snapshot first.';
    if (draftBox.x2 - draftBox.x1 < 0.02 || draftBox.y2 - draftBox.y1 < 0.02) return 'Zone box is too small.';
    return '';
  };

  const createZone = async () => {
    setMsg({ ok: '', err: '' });
    const err = validate();
    if (err) { setMsg({ err }); return; }
    setSaving(true);
    try {
      const created = await api.createZone({
        name: form.name.trim(),
        area: form.area.trim(),
        cameraId: form.cameraId.trim(),
        zoneBox: draftBox,
        referenceImageBase64: refImage || undefined,
        admin: form.adminEmail ? { email: form.adminEmail.trim() } : undefined,
      });
      setMsg({ ok: `Zone "${created.name}" created with camera "${created.camera_id}".` });
      setForm({ name: '', area: '', cameraId: '', adminEmail: '' });
      setRefImage(''); setDraftBox(null);
      if (fileRef.current) fileRef.current.value = '';
      await reload();
    } catch (e) {
      setMsg({ err: e.message });
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    const zone = zones.find((z) => String(z.id) === String(editingId));
    setMsg({ ok: '', err: '' });
    const err = validate();
    if (!zone) { setMsg({ err: 'Zone disappeared. Reload the page.' }); return; }
    if (err) { setMsg({ err }); return; }
    setSaving(true);
    try {
      const updated = await api.updateZone(zone.id, { name: form.name, area: form.area, zoneBox: draftBox });
      setMsg({ ok: `Zone "${updated.name}" updated successfully.` });
      setEditingId(null); setDraftBox(null); setRefImage('');
      setForm({ name: '', area: '', cameraId: '', adminEmail: '' });
      if (fileRef.current) fileRef.current.value = '';
      await reload();
    } catch (e) {
      setMsg({ err: e.message });
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (zone) => {
    setEditingId(zone.id);
    setMsg({ ok: '', err: '' });
    setForm({ name: zone.name, area: zone.area, cameraId: zone.camera_id, adminEmail: '' });
    setDraftBox({ ...zone.zone_box });
    setRefImage(zone.reference_image_base64 || '');
    if (fileRef.current) fileRef.current.value = '';
  };

  const delZone = async (zone) => {
    if (!window.confirm(`Delete zone "${zone.name}"? Past events will remain linked.`)) return;
    try {
      await api.deleteZone(zone.id);
      setMsg({ ok: `Zone "${zone.name}" deleted.` });
      await reload();
    } catch (e) { setMsg({ err: e.message }); }
  };

  const addAdmin = async (e) => {
    e.preventDefault();
    setMsg({ ok: '', err: '' });
    if (!adminForm.name.trim() || !adminForm.email.trim()) {
      setMsg({ err: 'Admin name and email are required.' });
      return;
    }
    try {
      await api.createAdmin({
        name: adminForm.name.trim(),
        email: adminForm.email.trim(),
        phone: adminForm.phone ? adminForm.phone.trim() : undefined,
        zoneId: adminForm.zoneId ? Number(adminForm.zoneId) : undefined,
      });
      setMsg({ ok: `Contact "${adminForm.name}" added.` });
      setAdminForm({ name: '', email: '', phone: '', zoneId: '' });
      await reload();
    } catch (err) { setMsg({ err: err.message }); }
  };

  const delAdmin = async (id, name) => {
    if (!window.confirm(`Remove admin contact "${name}"?`)) return;
    try {
      await api.deleteAdmin(id);
      setMsg({ ok: `Removed "${name}".` });
      await reload();
    } catch (err) { setMsg({ err: err.message }); }
  };

  const setAdm = (k) => (ev) => setAdminForm((f) => ({ ...f, [k]: ev.target.value }));
  const editing = zones.find((z) => String(z.id) === String(editingId));

  return (
    <div>
      <h1>Dustbin Zone and Admin Setup</h1>

      {msg.ok && <div className="notice ok">{msg.ok}</div>}
      {msg.err && <div className="notice err">{msg.err}</div>}

      <div className="grid-2">
        <div className="card">
          <h2>{editing ? `Edit zone: ${editing.name}` : 'Create a new zone'}</h2>

          <label>Reference snapshot (picture of the dustbin area)</label>
          <input ref={fileRef} type="file" accept="image/*" onChange={onFile} />

          <div style={{ marginTop: 10 }}>
            <ZoneDrawer imageDataUrl={refImage} box={draftBox} onChange={setDraftBox} />
          </div>

          {draftBox && (
            <p className="muted">
              Zone box: x {draftBox.x1.toFixed(3)}-{draftBox.x2.toFixed(3)} y {draftBox.y1.toFixed(3)}-{draftBox.y2.toFixed(3)}
            </p>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <div className="grow"><label>Zone name</label>
              <input value={form.name} onChange={set('name')} placeholder="e.g. Main Gate Dustbin" /></div>
            <div className="grow"><label>Area / ward</label>
              <input value={form.area} onChange={set('area')} placeholder="e.g. Ward 12 - MG Road" /></div>
          </div>
          <div className="row">
            <div className="grow"><label>Camera ID</label>
              <input value={form.cameraId} onChange={set('cameraId')} placeholder="e.g. cam-mgrd-01"
                disabled={!!editing} /></div>
            <div className="grow"><label>Admin email (optional)</label>
              <input type="email" value={form.adminEmail} onChange={set('adminEmail')} placeholder="corporation@example.com" /></div>
          </div>

          <div style={{ marginTop: 14 }} className="row">
            {editing ? (
              <>
                <button className="btn primary" disabled={saving} onClick={saveEdit}>{saving ? 'Saving...' : 'Save changes'}</button>
                <button className="btn gray" disabled={saving}
                  onClick={() => { setEditingId(null); setDraftBox(null); setRefImage(''); setForm({ name: '', area: '', cameraId: '', adminEmail: '' }); }}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn primary" disabled={saving} onClick={createZone}>{saving ? 'Creating...' : 'Create zone'}</button>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Existing zones ({zones.length})</h2>
          {zones.length === 0 && <p className="muted">No zones yet - create your first one on the left.</p>}
          {zones.map((zone) => (
            <div key={zone.id} className="zone-item">
              <div style={{ maxWidth: 480 }}>
                <strong>{zone.name}</strong> - {zone.area}<br />
                <code>{zone.camera_id}</code>
                <div className="muted" style={{ fontSize: 12 }}>
                  box {zone.zone_box.x1.toFixed(2)}-{zone.zone_box.x2.toFixed(2)} /
                  {zone.zone_box.y1.toFixed(2)}-{zone.zone_box.y2.toFixed(2)} |
                  {zone.resident_count} residents | {zone.admin_count} admin(s)
                </div>
              </div>
              <div className="row">
                <button className="btn sm gray" onClick={() => startEdit(zone)}>Edit</button>
                <button className="btn sm danger" onClick={() => delZone(zone)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 24 }}>
        <h2>Corporation and Admin Contacts ({admins.length})</h2>
        <p className="muted">
          Admin contacts receive alert emails and SMS whenever a dustbin is reported full or illegal dumping occurs.
          A contact with no zone assigned acts as the city-wide fallback contact.
        </p>
        <form onSubmit={addAdmin} className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ minWidth: 160 }}>
            <label>Name *</label>
            <input value={adminForm.name} onChange={setAdm('name')} placeholder="e.g. Ward Officer" required />
          </div>
          <div style={{ minWidth: 200 }}>
            <label>Email *</label>
            <input type="email" value={adminForm.email} onChange={setAdm('email')} placeholder="officer@corp.gov.in" required />
          </div>
          <div style={{ minWidth: 140 }}>
            <label>Phone</label>
            <input value={adminForm.phone} onChange={setAdm('phone')} placeholder="+91 90000 00000" />
          </div>
          <div style={{ minWidth: 180 }}>
            <label>Assigned Zone</label>
            <select value={adminForm.zoneId} onChange={setAdm('zoneId')}>
              <option value="">All Zones (Global Fallback)</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name} ({z.area})</option>
              ))}
            </select>
          </div>
          <div>
            <button className="btn primary" type="submit">Add Admin Contact</button>
          </div>
        </form>
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          {admins.length === 0 && <p className="muted">No admin contacts yet. Add one above.</p>}
          {admins.map((a) => (
            <div key={a.id} className="zone-item" style={{ alignItems: 'center' }}>
              <div>
                <strong>{a.name}</strong> -{' '}
                <span className="muted">{a.zone_name ? `Zone: ${a.zone_name}` : 'Global Fallback Contact'}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  {a.email}{a.phone ? ` | ${a.phone}` : ''}
                </div>
              </div>
              <button className="btn sm danger" onClick={() => delAdmin(a.id, a.name)}>Remove</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
