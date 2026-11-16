import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, isPriorityAlert, jsonRequest, signalLabel, sortAlertsByPriority, statusLabel, zoneLabel } from "../api.js";
import { useAuth } from "../auth.js";
import Dropdown from "../components/Dropdown.jsx";
import { MotionButton, MotionLink } from "../motion.jsx";
import { LoadingBlock, PageHeading, StateBlock } from "./OverviewPage.jsx";
import EvacuationAdvisory from "../components/EvacuationAdvisory.jsx";

export default function IncidentsPage() {
  const { user } = useAuth();
  const [search, setSearch] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [recording, setRecording] = useState(null);
  const [recordingError, setRecordingError] = useState("");
  const zoneId = search.get("zone") || "all";
  const typeId = search.get("type") || "all";
  const shiftId = search.get("shift") || "all";
  const query = search.get("q") || "";
  const filter = search.get("status") || (search.get("selected") ? "all" : "open");
  const selectedId = search.get("selected") || "";

  const refresh = useCallback(async () => {
    const result = await api("/api/dashboard");
    setData(result);
    setError("");
  }, []);
  useEffect(() => {
    let mounted = true;
    const load = () => api("/api/dashboard").then((result) => { if (mounted) { setData(result); setError(""); } }).catch((reason) => { if (mounted) setError(reason.message); });
    load();
    const timer = window.setInterval(load, 5000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { setRecording(null); setRecordingError(""); }, [selectedId]);

  const events = useMemo(() => {
    if (!data) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchingEvents = data.incidents.filter((event) => {
      const zoneMatch = zoneId === "all" || event.zoneId === zoneId;
      const statusMatch = filter === "all" || event.status === "open" || (filter === "open" && event.status === "acknowledged");
      const typeMatch = typeId === "all" || event.type === typeId;
      const shiftMatch = shiftId === "all" || (event.shift || "Unassigned") === shiftId;
      const textMatch = !normalizedQuery || [event.id, event.description, signalLabel[event.type], zoneLabel(data.zones, event.zoneId), event.cameraName, event.workerId]
        .some((value) => String(value || "").toLocaleLowerCase().includes(normalizedQuery));
      return zoneMatch && statusMatch && typeMatch && shiftMatch && textMatch;
    });
    return sortAlertsByPriority(matchingEvents);
  }, [data, filter, query, shiftId, typeId, zoneId]);
  const selected = events.find((event) => event.id === selectedId) ?? events[0] ?? null;

  function updateSearch(changes) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key);
    setSearch(next, { replace: true });
  }

  async function perform(action) {
    if (!selected) return;
    setBusy(true);
    setNotice("");
    try {
      await api("/api/incidents/" + selected.id + "/review", jsonRequest("POST", { action }));
      await refresh();
      setNotice(action === "acknowledge" ? "Signal acknowledged. It remains unconfirmed until safety review." : action === "confirm" ? "Review status updated after a human decision." : action === "clear-evacuation" ? "Evacuation advisory cleared after the safety check." : "Signal dismissed after human review.");
    } catch (reason) {
      setNotice(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetAllIncidents() {
    if (!user.permissions.resetDemo || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const result = await api("/api/incidents", { method: "DELETE" });
      setConfirmReset(false);
      updateSearch({ zone: "", type: "", shift: "", q: "", status: "open", selected: "" });
      await refresh();
      const count = Number(result.removed) || 0;
      setNotice(`${count} incident alert${count === 1 ? "" : "s"} cleared, along with related recordings and notifications.`);
    } catch (reason) {
      setNotice(reason.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadRecording() {
    if (!selected) return;
    setRecordingError("");
    setRecording({ loading: true });
    try {
      setRecording(await api(`/api/incidents/${encodeURIComponent(selected.id)}/recording`));
    } catch (reason) {
      setRecording(null);
      setRecordingError(reason.message);
    }
  }

  if (error && !data) return <StateBlock title="Incident queue unavailable" detail={error} />;
  if (!data) return <LoadingBlock />;
  const current = selected;
  const canResetIncidents = user.permissions.resetDemo;
  const canAcknowledge = user.permissions.acknowledge && current?.status === "open";
  const canResolve = user.permissions.confirm && current?.status === "acknowledged";

  return (
    <div className="page-content incident-page" id="incidents">
      <PageHeading kicker="Event review / human decision" title="Incident queue" subtitle="Filter camera and sensor alerts, then review the source and context. An alert is not a confirmed incident." aside={<div className="incident-heading-actions"><span className="page-stamp"><i /> {data.incidents.length} recorded alerts</span>{canResetIncidents && <MotionButton className="button button--danger incident-reset-trigger" type="button" onClick={() => { setConfirmReset((open) => !open); setNotice(""); }}>Reset all incidents</MotionButton>}</div>} />
      <EvacuationAdvisory advisory={data.evacuationAdvisory} />
      <section className="queue-tools" aria-label="Incident filters">
        <div className="filter-cluster">
          <Dropdown id="signal-type-filter" className="incident-filter-select" value={typeId} onChange={(event) => updateSearch({ type: event.target.value === "all" ? "" : event.target.value, selected: "" })} options={[{ value: "all", label: "All alert types" }, ...Object.entries(signalLabel).map(([value, label]) => ({ value, label }))]} aria-label="Filter by alert type" />
          <Dropdown id="zone-filter" className="incident-filter-select" value={zoneId} onChange={(event) => updateSearch({ zone: event.target.value === "all" ? "" : event.target.value, selected: "" })} options={[{ value: "all", label: "All areas" }, ...data.zones.map((zone) => ({ value: zone.id, label: zone.name }))]} aria-label="Filter by area" />
          <Dropdown id="shift-filter" className="incident-filter-select" value={shiftId} onChange={(event) => updateSearch({ shift: event.target.value === "all" ? "" : event.target.value, selected: "" })} options={[{ value: "all", label: "All shifts" }, ...["Morning shift", "Evening shift", "Night shift", "Unassigned"].map((shift) => ({ value: shift, label: shift }))]} aria-label="Filter by duty shift" />
          <input id="incident-search" className="control incident-search" type="search" value={query} onChange={(event) => updateSearch({ q: event.target.value, selected: "" })} placeholder="Search ID, worker, or description" aria-label="Search alerts by ID, worker, or description" />
          <div className="segmented-control" role="group" aria-label="Incident status filter">
            <MotionButton type="button" className={filter === "open" ? "is-active" : ""} aria-pressed={filter === "open"} onClick={() => updateSearch({ status: "open", selected: "" })}>Needs review</MotionButton>
            <MotionButton type="button" className={filter === "all" ? "is-active" : ""} aria-pressed={filter === "all"} onClick={() => updateSearch({ status: "all", selected: "" })}>All events</MotionButton>
          </div>
          {(zoneId !== "all" || typeId !== "all" || shiftId !== "all" || query || filter !== "open") && <MotionButton className="text-button filter-reset" type="button" onClick={() => updateSearch({ zone: "", type: "", shift: "", q: "", status: "open", selected: "" })}>Reset filters</MotionButton>}
        </div>
      </section>
      {confirmReset && canResetIncidents && <section className="incident-reset-confirm" aria-labelledby="incident-reset-title">
        <div><strong id="incident-reset-title">Clear all recorded incidents?</strong><p>This removes {data.incidents.length} alert{data.incidents.length === 1 ? "" : "s"} and their related recordings and notifications. This action cannot be undone.</p></div>
        <div className="incident-reset-confirm__actions"><MotionButton className="button button--danger" type="button" disabled={busy} onClick={resetAllIncidents}>{busy ? "Clearing…" : "Clear all incidents"}</MotionButton><MotionButton className="button button--quiet" type="button" disabled={busy} onClick={() => setConfirmReset(false)}>Cancel</MotionButton></div>
      </section>}
      {notice && <p id="announcer" className="notice-line" role="status">{notice}</p>}
      <div className="incident-workspace">
        <section className="queue-list-panel" aria-labelledby="queue-title">
          <div className="queue-list-heading"><div className="queue-title-row"><h2 id="queue-title">Signals</h2><span id="queue-count" className="heading-count">{events.length.toString().padStart(2, "0")}</span></div><span id="queue-context" className="queue-sort">{zoneId === "all" ? "All assigned zones" : zoneLabel(data.zones, zoneId)} / {filter === "open" ? "Needs review" : "All events"}</span></div>
          <div className="queue-records" id="incident-list" role="list">
            {events.map((event) => <MotionButton className={"queue-record" + (selected?.id === event.id ? " is-selected" : "") + (isPriorityAlert(event) ? " queue-record--critical" : "")} key={event.id} type="button" role="listitem" aria-current={selected?.id === event.id ? "true" : undefined} onClick={() => updateSearch({ selected: event.id })}>
              <span className="queue-record__top"><span className={"event-mark" + (isPriorityAlert(event) ? " event-mark--critical" : "")} /><span>{event.id}</span>{isPriorityAlert(event) && <span className="alert-priority-chip">Critical</span>}<time>{event.time}</time></span>
              <strong>{signalLabel[event.type]}</strong>
              <span className="queue-record__bottom"><span>{zoneLabel(data.zones, event.zoneId)}</span><span className={"state-chip state-chip--" + event.status}>{statusLabel[event.status]}</span></span>
            </MotionButton>)}
            {!events.length && <div id="queue-empty" className="empty-state"><span className="empty-state__symbol">∅</span><strong>No alerts match these filters</strong><p>Adjust the alert type, area, shift, status, or search to widen this view.</p></div>}
          </div>
        </section>
        <section className="incident-detail" aria-labelledby="record-title">
          {!current ? <div className="empty-detail"><h2 id="record-title">Select a signal</h2><p>Source, context, and review history will appear here.</p></div> : <>
            <div className="detail-heading">
              <div><p id="record-id" className="section-context">Record detail / {current.id}</p><h2 id="record-title"><span id="record-type">{signalLabel[current.type]}</span></h2></div>
              <div className="detail-controls">{isPriorityAlert(current) && <span className="alert-priority-chip">Fire / smoke priority</span>}<span id="record-status" className={"state-chip state-chip--" + current.status}>{statusLabel[current.status]}</span><MotionButton className="button button--quiet" type="button" onClick={loadRecording}>View incident recording</MotionButton></div>
            </div>
            {recordingError && <p className="recording-error" role="status">{recordingError}</p>}
            {recording && <IncidentRecording recording={recording} />}
            <div className="signal-origin"><span className="origin-glyph">S</span><div><strong>{current.source === "operator-report" ? "Worker report" : current.source === "device" ? "Connected sensor" : "Automated signal"}</strong><small>Detector input / not independently verified</small></div></div>
            <p id="record-description" className="incident-description">{current.description}</p>
            <dl className="detail-metadata">
              <div><dt>Zone</dt><dd id="record-zone">{zoneLabel(data.zones, current.zoneId)}</dd></div><div><dt>Duty shift</dt><dd id="record-shift">{current.shift || "Unassigned"}</dd></div><div><dt>Source device</dt><dd id="record-device" className="numeric-cell">{current.deviceId}</dd></div>
              <div><dt>Worker reference</dt><dd id="record-worker" className="numeric-cell">{current.workerId || "Not linked"}</dd></div><div><dt>Received</dt><dd id="record-time" className="numeric-cell">{current.time} local</dd></div>
            </dl>
            <section className="trail-section" aria-labelledby="trail-heading"><div className="detail-section-heading"><h3 id="trail-heading">Review trail</h3><span>{current.trail.length.toString().padStart(2, "0")} entries</span></div>
              <ol id="record-trail" className="trail-list">{current.trail.map((entry, index) => <li key={index} className={entry.kind === "person" ? "trail-entry trail-entry--person" : "trail-entry"}><span className="trail-marker" /><div><div className="trail-entry__head"><strong>{entry.actor}</strong><time>{entry.time}</time></div><p>{entry.detail}</p></div></li>)}</ol>
            </section>
            <div className="review-actions">
              {canAcknowledge && <MotionButton id="acknowledge-alert" className="button button--primary" disabled={busy} onClick={() => perform("acknowledge")}>Acknowledge signal <span>↗</span></MotionButton>}
              {canResolve && <><MotionButton id="confirm-incident" className="button button--primary" disabled={busy} onClick={() => perform("confirm")}>Confirm incident <span>↗</span></MotionButton><MotionButton id="dismiss-alert" className="button button--quiet" disabled={busy} onClick={() => perform("dismiss")}>Dismiss signal</MotionButton></>}
              {user.permissions.confirm && isPriorityAlert(current) && !current.evacuationClearedAt && <MotionButton id="clear-evacuation-advisory" className="button button--quiet" disabled={busy} onClick={() => perform("clear-evacuation")}>Clear evacuation advisory after site check</MotionButton>}
              {!canAcknowledge && !canResolve && <p id="role-note" className="permission-note">{current.status === "open" ? (user.role === "Operator" ? "This account can view this signal but cannot acknowledge it." : "No review action is available for this state.") : current.status === "acknowledged" ? "A worker acknowledged this signal. Safety review is still required." : "This record has been reviewed. Its detector source remains in the trail."}</p>}
            </div>
          </>}
        </section>
      </div>
      <LocalPreview />
    </div>
  );
}

function IncidentRecording({ recording }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !recording.videoUrl) return undefined;
    const seekToIncident = () => {
      const maxTime = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : recording.startSeconds;
      video.currentTime = Math.min(recording.startSeconds, maxTime);
    };
    video.addEventListener("loadedmetadata", seekToIncident);
    if (video.readyState >= 1) seekToIncident();
    return () => video.removeEventListener("loadedmetadata", seekToIncident);
  }, [recording.videoUrl, recording.startSeconds]);

  const segmentEnd = Math.min(recording.startSeconds + recording.durationSeconds, recording.clipDurationSeconds || Number.POSITIVE_INFINITY);
  return <section className="incident-recording" aria-label="Incident recording">
    <div className="incident-recording__heading"><strong>{recording.camera?.name || "Camera recording"} / {recording.camera?.id || "camera unavailable"}</strong><span>Captured around the detector signal</span></div>
    {recording.videoUrl ? <div className="incident-recording__frame">
      <video ref={videoRef} src={recording.videoUrl} poster={recording.posterUrl || "/video-preview-poster.svg"} controls playsInline preload="metadata" onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= segmentEnd) event.currentTarget.pause(); }} aria-label={`Recording for incident ${recording.incidentId}`} />
      {recording.overlay && <span className="incident-recording__outline" style={{ left: `${recording.overlay.x * 100}%`, top: `${recording.overlay.y * 100}%`, width: `${recording.overlay.width * 100}%`, height: `${recording.overlay.height * 100}%` }}><b>{recording.overlaySource === "ai" || recording.overlaySource === "model" ? "Model detection" : "Sensor detection"}</b></span>}
    </div> : <div className="incident-recording__empty"><p>{recording.message || "No recording source is configured for this camera."}</p><MotionLink className="text-link" to="/live-feed">Open camera feeds ↗</MotionLink></div>}
  </section>;
}

function LocalPreview() {
  const [items, setItems] = useState([]);
  function change(event) {
    const files = [...event.target.files].slice(0, 4);
    setItems(files.map((file) => ({ name: file.name, type: file.type, url: URL.createObjectURL(file) })));
  }
  useEffect(() => () => items.forEach((item) => URL.revokeObjectURL(item.url)), [items]);
  return <section id="input-preview" className="local-preview" aria-labelledby="input-title"><div className="local-preview__copy"><p className="section-context">Optional / device preview</p><h2 id="input-title">Inspect a local file</h2><p id="file-note">Preview an image or video on this device. Files are not uploaded or analyzed.</p></div>
    <label className="button button--quiet file-pick">Choose files<input id="evidence-file" type="file" accept="image/*,video/*" multiple aria-describedby="file-note file-message" onChange={change} /></label>
    <div id="file-message" className="visually-hidden" aria-live="polite">{items.length ? items.length + " file previews ready." : "No file selected."}</div>
    <div id="evidence-preview" className="preview-grid" hidden={!items.length}>{items.map((item) => <figure key={item.url}>{item.type.startsWith("video/") ? <video controls poster="/video-preview-poster.svg" src={item.url} /> : <img src={item.url} alt={"Local preview: " + item.name} />}<figcaption>{item.name}</figcaption></figure>)}</div>
  </section>;
}
