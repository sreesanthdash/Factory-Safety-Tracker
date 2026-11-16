import { Link } from "react-router-dom";

const areaState = {
  candidate: "Candidate",
  unsafe: "Avoid",
  unverified: "Unverified"
};

export default function EvacuationAdvisory({ advisory }) {
  if (!advisory?.active) return null;
  const hasCandidate = advisory.status === "candidate" && advisory.zoneName;

  return (
    <section className="evacuation-advisory" role="alert" aria-labelledby="evacuation-advisory-title">
      <div className="evacuation-advisory__summary">
        <p className="section-context">Emergency / fire and smoke response</p>
        <h2 id="evacuation-advisory-title">Evacuation advisory active</h2>
        <p>{advisory.message}</p>
        {advisory.criticalIncidentId && <Link className="text-link evacuation-advisory__link" to={`/incidents?selected=${encodeURIComponent(advisory.criticalIncidentId)}&status=all`}>Review triggering alert ↗</Link>}
      </div>
      <div className={"evacuation-destination" + (hasCandidate ? " evacuation-destination--candidate" : " evacuation-destination--unknown")}>
        <span>{hasCandidate ? "Candidate muster zone" : "No verified candidate"}</span>
        <strong>{advisory.zoneName || "Follow the site emergency plan"}</strong>
        <small>{hasCandidate ? "Fresh camera scans found no active fire or smoke." : "Wait for current camera scans or choose a site-designated muster point."}</small>
      </div>
      <div className="evacuation-area-checks" aria-label="Zone scan status">
        {(advisory.areas || []).map((area) => (
          <div className={`evacuation-area evacuation-area--${area.status}`} key={area.zoneId}>
            <div><strong>{area.zoneName}</strong><span>{areaState[area.status] || "Unverified"}</span></div>
            <small>{area.reason}</small>
          </div>
        ))}
      </div>
      <p className="evacuation-advisory__caveat">This is a camera and incident based candidate, not a guarantee of safety. Check exits, routes, occupancy, and muster capacity against the site evacuation plan before directing workers.</p>
    </section>
  );
}
