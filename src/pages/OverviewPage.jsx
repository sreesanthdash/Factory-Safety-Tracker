import { useEffect, useState } from "react";
import { api, isPriorityAlert, signalLabel, sortAlertsByPriority, statusLabel, zoneLabel } from "../api.js";
import { useAuth } from "../auth.js";
import { useDevices } from "../DevicesContext.jsx";
import OverviewCharts from "./OverviewCharts.jsx";
import { LoadingMark, MotionLink, MotionRow } from "../motion.jsx";
import { motion } from "motion/react";
import EvacuationAdvisory from "../components/EvacuationAdvisory.jsx";

export default function OverviewPage() {
  const { user } = useAuth();
  const localDevices = useDevices();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const refresh = () => api("/api/dashboard").then((result) => { if (mounted) setData(result); }).catch((reason) => { if (mounted) setError(reason.message); });
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  if (error) return <StateBlock title="Overview unavailable" detail={error} />;
  if (!data) return <LoadingBlock />;
  const open = data.incidents.filter((event) => event.status === "open" || event.status === "acknowledged");
  const zoneOfCamera = (camera) => localDevices.zoneAssignments[camera.id] || user.zoneIds[0] || data.zones[0]?.id;
  const activeCameras = localDevices.cameras.filter((camera) => camera.connected && !["malfunctioned", "unresponsive"].includes(camera.status));
  const reportingSensors = localDevices.sensors.filter((sensor) => sensor.status === "reporting");
  const reporting = data.devices.filter((device) => device.status === "reporting").length + activeCameras.length + reportingSensors.length;
  const deviceTotal = data.devices.length + localDevices.cameras.length + localDevices.sensors.length;
  const deviceIssues = [...localDevices.cameras, ...localDevices.sensors].filter((device) => ["malfunctioned", "unresponsive"].includes(device.status)).length;

  return (
    <div className="page-content overview-page" id="overview">
      <PageHeading titleId="page-title" kicker={data.site.name + " / " + data.site.area} title="Site overview" subtitle="A live view of detector signals, reviewed incidents, and locally connected safety devices." aside={<span className="page-stamp"><i /> {data.currentShift || "Current shift"}</span>} />
      <EvacuationAdvisory advisory={data.evacuationAdvisory} />
      <section className="metric-grid" aria-label="Site metrics">
        <Metric id="summary-open" label="Needs review" value={String(open.length).padStart(2, "0")} note="Open or awaiting review" accent={open.length > 0} href="/incidents?status=open" />
        <Metric id="summary-devices" label="Devices reporting" value={String(reporting).padStart(2, "0") + " / " + String(deviceTotal).padStart(2, "0")} note={deviceIssues ? `${deviceIssues} device${deviceIssues === 1 ? "" : "s"} need attention` : deviceTotal ? "Connected devices in this session" : "Connect cameras or sensors to begin"} href="/devices" />
        <Metric id="summary-workers" label="Worker references" value={String(data.workers.length).padStart(2, "0")} note="Stored zone assignments" />
        <Metric id="summary-zones" label="Active areas" value={String(data.zones.length).padStart(2, "0")} note="Available for device assignment" />
      </section>
      <OverviewCharts zones={data.zones} workers={data.workers} incidents={data.incidents} />
      <div className="overview-grid">
        <section className="section-block zone-section" aria-labelledby="zones-title">
          <div className="section-heading"><div><h2 id="zones-title">Zones in view</h2></div><MotionLink className="text-link" to="/incidents">Open incident queue</MotionLink></div>
          <div className="zone-grid">{data.zones.map((zone, index) => {
            const zoneOpen = open.filter((event) => event.zoneId === zone.id).length;
            const zoneDevices = data.devices.filter((device) => device.zoneId === zone.id).length + localDevices.cameras.filter((camera) => zoneOfCamera(camera) === zone.id).length + localDevices.sensors.filter((sensor) => sensor.zoneId === zone.id).length;
            const zoneWorkers = data.workers.filter((worker) => worker.zoneId === zone.id).length;
            return <MotionLink className="zone-tile" to={"/incidents?zone=" + zone.id} key={zone.id} whileHover="hover" initial="rest" variants={{ rest: { opacity: 1 }, hover: { opacity: 0.97 } }}>
              <span className="zone-tile__index">0{index + 1}</span><span className={"zone-tile__state" + (zoneOpen ? " has-alert" : "")}><i />{zoneOpen ? zoneOpen + " review" + (zoneOpen === 1 ? "" : "s") : "No open reviews"}</span>
              <strong>{zone.name}</strong><span className="zone-tile__meta">{zoneDevices} devices / {zoneWorkers} worker references</span><motion.span className="zone-tile__arrow" aria-hidden="true" variants={{ rest: { opacity: 0.6 }, hover: { opacity: 1 } }}>↗</motion.span>
            </MotionLink>;
          })}</div>
        </section>
        <section className="section-block latest-section" aria-labelledby="latest-heading">
          <div className="section-heading"><div><h2 id="latest-heading">Recent signals</h2></div><MotionLink className="text-link" to="/incidents">View all</MotionLink></div>
          <div className="signal-table-wrap">
            <table className="data-table signal-table"><thead><tr><th>Signal</th><th>Zone</th><th>Time</th><th>State</th></tr></thead><tbody>
              {sortAlertsByPriority(data.incidents).slice(0, 5).map((event) => <MotionRow key={event.id}>
                <td><MotionLink className="table-primary" to={"/incidents?selected=" + event.id}><span className={"event-mark" + (isPriorityAlert(event) ? " event-mark--critical" : "")} />{signalLabel[event.type]}<small>{event.id}</small></MotionLink></td>
                <td>{zoneLabel(data.zones, event.zoneId)}</td><td className="numeric-cell">{event.time}</td>
                <td><span className={"state-chip state-chip--" + event.status}>{statusLabel[event.status]}</span></td>
              </MotionRow>)}
            </tbody></table>
            {!data.incidents.length && <div className="empty-inline">No event signals have been recorded.</div>}
          </div>
          <div className="human-review-note"><span className="review-line-icon">↳</span><p>Detector output is a prompt for review. A safety decision is recorded separately by a person.</p></div>
        </section>
      </div>
      <div className="page-endnote"><span id="processing-title">Inputs <b>Connected cameras, serial sensors, and worker reports</b></span><span>Unverified alerts require human review</span></div>
    </div>
  );
}

export function PageHeading({ kicker, title, subtitle, aside }) {
  return <header className="page-heading"><div><p className="section-context">{kicker}</p><h1 id="page-title">{title}</h1>{subtitle && <p className="page-subtitle">{subtitle}</p>}</div>{aside && <div className="page-heading__aside">{aside}</div>}</header>;
}
export function LoadingBlock() { return <div className="state-block"><LoadingMark /><p>Loading site data…</p></div>; }
export function StateBlock({ title, detail, action }) { return <section className="state-block"><span className="state-block__rule" /><h2>{title}</h2><p>{detail}</p>{action}</section>; }

function Metric({ id, label, value, note, accent, href }) {
  const contents = <><span className="metric-label">{label}</span><strong className={accent ? "metric-value metric-value--accent" : "metric-value"}>{value}</strong><span className="metric-note">{note}</span>{href && <motion.span className="metric-arrow" variants={{ rest: { opacity: 0.6 }, hover: { opacity: 1 } }}>↗</motion.span>}</>;
  return href ? <MotionLink id={id} to={href} className="metric-cell" whileHover="hover" initial="rest" variants={{ hover: { opacity: 0.97 }, rest: { opacity: 1 } }}>{contents}</MotionLink> : <div id={id} className="metric-cell">{contents}</div>;
}
