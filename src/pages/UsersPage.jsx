import { useEffect, useState } from "react";
import { api, jsonRequest, zoneLabel } from "../api.js";
import { LoadingBlock, PageHeading, StateBlock } from "./OverviewPage.jsx";
import Dropdown from "../components/Dropdown.jsx";
import { MotionButton, MotionRow } from "../motion.jsx";
import { AnimatePresence, motion } from "motion/react";

const emptyForm = { username: "", displayName: "", role: "Operator", password: "", zoneIds: [], canAcknowledge: true };

export default function UsersPage() {
  const [data, setData] = useState(null);
  const [zones, setZones] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [userData, dashboard] = await Promise.all([api("/api/users"), api("/api/dashboard")]);
    setData(userData);
    setZones(dashboard.zones);
    setError("");
  }
  useEffect(() => { refresh().catch((reason) => setError(reason.message)); }, []);
  if (error && !data) return <StateBlock title="User access unavailable" detail={error} />;
  if (!data) return <LoadingBlock />;

  function beginCreate() {
    setEditing(null);
    setForm({ ...emptyForm, zoneIds: zones[0] ? [zones[0].id] : [] });
    setNotice("");
    setShowForm(true);
  }
  function beginEdit(target) {
    setEditing(target);
    setForm({ username: target.username, displayName: target.displayName, role: target.role, password: "", zoneIds: [...target.zoneIds], canAcknowledge: target.canAcknowledge });
    setNotice("");
    setShowForm(true);
  }
  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setForm(emptyForm);
  }
  function change(key, value) { setForm((current) => ({ ...current, [key]: value })); }
  function toggleZone(zoneId) {
    setForm((current) => ({ ...current, zoneIds: current.zoneIds.includes(zoneId) ? current.zoneIds.filter((value) => value !== zoneId) : [...current.zoneIds, zoneId] }));
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setNotice("");
    try {
      const payload = { ...form, zoneIds: form.role === "Operator" ? form.zoneIds : zones.map((zone) => zone.id) };
      if (editing) {
        await api("/api/users/" + editing.id, jsonRequest("PATCH", payload));
        setNotice("Access settings updated. Any prior session for this account was revoked after a role or password change.");
      } else {
        await api("/api/users", jsonRequest("POST", payload));
        setNotice("Operator account created. Share the temporary password securely.");
      }
      await refresh();
      closeForm();
    } catch (reason) {
      setNotice(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(target) {
    setBusy(true);
    setNotice("");
    try {
      await api("/api/users/" + target.id, jsonRequest("PATCH", { active: !target.active }));
      await refresh();
      setNotice(target.active ? "Account deactivated and its active sessions revoked." : "Account reactivated.");
    } catch (reason) {
      setNotice(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="page-content users-page">
    <PageHeading kicker="Administration / access control" title="User access" subtitle="Create operator and safety accounts, assign site coverage, and control review permissions." aside={<MotionButton className="button button--primary" onClick={beginCreate} type="button">Add account <span>＋</span></MotionButton>} />
    {notice && <p className="notice-line" role="status">{notice}</p>}
    <section className="access-overview" aria-label="Role access summary">
      <div><span className="access-number">01</span><div><h2>Operator</h2><p>View assigned zones. Acknowledge signals only when that permission is enabled.</p></div><span className="access-action">Scoped view</span></div>
      <div><span className="access-number">02</span><div><h2>Safety officer</h2><p>Review signals across the site, then confirm incidents or dismiss them.</p></div><span className="access-action">Site review</span></div>
      <div><span className="access-number">03</span><div><h2>Administrator</h2><p>Manage accounts and permissions, with full review access.</p></div><span className="access-action">User admin</span></div>
    </section>
    <section className="users-table-panel" aria-labelledby="users-heading">
      <div className="table-panel-heading"><div className="heading-group"><p className="section-context">Identity register</p><div className="heading-title-row"><h2 id="users-heading">Accounts</h2><span className="heading-count">{String(data.users.length).padStart(2, "0")}</span></div></div><span className="table-heading-note">Access updates apply on next request</span></div>
      <div className="data-table-wrap"><table className="data-table users-table"><thead><tr><th>Account</th><th>Role</th><th>Zone access</th><th>Review actions</th><th>Status</th><th><span className="visually-hidden">Management</span></th></tr></thead><tbody>
        {data.users.map((target) => {
          const isAdmin = target.role === "Administrator";
          const scope = isAdmin || target.role === "Safety officer" ? "All site zones" : target.zoneIds.map((id) => zoneLabel(zones, id)).join(", ");
          const actions = isAdmin || target.role === "Safety officer" ? "Acknowledge, confirm, dismiss" : target.canAcknowledge ? "Acknowledge assigned zones" : "View only";
          return <MotionRow key={target.id}>
            <td><span className="account-cell"><span className="avatar-mark">{target.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{target.displayName}</strong><small>@{target.username}</small></span></span></td>
            <td>{target.role}</td><td>{scope}</td><td className="access-cell">{actions}</td>
            <td><span className={"account-state" + (target.active ? "" : " is-inactive")}><i />{target.active ? "Active" : "Inactive"}</span></td>
            <td className="user-actions">{isAdmin ? <span className="protected-label">Protected</span> : <><MotionButton className="text-button" type="button" disabled={busy} onClick={() => beginEdit(target)}>Edit access</MotionButton><MotionButton className="text-button text-button--subtle" type="button" disabled={busy} onClick={() => toggleActive(target)}>{target.active ? "Deactivate" : "Reactivate"}</MotionButton></>}</td>
          </MotionRow>;
        })}
      </tbody></table></div>
    </section>
    <AnimatePresence initial={false}>{showForm && <motion.section className="user-editor" aria-labelledby="editor-heading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16, ease: "easeOut" }}>
      <div className="editor-heading"><div><p className="section-context">{editing ? "Account settings" : "New account"}</p><h2 id="editor-heading">{editing ? "Edit account access" : "Add an account"}</h2></div><MotionButton className="icon-button" type="button" aria-label="Close account form" onClick={closeForm}>×</MotionButton></div>
      <form className="user-form" onSubmit={save}>
        <div className="form-grid">
          {!editing && <Field label="Username" htmlFor="new-username"><input id="new-username" autoComplete="off" required minLength="3" maxLength="32" pattern="[A-Za-z0-9._-]+" value={form.username} onChange={(event) => change("username", event.target.value)} /></Field>}
          <Field label="Display name" htmlFor="display-name"><input id="display-name" required maxLength="80" value={form.displayName} onChange={(event) => change("displayName", event.target.value)} /></Field>
          <Field label="Role" htmlFor="account-role"><Dropdown id="account-role" value={form.role} onChange={(event) => change("role", event.target.value)} options={["Operator", "Safety officer"].map((role) => ({ value: role, label: role }))} /></Field>
          <Field label={editing ? "New password (optional)" : "Temporary password"} htmlFor="account-password"><input id="account-password" type="password" autoComplete="new-password" minLength={form.password ? 12 : undefined} required={!editing} value={form.password} onChange={(event) => change("password", event.target.value)} placeholder="At least 12 characters" /><small>Stored as a one-way password hash in this local demo.</small></Field>
        </div>
        {form.role === "Operator" && <>
          <fieldset className="zone-permissions"><legend>Assigned zones</legend><p>Operators only see incidents and devices in these zones.</p><div className="zone-checks">{zones.map((zone) => <motion.label key={zone.id} data-selected={form.zoneIds.includes(zone.id) ? "true" : undefined} whileHover={{ opacity: 0.92 }} transition={{ type: "tween", duration: 0.14, ease: "easeOut" }}><input type="checkbox" checked={form.zoneIds.includes(zone.id)} onChange={() => toggleZone(zone.id)} /><span>{zone.name}</span></motion.label>)}</div></fieldset>
          <label className="permission-toggle"><input type="checkbox" checked={form.canAcknowledge} onChange={(event) => change("canAcknowledge", event.target.checked)} /><span><strong>Allow acknowledgement</strong><small>Operators can move open signals to acknowledged. They cannot confirm or dismiss.</small></span></label>
        </>}
        {form.role === "Safety officer" && <p className="form-hint">Safety officers can review signals in every site zone and make final confirm or dismiss decisions.</p>}
        <div className="editor-actions"><MotionButton className="button button--primary" type="submit" disabled={busy}>{busy ? "Saving…" : editing ? "Save access" : "Create account"} <span>↗</span></MotionButton><MotionButton className="text-button" type="button" onClick={closeForm}>Cancel</MotionButton></div>
      </form>
    </motion.section>}</AnimatePresence>
    <div className="page-endnote"><span>Session changes <b>Take effect immediately</b></span><span>Local demo accounts reset when server restarts</span></div>
  </div>;
}

function Field({ label, htmlFor, children }) {
  return <div className="form-field"><label htmlFor={htmlFor}>{label}</label>{children}</div>;
}
