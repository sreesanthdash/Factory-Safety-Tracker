import { useCallback, useEffect, useRef, useState } from "react";
import { api, isPriorityAlert, sortAlertsByPriority, zoneLabel } from "../api.js";
import { useAuth } from "../auth.js";
import { useDevices } from "../DevicesContext.jsx";
import { LoadingBlock, PageHeading, StateBlock } from "./OverviewPage.jsx";
import { MotionButton, MotionLink } from "../motion.jsx";
import { motion, useReducedMotion } from "motion/react";
import EvacuationAdvisory from "../components/EvacuationAdvisory.jsx";

export default function LiveFeedPage() {
  const { user } = useAuth();
  const devices = useDevices();
  const [data, setData] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [error, setError] = useState("");
  const shift = data?.currentShift || "Checking site clock";
  const prefersReducedMotion = useReducedMotion();

  const refresh = useCallback(async () => {
    const [dashboard, cameraData, notificationData] = await Promise.all([api("/api/dashboard"), api("/api/cameras"), api("/api/notifications")]);
    setData({ ...cameraData, zones: dashboard.zones, currentShift: dashboard.currentShift, evacuationAdvisory: dashboard.evacuationAdvisory });
    setNotifications(sortAlertsByPriority(notificationData.notifications ?? []));
    setError("");
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const [dashboard, cameraData, notificationData] = await Promise.all([api("/api/dashboard"), api("/api/cameras"), api("/api/notifications")]);
        if (!mounted) return;
        setData({ ...cameraData, zones: dashboard.zones, currentShift: dashboard.currentShift, evacuationAdvisory: dashboard.evacuationAdvisory });
        setNotifications(sortAlertsByPriority(notificationData.notifications ?? []));
        setError("");
      } catch (reason) {
        if (mounted) setError(reason.message);
      }
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  if (error && !data) return <StateBlock title="Camera controls unavailable" detail={error} />;
  if (!data) return <LoadingBlock />;

  const localCameras = devices.cameras.map((camera) => ({ ...camera, zoneId: devices.zoneAssignments[camera.id] || user.zoneIds.find((id) => data.zones.some((zone) => zone.id === id)) || data.zones[0]?.id }));
  const groupedCameras = data.zones.map((zone) => ({ zone, cameras: localCameras.filter((camera) => camera.zoneId === zone.id) }));
  const inference = devices.inferenceStatus || data.inference;
  const activeCount = Object.keys(devices.streams).length;
  const monitorLabel = !user.permissions.analyzeCameras ? "view only" : !inference.enabled ? "setup required" : devices.monitoring ? "monitoring" : "paused";

  return <div className="page-content live-feed-page" id="live-feed">
    <PageHeading kicker="Local camera network / browser capture" title="Live CCTV feed" subtitle="Start every camera detected by this computer. Active feeds are analyzed automatically while this app session stays open." aside={<span className={"page-stamp" + (activeCount ? " page-stamp--live" : "")}><i /> {activeCount ? `${activeCount} camera${activeCount === 1 ? "" : "s"} · ${monitorLabel}` : `${localCameras.filter((camera) => camera.connected).length} cameras connected`}</span>} />
    <EvacuationAdvisory advisory={data.evacuationAdvisory} />
    <motion.section className="camera-controls" aria-label="Camera controls" whileHover={{ opacity: 0.99 }} transition={{ type: "tween", duration: 0.16, ease: "easeOut" }}>
      <div className="camera-controls__intro"><span className="camera-controls__icon">◎</span><div><strong>Automatic camera monitoring</strong><p>All available cameras start together. Sampled frames are analyzed about every second by configured local models. Keep this browser open and the computer awake for monitoring; browser capture cannot run with the app closed.</p></div></div>
      <div className="camera-controls__actions">
        <div className="camera-shift-control" aria-live="polite"><span>Duty shift · automatic</span><strong>{shift}</strong><small>06:00–14:00 / 14:00–22:00 / 22:00–06:00</small></div>
        <MotionButton className="button button--quiet" type="button" disabled={devices.cameraBusy} onClick={devices.scanCameras}>{devices.cameraBusy ? "Scanning…" : "Scan cameras"}</MotionButton>
        <MotionButton className="button button--primary" type="button" disabled={!localCameras.some((camera) => camera.connected && !devices.streams[camera.id]) || devices.cameraBusy} onClick={devices.startAllCameras}>{devices.cameraBusy ? "Starting cameras…" : activeCount ? "Start newly connected cameras" : "Start all cameras"}</MotionButton>
        {activeCount > 0 && <MotionButton className="button button--quiet" type="button" disabled={devices.cameraBusy} onClick={() => devices.stopCamera()}>{devices.monitoring ? "Stop all cameras" : "Close all feeds"}</MotionButton>}
      </div>
      {devices.cameraError && <p className="device-message device-message--error" role="status">{devices.cameraError}</p>}
    </motion.section>
    {!localCameras.length && <section className="camera-empty-state"><span>◎</span><h2>No local cameras found</h2><p>Scan to request camera permission and list cameras connected to this laptop. A phone must be exposed to Windows as a webcam before the browser can use it.</p><MotionButton className="button button--primary" type="button" disabled={devices.cameraBusy} onClick={devices.scanCameras}>Allow access and scan</MotionButton></section>}
    {localCameras.length > 0 && <div className="feed-layout">
      <div className="feed-areas">{groupedCameras.map(({ zone, cameras }, index) =>
        <motion.section className="feed-area" key={zone.id} aria-labelledby={`feed-area-${zone.id}`}>
        <div className="feed-area__heading"><div><span>Area 0{index + 1}</span><h2 id={`feed-area-${zone.id}`}>{zone.name}</h2></div><small>{String(cameras.filter((camera) => camera.connected).length).padStart(2, "0")} connected</small></div>
        <div className="camera-grid">{cameras.length ? cameras.map((camera) => <CameraTile key={camera.id} camera={camera} area={zone.name} stream={devices.streams[camera.id] || null} analysis={devices.cameraAnalysis[camera.id]} inference={inference} shift={shift} canAnalyze={user.permissions.analyzeCameras} monitoring={devices.monitoring} />) : <p className="feed-area__empty">No camera assigned to this area. Assign one in <MotionLink to="/devices">Device manager</MotionLink>.</p>}</div>
        </motion.section>)}</div>
      <aside className="feed-alerts" aria-labelledby="feed-alerts-title">
        <div className="feed-alerts__heading"><div><p className="section-context">In-app alert queue</p><h2 id="feed-alerts-title">Recent signals</h2></div><MotionLink className="text-link" to="/incidents">Open queue ↗</MotionLink></div>
        {notifications.length ? <ul>{notifications.slice(0, 8).map((item) => <li className={isPriorityAlert(item) ? "feed-alert--critical" : undefined} key={item.id}><span className={"feed-alerts__mark" + (isPriorityAlert(item) ? " feed-alerts__mark--critical" : "")} /><div>{isPriorityAlert(item) && <span className="alert-priority-chip">Critical</span>}<MotionLink to={`/incidents?selected=${encodeURIComponent(item.incidentId)}&status=all`}>{item.title}</MotionLink><p>{zoneLabel(data.zones, item.zoneId)} / {item.incidentId}</p></div><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ul> : <p className="feed-alerts__empty">No camera or sensor alerts have been recorded.</p>}
        <p className="feed-alerts__note">Model predictions are prompts for a human review. They do not activate factory controls.</p>
      </aside>
    </div>}
  </div>;
}

function CameraTile({ camera, area, stream, analysis, inference, shift, canAnalyze, monitoring }) {
  const prefersReducedMotion = useReducedMotion();
  const videoRef = useRef(null);
  const predictions = analysis?.predictions || [];
  const posePeople = predictions.filter((prediction) => prediction.keypoints?.length);
  const skeletonEdges = [[0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream;
  }, [stream]);

  return <motion.article className={"camera-tile" + (stream ? " camera-tile--selected" : "")} whileHover={{ opacity: 0.99 }} transition={{ type: "tween", duration: 0.16, ease: "easeOut" }}>
    <div className="camera-tile__heading"><div><span className="camera-live-indicator"><motion.i animate={stream && monitoring && !prefersReducedMotion ? { opacity: [0.65, 1, 0.65] } : { opacity: 1 }} transition={{ duration: 1.8, repeat: stream && monitoring && !prefersReducedMotion ? Infinity : 0, ease: "easeInOut" }} /> {stream ? !canAnalyze ? "Live · view only" : !inference.enabled ? "Live · setup required" : monitoring ? "Live · monitoring" : "Live · paused" : camera.status === "malfunctioned" ? "Fault" : "Connected"}</span><h3>{camera.name}</h3></div><span className="camera-id">{camera.id}</span></div>
    <div className="camera-stage">
      {stream ? <video ref={videoRef} poster="/camera-poster.svg" muted autoPlay playsInline aria-label={`${camera.name} local camera feed`} /> : <div className="camera-stage__offline"><span>◎</span><strong>{camera.status === "malfunctioned" ? "Camera interrupted" : "Feed stopped"}</strong><small>Use Start all cameras above to open available feeds.</small></div>}
      {stream && <div className="camera-stage__hud"><span>LOCAL CAMERA / {area.toUpperCase()} / {shift.toUpperCase()}</span><time>{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>}
      {stream && posePeople.length > 0 && <svg className="camera-pose-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">{posePeople.map((person, personIndex) => <g key={`pose-${person.trackId ?? personIndex}`}>{skeletonEdges.map(([from, to]) => { const a = person.keypoints[from], b = person.keypoints[to]; return a?.confidence > 0.2 && b?.confidence > 0.2 ? <line key={`${from}-${to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null; })}{person.keypoints.map((point, pointIndex) => point.confidence > 0.2 ? <circle key={pointIndex} cx={point.x} cy={point.y} r="0.006" /> : null)}</g>)}</svg>}
      {stream && predictions.filter((prediction) => prediction.model !== "pose").map((prediction, index) => <span className={`camera-detection${prediction.model === "action" ? " camera-detection--action" : ""}`} key={`${prediction.trackId ?? prediction.label}-${prediction.label}-${index}`} style={{ left: `${prediction.box.x * 100}%`, top: `${prediction.box.y * 100}%`, width: `${prediction.box.width * 100}%`, height: `${prediction.box.height * 100}%` }}><b>{prediction.trackId != null ? `#${prediction.trackId} ` : ""}{prediction.label} {Math.round(prediction.confidence * 100)}%</b></span>)}
    </div>
    <div className="camera-tile__meta"><span>{stream ? "Laptop / connected webcam" : "Local device / feed stopped"}</span><span>{inference.enabled ? "Local model ready" : inference.available ? "Local weights not configured" : "Vision service offline"}</span></div>
    {canAnalyze && <div className="camera-tile__actions"><span className="camera-config-hint">{stream && monitoring && inference.enabled ? analysis?.message || "Automatic analysis starting…" : stream && !inference.enabled ? inference.message || "Configure local model weights to analyze frames." : stream ? "Automatic analysis paused." : "Waiting for all-camera start."}</span></div>}
    {analysis?.error && <p className="device-message device-message--error" role="status">{analysis.error}</p>}
  </motion.article>;
}
