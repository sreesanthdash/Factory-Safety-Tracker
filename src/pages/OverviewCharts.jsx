import { motion, useReducedMotion } from "motion/react";
import { signalLabel, statusLabel } from "../api.js";

const signalKinds = [
  { id: "ppe", className: "chart-series--ppe" },
  { id: "smoke", className: "chart-series--smoke" },
  { id: "electrical", className: "chart-series--electrical" },
  { id: "fight", className: "chart-series--fight" },
  { id: "accident", className: "chart-series--accident" }
];
const reviewStates = ["open", "acknowledged", "confirmed", "dismissed"];

export default function OverviewCharts({ zones, workers, incidents }) {
  const prefersReducedMotion = useReducedMotion();
  const zoneSignals = zones.map((zone) => ({
    zone,
    counts: Object.fromEntries(signalKinds.map(({ id }) => [id, incidents.filter((event) => event.zoneId === zone.id && event.type === id).length]))
  }));
  const workerCounts = zones.map((zone) => ({ zone, count: workers.filter((worker) => worker.zoneId === zone.id).length }));
  const statusCounts = reviewStates.map((status) => ({ status, count: incidents.filter((event) => event.status === status).length }));
  const total = incidents.length;

  return <section className="analytics-section" aria-labelledby="analytics-title">
    <div className="analytics-heading">
      <div><h2 id="analytics-title">Patterns across the floor</h2></div>
      <p>Counts update as camera, sensor, and worker reports arrive.</p>
    </div>
    <div className="analytics-grid">
      <motion.article className="chart-panel chart-panel--wide" aria-labelledby="signal-chart-title">
        <div className="chart-panel__heading"><div><h3 id="signal-chart-title">Signals by zone</h3><p>Recorded events grouped by detector type</p></div><span className="chart-index">01 / 03</span></div>
        <GroupedSignalChart rows={zoneSignals} prefersReducedMotion={prefersReducedMotion} />
        <div className="chart-legend">{signalKinds.map((kind) => <span key={kind.id}><i className={kind.className} />{signalLabel[kind.id]}</span>)}</div>
      </motion.article>
      <motion.article className="chart-panel" aria-labelledby="review-chart-title">
        <div className="chart-panel__heading"><div><h3 id="review-chart-title">Review states</h3><p>Current state of recorded incidents</p></div><span className="chart-index">02 / 03</span></div>
        <ReviewDonut counts={statusCounts} total={total} prefersReducedMotion={prefersReducedMotion} />
      </motion.article>
      <motion.article className="chart-panel" aria-labelledby="worker-chart-title">
        <div className="chart-panel__heading"><div><h3 id="worker-chart-title">Worker references by zone</h3><p>Assignments currently stored for this site</p></div><span className="chart-index">03 / 03</span></div>
        <WorkerBars rows={workerCounts} prefersReducedMotion={prefersReducedMotion} />
      </motion.article>
    </div>
  </section>;
}

function GroupedSignalChart({ rows, prefersReducedMotion }) {
  const width = 640;
  const height = 224;
  const left = 28;
  const right = 8;
  const top = 18;
  const bottom = 42;
  const chartHeight = height - top - bottom;
  const maxValue = Math.max(2, ...rows.flatMap(({ counts }) => signalKinds.map(({ id }) => counts[id])));
  const step = (width - left - right) / Math.max(rows.length, 1);
  const barWidth = Math.min(22, step * 0.2);
  const groupWidth = signalKinds.length * barWidth + (signalKinds.length - 1) * 6;
  const gridValues = [...new Set(Array.from({ length: 3 }, (_, index) => Math.ceil(maxValue * (index + 1) / 3)))];

  return <svg className="signal-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Grouped bar chart of safety signals by type and zone">
    <title>Detector signals grouped by zone</title>
    {gridValues.map((value) => {
      const y = top + chartHeight - value / maxValue * chartHeight;
      return <g key={value}><line className="chart-gridline" x1={left} x2={width - right} y1={y} y2={y} /><text className="chart-axis-label" x={left - 9} y={y + 3} textAnchor="end">{value}</text></g>;
    })}
    {rows.map(({ zone, counts }, index) => {
      const xCenter = left + step * index + step / 2;
      const startX = xCenter - groupWidth / 2;
      return <g key={zone.id}>
        {signalKinds.map((kind, kindIndex) => {
          const value = counts[kind.id];
          const barHeight = value / maxValue * chartHeight;
          const x = startX + kindIndex * (barWidth + 6);
          const y = top + chartHeight - barHeight;
          return <g key={kind.id}><motion.rect className={`chart-bar ${kind.className}`} x={x} y={y} width={barWidth} height={Math.max(value ? barHeight : 1, 1)} rx="1" initial={prefersReducedMotion ? false : { opacity: 0.35 }} animate={{ opacity: 1 }} transition={{ duration: prefersReducedMotion ? 0 : 0.32, delay: prefersReducedMotion ? 0 : index * 0.035 + kindIndex * 0.018, ease: "easeOut" }} /><text className="chart-value-label" x={x + barWidth / 2} y={value ? y - 5 : top + chartHeight - 7} textAnchor="middle">{value}</text></g>;
        })}
        <text className="chart-zone-label" x={xCenter} y={height - 12} textAnchor="middle">{zone.name}</text>
      </g>;
    })}
  </svg>;
}

function ReviewDonut({ counts, total, prefersReducedMotion }) {
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return <div className="review-chart">
    <svg className="review-chart__ring" viewBox="0 0 140 140" role="img" aria-label={`Review state breakdown across ${total} synthetic incidents`}>
      <title>Review state breakdown</title>
      <circle className="review-ring-track" cx="70" cy="70" r={radius} />
      {counts.map(({ status, count }) => {
        const length = total ? count / total * circumference : 0;
        const segment = <motion.circle key={status} className={`review-ring-segment review-ring-segment--${status}`} cx="70" cy="70" r={radius} initial={prefersReducedMotion ? false : { strokeDasharray: `0 ${circumference}` }} animate={{ strokeDasharray: `${length} ${circumference - length}`, strokeDashoffset: -offset }} transition={{ duration: prefersReducedMotion ? 0 : 0.82, delay: prefersReducedMotion ? 0 : counts.findIndex((item) => item.status === status) * 0.075, ease: [0.16, 1, 0.3, 1] }} />;
        offset += length;
        return segment;
      })}
      <text className="review-ring-total" x="70" y="68" textAnchor="middle">{String(total).padStart(2, "0")}</text>
      <text className="review-ring-caption" x="70" y="85" textAnchor="middle">signals</text>
    </svg>
    <ul className="review-chart__legend">{counts.map(({ status, count }) => <li key={status}><span><i className={`review-key review-key--${status}`} />{statusLabel[status]}</span><b>{String(count).padStart(2, "0")}</b></li>)}</ul>
  </div>;
}

function WorkerBars({ rows, prefersReducedMotion }) {
  const maxCount = Math.max(1, ...rows.map(({ count }) => count));
  return <div className="worker-bars" role="img" aria-label="Bar chart of worker references by zone">
    {rows.map(({ zone, count }, index) => <motion.div className="worker-bar-row" key={zone.id} initial={prefersReducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: prefersReducedMotion ? 0 : index * 0.04, duration: prefersReducedMotion ? 0 : 0.22, ease: "easeOut" }}>
      <span className="worker-bar-row__label">{zone.name}</span>
      <span className="worker-bar-track"><motion.i initial={prefersReducedMotion ? false : { scaleX: 0 }} animate={{ scaleX: count / maxCount }} transition={{ delay: prefersReducedMotion ? 0 : index * 0.075 + 0.1, duration: prefersReducedMotion ? 0 : 0.78, ease: [0.16, 1, 0.3, 1] }} style={{ transformOrigin: "left center" }} /></span>
      <b>{String(count).padStart(2, "0")}</b>
    </motion.div>)}
  </div>;
}
