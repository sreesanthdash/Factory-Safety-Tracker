import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, zoneLabel } from "../api.js";
import { useAuth } from "../auth.js";
import { useDevices } from "../DevicesContext.jsx";
import Dropdown from "../components/Dropdown.jsx";
import { MotionButton, MotionLink, MotionRow } from "../motion.jsx";
import { motion } from "motion/react";
import { LoadingBlock, PageHeading, StateBlock } from "./OverviewPage.jsx";

export default function DevicesPage() {
  const { user } = useAuth();
  const devices = useDevices();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useSearchParams();
  const [sensorZone, setSensorZone] = useState(user.zoneIds[0] || "");
  const zoneId = search.get("zone") || "all";
  useEffect(() => { api("/api/dashboard").then(setData).catch((reason) => setError(reason.message)); }, []);
  const cameraRows = useMemo(() => devices.cameras.map((camera) => ({ ...camera, zoneId: devices.zoneAssignments[camera.id] || user.zoneIds[0] })).filter((camera) => zoneId === "all" || camera.zoneId === zoneId), [devices.cameras, devices.zoneAssignments, user.zoneIds, zoneId]);
  const sensorRows = devices.sensors.filter((sensor) => zoneId === "all" || sensor.zoneId === zoneId);
  if (error && !data) return <StateBlock title="Device manager unavailable" detail={error} />;
  if (!data) return <LoadingBlock />;

  const connections = cameraRows.filter((device) => device.connected).length + sensorRows.filter((device) => !["disconnected", "malfunctioned"].includes(device.status)).length;
  const issueCount = [...cameraRows, ...sensorRows].filter((device) => ["malfunctioned", "unresponsive"].includes(device.status)).length;
  const zones = data.zones.filter((zone) => user.zoneIds.includes(zone.id));
  const zoneOptions = zones.map((zone) => ({ value: zone.id, label: zone.name }));

  return <div className="page-content devices-page" id="devices">
    <PageHeading kicker="Local hardware / live status" title="Device manager" subtitle="Detected cameras and sensors connected to this browser. No placeholder hardware is listed." aside={<span className={"page-stamp" + (issueCount ? " page-stamp--warning" : "")}><i /> {issueCount ? `${issueCount} device issue${issueCount === 1 ? "" : "s"}` : `${connections} connected`}</span>} />
    <section className="register-summary register-summary--live">
      <div><span className="summary-symbol">↗</span><span><strong>Device health</strong><small>{issueCount ? "Check the device row for the cause and last signal." : "Camera track and sensor heartbeat status are monitored in this session."}</small></span></div>
      <div className="device-area-filter"><label htmlFor="device-zone">Area</label><Dropdown id="device-zone" value={zoneId} onChange={(event) => setSearch(event.target.value === "all" ? {} : { zone: event.target.value })} options={[{ value: "all", label: "All assigned areas" }, ...zoneOptions]} /></div>
    </section>
    <motion.section className="device-manager-card" aria-labelledby="camera-device-title" whileHover={{ opacity: 0.99 }} transition={{ type: "tween", duration: 0.16, ease: "easeOut" }}>
      <div className="device-manager-card__heading"><div><p className="section-context">Video inputs</p><h2 id="camera-device-title">Cameras</h2><p>Browser-detected laptop cameras and webcams exposed to Windows, including compatible phone webcam apps. Start all detected feeds together; analysis begins automatically.</p></div><div className="camera-manager-actions"><MotionButton className="button button--quiet" type="button" disabled={devices.cameraBusy} onClick={devices.scanCameras}>{devices.cameraBusy ? "Scanning…" : "Scan cameras"}</MotionButton><MotionButton className="button button--primary" type="button" disabled={devices.cameraBusy || !cameraRows.some((camera) => camera.connected && !devices.streams[camera.id])} onClick={devices.startAllCameras}>{devices.cameraBusy ? "Starting…" : "Start all cameras"}</MotionButton>{Object.keys(devices.streams).length > 0 && <MotionButton className="button button--quiet" type="button" disabled={devices.cameraBusy} onClick={() => devices.stopCamera()}>Stop all</MotionButton>}</div></div>
      {devices.cameraError && <p className="device-message device-message--error" role="status">{devices.cameraError}</p>}
      {cameraRows.length ? <div className="data-table-wrap"><table className="data-table device-table"><thead><tr><th>Camera</th><th>Area</th><th>Connection</th><th>Health</th><th>Feed status</th></tr></thead><tbody>{cameraRows.map((camera) => <MotionRow key={camera.id}>
        <td><span className="device-name-cell"><i className="device-kind-icon">◉</i><span><strong>{camera.name}</strong><small>{camera.id}</small></span></span></td>
        <td><Dropdown className="device-camera-area" triggerClassName="device-zone-select" aria-label={`Assign area for ${camera.name}`} value={devices.zoneAssignments[camera.id] || zones[0]?.id || ""} onChange={(event) => devices.assignZone(camera.id, event.target.value)} options={zoneOptions} disabled={!zoneOptions.length} /></td>
        <td><span className={`connection-state connection-state--${camera.connected ? "reporting" : "disconnected"}`}><i />{camera.connected ? "Detected" : "Disconnected"}</span></td>
        <td><DeviceHealth status={camera.status} /></td>
        <td><span className="device-feed-state">{devices.streams[camera.id] ? "Included in monitor" : "Waiting for all-camera start"}</span></td>
      </MotionRow>)}</tbody></table></div> : <div className="device-empty"><span>◎</span><strong>No cameras discovered</strong><p>Allow camera permission, then scan again. A phone connected by USB appears here only if its camera is exposed to the computer as a webcam.</p><MotionButton className="button button--primary" type="button" disabled={devices.cameraBusy} onClick={devices.scanCameras}>Allow access and scan</MotionButton></div>}
    </motion.section>

    <motion.section className="device-manager-card" aria-labelledby="sensor-device-title" whileHover={{ opacity: 0.99 }} transition={{ type: "tween", duration: 0.16, ease: "easeOut" }}>
      <div className="device-manager-card__heading"><div><p className="section-context">Serial inputs / actual hardware</p><h2 id="sensor-device-title">Safety sensors</h2><p>Connect a USB/serial sensor with the protocol below. The browser prompts you to select a port.</p></div><div className="sensor-connect-actions"><Dropdown id="sensor-area" label="Area" className="sensor-area-select" options={zoneOptions} value={sensorZone} onChange={(event) => setSensorZone(event.target.value)} disabled={!zones.length} />{devices.sensorConnected ? <MotionButton className="button button--quiet" type="button" onClick={devices.disconnectSensor}>Disconnect sensor</MotionButton> : <MotionButton className="button button--primary" type="button" disabled={!sensorZone} onClick={() => devices.connectSensor(sensorZone)}>Connect sensor</MotionButton>}</div></div>
      {devices.sensorError && <p className="device-message device-message--error" role="status">{devices.sensorError}</p>}
      {sensorRows.length ? <div className="data-table-wrap"><table className="data-table device-table"><thead><tr><th>Device ID</th><th>Type</th><th>Area</th><th>Connection</th><th>Last signal</th><th>Health</th></tr></thead><tbody>{sensorRows.map((sensor) => <MotionRow key={sensor.id}><td className="numeric-cell device-id">{sensor.id}</td><td>{sensor.type}</td><td>{zoneLabel(data.zones, sensor.zoneId)}</td><td><span className="connection-state"><i />{devices.sensorConnected ? "Connected" : "Disconnected"}</span></td><td className="numeric-cell">{sensor.lastSignal ? new Date(sensor.lastSignal).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</td><td><DeviceHealth status={sensor.status} /></td></MotionRow>)}</tbody></table></div> : <div className="device-empty device-empty--small"><span>⌁</span><strong>No sensors connected</strong><p>Only a sensor selected through the browser’s serial-device prompt will appear here.</p></div>}
      <details className="serial-protocol"><summary>Sensor data protocol</summary><p>Configure the sensor or its gateway for 9600 baud and newline-delimited JSON. Each line should include a <code>type</code> and either <code>triggered: true</code> or numeric <code>value</code> and <code>threshold</code> fields:</p><pre>{'{"sensorId":"smoke-1","type":"smoke","value":0.82,"threshold":0.7}'}</pre><p>Supported signal types: <code>smoke</code>, <code>fire</code>, <code>electrical</code>, <code>short_circuit</code>, <code>fight</code>, <code>accident</code>, and <code>ppe</code>. A quiet port is marked unresponsive after 30 seconds.</p></details>
    </motion.section>
    <div className="device-manager-footer"><span>Camera access <b>Browser permission</b></span><span>Sensor access <b>Explicit serial port selection</b></span><MotionLink to="/live-feed">Open live feed ↗</MotionLink></div>
  </div>;
}

function DeviceHealth({ status }) {
  const label = ({ streaming: "Live", available: "Ready", malfunctioned: "Malfunctioned", unresponsive: "No signal", waiting: "Waiting for data", reporting: "Reporting", disconnected: "Disconnected" })[status] || "Unknown";
  return <span className={`connection-state connection-state--${status}`}><i />{label}</span>;
}
