export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new CustomEvent("safety:session-expired"));
  if (!response.ok) throw new Error(payload?.error || "The request could not be completed.");
  return payload;
}

export const jsonRequest = (method, body) => ({ method, body: JSON.stringify(body) });

export const zoneLabel = (zones, zoneId) => zones.find((zone) => zone.id === zoneId)?.name ?? "Unknown zone";

export const statusLabel = {
  open: "Needs review",
  acknowledged: "Acknowledged",
  confirmed: "Confirmed",
  dismissed: "Dismissed"
};

export const signalLabel = {
  ppe: "Possible PPE gap",
  smoke: "Possible smoke or fire",
  electrical: "Possible electrical hazard / spark",
  fight: "Possible fight",
  accident: "Possible fall / accident"
};

const priorityByType = { smoke: 0, fire: 0, electrical: 1, accident: 2, fight: 2, ppe: 3 };
const unresolvedStatuses = new Set(["open", "acknowledged", "queued"]);

export const isPriorityAlert = (alert) => alert?.priority === "critical" || ["fire", "smoke"].includes(String(alert?.type || "").toLowerCase());

export function sortAlertsByPriority(alerts = []) {
  return [...alerts].sort((left, right) => {
    const activeDifference = Number(!unresolvedStatuses.has(left.status)) - Number(!unresolvedStatuses.has(right.status));
    if (activeDifference) return activeDifference;
    const priorityDifference = (priorityByType[left.type] ?? 4) - (priorityByType[right.type] ?? 4);
    if (priorityDifference) return priorityDifference;
    const leftTime = Date.parse(left.createdAt || left.lastSeenAt || "") || 0;
    const rightTime = Date.parse(right.createdAt || right.lastSeenAt || "") || 0;
    return rightTime - leftTime;
  });
}

