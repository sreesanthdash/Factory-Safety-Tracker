import { createHash, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createInitialDashboard, ZONE_IDS } from "./demo-data.js";
import { openMongoStore } from "./mongo-store.js";

const scryptAsync = promisify(scrypt);
const sessionCookie = "site_session";
const sessionLifetime = 8 * 60 * 60 * 1000;
const passwordBytes = 64;
const allowedRoles = new Set(["Operator", "Safety officer"]);

function clone(value) {
  return structuredClone(value);
}

const alertPriority = { smoke: 0, fire: 0, electrical: 1, accident: 2, fight: 2, ppe: 3 };
const unresolvedAlertStatuses = new Set(["open", "acknowledged", "queued"]);
const evacuationHazardTypes = new Set(["smoke", "fire", "electrical", "fight", "accident"]);
const evacuationScanFreshMs = 15_000;

function priorityForAlert(alert) {
  if (["fire", "smoke"].includes(String(alert?.type || "").toLowerCase())) return "critical";
  if (["electrical", "accident", "fight"].includes(String(alert?.type || "").toLowerCase())) return "high";
  return "standard";
}

function sortAlertsByPriority(alerts) {
  return [...alerts].sort((left, right) => {
    const activeDifference = Number(!unresolvedAlertStatuses.has(left.status)) - Number(!unresolvedAlertStatuses.has(right.status));
    if (activeDifference) return activeDifference;
    const priorityDifference = (alertPriority[left.type] ?? 4) - (alertPriority[right.type] ?? 4);
    if (priorityDifference) return priorityDifference;
    const leftTime = Date.parse(left.createdAt || left.lastSeenAt || "") || 0;
    const rightTime = Date.parse(right.createdAt || right.lastSeenAt || "") || 0;
    return rightTime - leftTime;
  });
}

function permissionsFor(user) {
  const administrator = user.role === "Administrator";
  const safetyOfficer = user.role === "Safety officer";
  return {
    overview: true,
    incidents: true,
    devices: true,
    liveFeed: true,
    analyzeCameras: administrator || safetyOfficer,
    manageUsers: administrator,
    acknowledge: administrator || safetyOfficer || (user.role === "Operator" && user.canAcknowledge),
    confirm: administrator || safetyOfficer,
    dismiss: administrator || safetyOfficer,
    resetDemo: administrator
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    zoneIds: [...user.zoneIds],
    canAcknowledge: user.role === "Operator" && user.canAcknowledge,
    permissions: permissionsFor(user)
  };
}

function makePasswordRecord(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, passwordBytes);
  return { salt, hash };
}

async function verifyPassword(password, record) {
  const candidate = await scryptAsync(password, record.salt, passwordBytes);
  return timingSafeEqual(candidate, record.hash);
}

function tokenKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes = 32_768) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw Object.assign(new Error("Request is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Send valid JSON."), { statusCode: 400 });
  }
}

function requestCookie(req, name) {
  const cookies = String(req.headers.cookie ?? "").split(";");
  const match = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

function cookieHeader(req, value, maxAge) {
  const secure = req.socket.encrypted ? "; Secure" : "";
  return `${sessionCookie}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function safeText(value, maxLength = 80) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validUsername(value) {
  return /^[a-zA-Z0-9._-]{3,32}$/.test(value);
}

function currentLocalTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function shiftForSystemTime(date = new Date()) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= 6 * 60 && minutes < 14 * 60) return "Morning shift";
  if (minutes >= 14 * 60 && minutes < 22 * 60) return "Evening shift";
  return "Night shift";
}

export function createDemoAuthPlugin(env) {
  const configuredUsername = safeText(env.ADMIN_USERNAME, 32);
  const configuredPassword = typeof env.ADMIN_PASSWORD === "string" ? env.ADMIN_PASSWORD : "";
  const ready = validUsername(configuredUsername) && configuredPassword.length >= 8;
  const users = new Map();
  const sessions = new Map();
  const attempts = new Map();
  const incidentCooldowns = new Map();
  const notifications = [];
  const recordings = new Map();
  const cameraObservations = new Map();
  let dashboard = createInitialDashboard();
  const mongoUri = safeText(env.MONGODB_URI, 3000);
  const mongoDatabase = safeText(env.MONGODB_DATABASE, 80) || "factory_safety";
  const visionServiceUrl = safeText(env.VISION_SERVICE_URL, 300) || "http://127.0.0.1:8765";
  const deviceIngestToken = safeText(env.DEVICE_INGEST_TOKEN, 300);
  let visionHealthCache = { checkedAt: 0, data: null };
  let store = null;
  let storeFailure = null;
  let storeReady = Promise.resolve();
  const dummyPassword = makePasswordRecord(randomBytes(24).toString("hex"));

  if (ready) {
    const password = makePasswordRecord(configuredPassword);
    const admin = {
      id: "user-admin",
      username: configuredUsername,
      displayName: "Site administrator",
      role: "Administrator",
      active: true,
      zoneIds: [...ZONE_IDS],
      canAcknowledge: true,
      passwordSalt: password.salt,
      passwordHash: password.hash
    };
    users.set(admin.username.toLowerCase(), admin);
  }

  async function initializeStore() {
    if (!mongoUri) return;
    store = await openMongoStore(mongoUri, mongoDatabase, dashboard);
    await store.pruneLegacyDemoData();
    dashboard = await store.loadDashboard(dashboard);
    const storedUsers = await store.loadUsers();
    if (storedUsers.length) {
      users.clear();
      for (const user of storedUsers) {
        user.passwordSalt = Buffer.from(user.passwordSalt?.buffer ?? user.passwordSalt);
        user.passwordHash = Buffer.from(user.passwordHash?.buffer ?? user.passwordHash);
        users.set(user.username.toLowerCase(), user);
      }
    } else {
      for (const user of users.values()) await store.saveUser(user);
    }
    for (const session of await store.loadSessions()) sessions.set(session.tokenHash, { userId: session.userId, expiresAt: session.expiresAt });
  }

  function findSession(req) {
    const token = requestCookie(req, sessionCookie);
    if (!token) return null;
    const key = tokenKey(token);
    const session = sessions.get(key);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(key);
      if (store) void store.deleteSession(key).catch(() => {});
      return null;
    }
    const user = [...users.values()].find((candidate) => candidate.id === session.userId && candidate.active);
    if (!user) {
      sessions.delete(key);
      if (store) void store.deleteSession(key).catch(() => {});
      return null;
    }
    return user;
  }

  function invalidateUserSessions(userId) {
    for (const [key, session] of sessions) {
      if (session.userId === userId) {
        sessions.delete(key);
        if (store) void store.deleteSession(key).catch(() => {});
      }
    }
  }

  async function clearSession(req, res) {
    const token = requestCookie(req, sessionCookie);
    if (token) {
      const key = tokenKey(token);
      sessions.delete(key);
      await store?.deleteSession(key);
    }
    res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
  }

  function requireUser(req, res) {
    const user = findSession(req);
    if (!user) {
      sendJson(res, 401, { error: "Sign in to continue." });
      return null;
    }
    return user;
  }

  function hasPermission(user, key) {
    return Boolean(permissionsFor(user)[key]);
  }

  function sendForbidden(res) {
    sendJson(res, 403, { error: "Your account does not have access to this action." });
  }

  function userCanSeeZone(user, zoneId) {
    return user.role !== "Operator" || user.zoneIds.includes(zoneId);
  }

  function evacuationAdvisoryFor() {
    const now = Date.now();
    const activeCritical = dashboard.incidents
      .filter((incident) => priorityForAlert(incident) === "critical" && ["open", "acknowledged", "confirmed"].includes(incident.status) && !incident.evacuationClearedAt)
      .sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
    const currentFireScan = [...cameraObservations.values()].some((observation) =>
      now - observation.observedAt <= evacuationScanFreshMs && observation.hazards.some((hazard) => hazard.type === "smoke")
    );
    if (!activeCritical.length && !currentFireScan) return null;

    const areas = dashboard.zones.map((zone) => {
      const scans = [...cameraObservations.values()].filter((observation) => observation.zoneId === zone.id);
      const freshScans = scans.filter((observation) => now - observation.observedAt <= evacuationScanFreshMs);
      const activeHazard = dashboard.incidents.find((incident) => incident.zoneId === zone.id
        && evacuationHazardTypes.has(incident.type)
        && (["open", "acknowledged"].includes(incident.status) || (priorityForAlert(incident) === "critical" && incident.status === "confirmed"))
        && !incident.evacuationClearedAt);
      const detectedHazard = freshScans.flatMap((observation) => observation.hazards)[0];
      const currentHazard = activeHazard || detectedHazard;
      if (currentHazard) {
        return {
          zoneId: zone.id,
          zoneName: zone.name,
          status: "unsafe",
          reason: activeHazard ? `Active ${activeHazard.type} alert` : `Camera detected ${detectedHazard.type}`,
          cameraCount: freshScans.length,
          observedAt: freshScans.length ? new Date(Math.min(...freshScans.map((scan) => scan.observedAt))).toISOString() : null
        };
      }
      if (!freshScans.length || !freshScans.every((scan) => scan.hazardModelReady)) {
        return {
          zoneId: zone.id,
          zoneName: zone.name,
          status: "unverified",
          reason: !freshScans.length ? "Waiting for a recent camera scan" : "Fire/smoke detector is not ready for this scan",
          cameraCount: freshScans.length,
          observedAt: freshScans.length ? new Date(Math.min(...freshScans.map((scan) => scan.observedAt))).toISOString() : null
        };
      }
      return {
        zoneId: zone.id,
        zoneName: zone.name,
        status: "candidate",
        reason: `Clear fire/smoke scan from ${freshScans.length} camera${freshScans.length === 1 ? "" : "s"}`,
        cameraCount: freshScans.length,
        observedAt: new Date(Math.min(...freshScans.map((scan) => scan.observedAt))).toISOString()
      };
    });
    const candidates = areas.filter((area) => area.status === "candidate").sort((left, right) =>
      right.cameraCount - left.cameraCount || Date.parse(right.observedAt) - Date.parse(left.observedAt)
    );
    const trigger = activeCritical[0];
    return {
      active: true,
      status: candidates.length ? "candidate" : "unverified",
      triggerType: trigger?.type || "smoke",
      criticalIncidentId: trigger?.id || null,
      triggeredAt: trigger?.createdAt || new Date(now).toISOString(),
      zoneId: candidates[0]?.zoneId || null,
      zoneName: candidates[0]?.zoneName || null,
      areas,
      message: candidates.length
        ? "Candidate area selected from current camera and incident reports. Verify the evacuation route and gathering capacity before directing workers."
        : "No area has a fresh, clear fire/smoke scan. Keep workers away from the hazard and follow the site emergency plan."
    };
  }

  function overviewFor(user) {
    const visibleZones = dashboard.zones.filter((zone) => userCanSeeZone(user, zone.id));
    const visibleZoneIds = new Set(visibleZones.map((zone) => zone.id));
    return {
      site: dashboard.site,
      zones: visibleZones,
      workers: dashboard.workers.filter((worker) => visibleZoneIds.has(worker.zoneId)),
      devices: dashboard.devices.filter((device) => visibleZoneIds.has(device.zoneId)),
      incidents: sortAlertsByPriority(dashboard.incidents.filter((incident) => visibleZoneIds.has(incident.zoneId)).map((incident) => ({
        ...incident,
        priority: incident.priority || priorityForAlert(incident)
      }))),
      evacuationAdvisory: evacuationAdvisoryFor(),
      currentShift: shiftForSystemTime(),
      permissions: permissionsFor(user)
    };
  }

  function visibleUsers() {
    return [...users.values()].map((user) => publicUser(user));
  }

  function checkLoginRateLimit(key) {
    const entry = attempts.get(key);
    if (!entry) return { blocked: false };
    if (entry.blockedUntil > Date.now()) return { blocked: true, waitMs: entry.blockedUntil - Date.now() };
    if (entry.resetAt <= Date.now() || entry.blockedUntil) {
      attempts.delete(key);
      return { blocked: false };
    }
    return { blocked: false };
  }

  function recordFailedLogin(key) {
    const current = attempts.get(key);
    const count = (current?.resetAt > Date.now() ? current.count : 0) + 1;
    const blockedUntil = count >= 8 ? Date.now() + 10 * 60 * 1000 : 0;
    attempts.set(key, { count, resetAt: Date.now() + 10 * 60 * 1000, blockedUntil });
    return blockedUntil > 0;
  }

  function updateIncidentForAction(user, incident, action) {
    if (action === "clear-evacuation") {
      if (!hasPermission(user, "confirm")) return { status: 403, error: "Only a safety officer or administrator can clear an evacuation advisory." };
      if (priorityForAlert(incident) !== "critical") return { status: 400, error: "Evacuation clearance is only available for critical fire or smoke alerts." };
      if (incident.evacuationClearedAt) return { status: 409, error: "This evacuation advisory has already been cleared." };
      incident.evacuationClearedAt = new Date().toISOString();
      incident.evacuationClearedBy = user.displayName;
      incident.trail.push({ kind: "person", actor: user.displayName, detail: "Cleared the evacuation advisory after an on-site safety check.", time: currentLocalTime() });
      return { status: 200, data: clone(incident) };
    }
    const transitions = {
      acknowledge: { permission: "acknowledge", from: "open", to: "acknowledged", detail: "Alert acknowledged." },
      confirm: { permission: "confirm", from: "acknowledged", to: "confirmed", detail: "Marked as a confirmed incident after human review." },
      dismiss: { permission: "dismiss", from: "acknowledged", to: "dismissed", detail: "Dismissed as not a safety incident after human review." }
    };
    const transition = transitions[action];
    if (!transition || !hasPermission(user, transition.permission)) return { status: 403, error: "Your role cannot perform this review action." };
    if (!userCanSeeZone(user, incident.zoneId)) return { status: 403, error: "This incident is outside your assigned zones." };
    if (incident.status !== transition.from) return { status: 409, error: "Complete the review steps in order." };
    const time = currentLocalTime();
    incident.status = transition.to;
    incident.trail.push({ kind: "person", actor: user.displayName, detail: transition.detail, time });
    return { status: 200, data: clone(incident) };
  }

  async function camerasFor(user) {
    const visibleZones = new Set(dashboard.zones.filter((zone) => userCanSeeZone(user, zone.id)).map((zone) => zone.id));
    const cameras = dashboard.cameras.filter((camera) => visibleZones.has(camera.zoneId));
    return cameras.map((camera) => clone(camera));
  }

  async function queueNotification(notification) {
    notifications.unshift(notification);
    if (notifications.length > 100) notifications.length = 100;
    await store?.saveNotification(notification);
  }

  function makeIncident({ type, zoneId, deviceId, cameraId, cameraName, workerId = null, trackIds = [], description, source, confidence, violationClass, outline, frameTimeSeconds, recordingDurationSeconds }) {
    const recordedAt = new Date();
    const time = currentLocalTime(recordedAt);
    return {
      id: `${source === "ai" ? "AI" : "EV"}-${randomUUID().slice(0, 8).toUpperCase()}`,
      type, zoneId, deviceId, cameraId, cameraName: safeText(cameraName, 100), workerId, shift: shiftForSystemTime(recordedAt), time, status: "open", source,
      description, confidence: Number.isFinite(confidence) ? confidence : null,
      priority: priorityForAlert({ type }),
      evacuationClearedAt: null,
      evacuationClearedBy: null,
      violationClass: violationClass || null, trackIds, occurrenceCount: 1,
      createdAt: recordedAt.toISOString(), lastSeenAt: recordedAt.toISOString(),
      recording: {
        durationSeconds: Math.max(1, Math.min(120, Number(recordingDurationSeconds) || 12)),
        overlaySource: outline ? source : "none",
        outline: outline ?? null
      },
      trail: [{ kind: "instrument", actor: source === "ai" ? "Local YOLO vision model" : source === "operator-report" ? "Operator report" : "Camera or sensor", detail: description, time }]
    };
  }

  async function recordIncident(incident) {
    dashboard.incidents.unshift(incident);
    await store?.saveRecord("incidents", incident);
    await queueNotification({
      id: randomUUID(), incidentId: incident.id, zoneId: incident.zoneId, type: incident.type, priority: priorityForAlert(incident),
      title: ({ ppe: "Possible PPE gap", smoke: "Possible smoke or fire", electrical: "Possible electrical hazard / spark", fight: "Possible fight", accident: "Possible fall / accident" })[incident.type] || "Possible safety event",
      body: `${incident.id} / ${incident.description}`,
      createdAt: incident.createdAt || new Date().toISOString(),
      status: "queued"
    });
    return incident;
  }

  async function localVisionStatus() {
    if (visionHealthCache.data && Date.now() - visionHealthCache.checkedAt < 3000) return visionHealthCache.data;
    try {
      const response = await fetch(new URL("/health", visionServiceUrl), { signal: AbortSignal.timeout(1800) });
      const payload = await response.json().catch(() => ({}));
      const data = {
        available: response.ok,
        enabled: response.ok && Boolean(payload.enabled),
        models: payload.models ?? {},
        message: safeText(payload.message, 300)
      };
      visionHealthCache = { checkedAt: Date.now(), data };
      return data;
    } catch {
      const data = { available: false, enabled: false, models: {}, message: "Local vision service is not running." };
      visionHealthCache = { checkedAt: Date.now(), data };
      return data;
    }
  }

  function hazardForClass(label) {
    const normalized = label.toLowerCase().replace(/[_-]+/g, " ").trim();
    if (/\b(smoke|fire|flames?)\b/.test(normalized)) return "smoke";
    if (/\b(short circuit|shorted|electrical arc|electric arc|arc flash|arcing|arc|electrical hazard|exposed wire|electric shock|sparks?)\b/.test(normalized)) return "electrical";
    if (/\b(fight|fighting|assault|violence|physical altercation)\b/.test(normalized)) return "fight";
    if (/\b(accident|collision|fall|fallen worker|injury|injured|crush)\b/.test(normalized)) return "accident";
    const ppeItem = /\b(ppe|helmets?|hard hats?|hardhats?|safety vests?|vests?|gloves?|boots?|goggles?|glasses|eye protection|respirators?|masks?)\b/.test(normalized);
    const violation = /\b(no|missing|without|violation|non compliant|noncompliant|non compliance|unsafe|not wearing|absent)\b/.test(normalized);
    return ppeItem && violation ? "ppe" : null;
  }

  function minimumConfidenceForPrediction(prediction) {
    const label = prediction.label.toLowerCase();
    if (prediction.model === "action") {
      if (/\bfall\b|\bfallen\b/.test(label)) return 0.45;
      if (/\bfight\b|\bviolent\b/.test(label)) return 0.78;
      return 1;
    }
    return ["hazards", "custom_hazards"].includes(prediction.model) ? 0.35 : 0.55;
  }

  async function analyzeCameraFrame(user, camera, body) {
    if (!hasPermission(user, "analyzeCameras")) return { status: 403, error: "Your role cannot run camera analysis." };
    const serviceStatus = await localVisionStatus();
    if (!serviceStatus.available) return { status: 503, error: "Local vision service is unavailable. Start the Python inference service using the setup steps in README.md." };
    if (!serviceStatus.enabled) return { status: 503, error: serviceStatus.message || "No local vision weights are configured. Train the PPE model or configure a hazard model first." };
    const imageInput = typeof body.imageData === "string" ? body.imageData : "";
    const match = imageInput.match(/^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    const base64 = match?.[1] ?? (imageInput.match(/^[A-Za-z0-9+/=]+$/) ? imageInput : "");
    if (!base64 || base64.length > 5_500_000) return { status: 400, error: "Send a JPEG, PNG, or WebP frame smaller than 4 MB." };

    let inference;
    try {
      const response = await fetch(new URL("/infer", visionServiceUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraId: camera.id, imageBase64: base64 }),
        signal: AbortSignal.timeout(30000)
      });
      inference = await response.json().catch(() => ({}));
      if (!response.ok) return { status: response.status === 422 ? 503 : 502, error: safeText(inference.detail ?? inference.error, 300) || "The local model could not analyze this frame." };
    } catch {
      visionHealthCache = { checkedAt: 0, data: null };
      return { status: 503, error: "The local vision service did not respond. Check its terminal and try again." };
    }
    const predictions = (inference.predictions ?? []).map((prediction) => ({
      label: safeText(prediction.label, 80),
      confidence: Math.max(0, Math.min(1, Number(prediction.confidence) || 0)),
      model: safeText(prediction.model, 40),
      trackId: Number.isInteger(prediction.trackId) ? prediction.trackId : null,
      trackIds: Array.isArray(prediction.trackIds) ? [...new Set(prediction.trackIds.filter(Number.isInteger))].slice(0, 8) : [],
      rawLabel: safeText(prediction.rawLabel, 100),
      keypoints: Array.isArray(prediction.keypoints) ? prediction.keypoints.slice(0, 17).map((point) => ({
        name: safeText(point.name, 24),
        x: Math.max(0, Math.min(1, Number(point.x) || 0)),
        y: Math.max(0, Math.min(1, Number(point.y) || 0)),
        confidence: Math.max(0, Math.min(1, Number(point.confidence) || 0))
      })) : [],
      box: {
        x: Math.max(0, Math.min(1, Number(prediction.box?.x) || 0)),
        y: Math.max(0, Math.min(1, Number(prediction.box?.y) || 0)),
        width: Math.max(0, Math.min(1, Number(prediction.box?.width) || 0)),
        height: Math.max(0, Math.min(1, Number(prediction.box?.height) || 0))
      }
    }));
    const observedAt = Date.now();
    const observedHazards = predictions
      .filter((prediction) => prediction.confidence >= minimumConfidenceForPrediction(prediction))
      .map((prediction) => ({ type: hazardForClass(prediction.label), label: prediction.label, confidence: prediction.confidence }))
      .filter((hazard) => evacuationHazardTypes.has(hazard.type));
    cameraObservations.set(camera.id, {
      zoneId: camera.zoneId,
      cameraId: camera.id,
      cameraName: camera.name,
      observedAt,
      hazardModelReady: Boolean(serviceStatus.models?.hazards?.ready),
      hazards: observedHazards
    });
    const created = [];
    for (const prediction of predictions) {
      if (prediction.confidence < minimumConfidenceForPrediction(prediction)) continue;
      const type = hazardForClass(prediction.label);
      if (!type) continue;
      const now = Date.now();
      const trackIds = prediction.trackIds.length ? prediction.trackIds : prediction.trackId == null ? [] : [prediction.trackId];
      const cooldownKeys = trackIds.length
        ? trackIds.map((trackId) => `${camera.id}|${type}|${trackId}`)
        : [`${camera.id}|${type}|untracked`];
      const active = dashboard.incidents.find((incident) => {
        if (incident.cameraId !== camera.id || incident.violationClass !== prediction.label || incident.status !== "open") return false;
        if (now - new Date(incident.lastSeenAt || incident.createdAt).getTime() >= 120_000) return false;
        const incidentTracks = incident.trackIds || [];
        return !trackIds.length || !incidentTracks.length || trackIds.some((trackId) => incidentTracks.includes(trackId));
      });
      const coolingDown = cooldownKeys.some((key) => (incidentCooldowns.get(key) || 0) > now);
      if (active) {
        active.lastSeenAt = new Date(now).toISOString();
        active.trackIds = trackIds;
        active.lastCountedAt = active.lastCountedAt || active.createdAt;
        if (now - new Date(active.lastCountedAt).getTime() >= 30_000) {
          active.occurrenceCount = (active.occurrenceCount || 1) + 1;
          active.lastCountedAt = new Date(now).toISOString();
        }
        active.confidence = prediction.confidence;
        active.recording = { ...active.recording, startSeconds: Math.max(0, Number(body.frameTimeSeconds || 0) - 5), overlaySource: "model", outline: prediction.box };
        await store?.saveRecord("incidents", active);
        continue;
      }
      if (coolingDown) continue;
      const trackNote = trackIds.length ? ` Track${trackIds.length > 1 ? "s" : ""} ${trackIds.map((trackId) => `#${trackId}`).join(", ")}.` : "";
      const actionNote = prediction.rawLabel
        ? prediction.model === "action" ? ` VideoMAE label: ${prediction.rawLabel}.` : ` Vision cue: ${prediction.rawLabel}.`
        : "";
      const incident = makeIncident({
        type, zoneId: camera.zoneId, deviceId: camera.id, cameraId: camera.id,
        cameraName: camera.name,
        description: `The model flagged ${prediction.label} (${Math.round(prediction.confidence * 100)}% confidence).${actionNote}${trackNote} Human review is required.`,
        source: "ai", confidence: prediction.confidence, violationClass: prediction.label,
        trackIds, outline: prediction.box, frameTimeSeconds: body.frameTimeSeconds
      });
      for (const key of cooldownKeys) incidentCooldowns.set(key, now + 90_000);
      await recordIncident(incident);
      created.push(incident);
    }
    return { status: 200, data: { predictions, incidents: created } };
  }

  async function receiveDeviceEvent(body) {
    const camera = dashboard.cameras.find((entry) => entry.id === body.cameraId);
    const device = dashboard.devices.find((entry) => entry.id === body.deviceId);
    const localCameraId = /^CAM-LOCAL-[A-Z0-9]+$/.test(safeText(body.cameraId, 100)) ? safeText(body.cameraId, 100) : "";
    const zoneId = camera?.zoneId ?? device?.zoneId ?? safeText(body.zoneId, 40);
    const signalType = ({ fire: "smoke", short_circuit: "electrical" })[safeText(body.signalType, 40).toLowerCase()] || safeText(body.signalType, 40).toLowerCase();
    const supportedTypes = ["ppe", "smoke", "electrical", "fight", "accident"];
    if (!zoneId || !ZONE_IDS.includes(zoneId) || !supportedTypes.includes(signalType)) return { status: 400, error: "Choose an assigned zone and supported safety signal type." };
    const box = body.box && [body.box.x, body.box.y, body.box.width, body.box.height].every((value) => Number.isFinite(Number(value)))
      ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Math.max(0, Math.min(1, Number(body.box[key])))]))
      : null;
    const incident = makeIncident({
      type: signalType, zoneId, deviceId: device?.id ?? camera?.id ?? safeText(body.deviceId, 100),
      cameraId: camera?.id ?? (localCameraId || dashboard.cameras.find((entry) => entry.zoneId === zoneId)?.id),
      cameraName: camera?.name ?? safeText(body.cameraName, 100),
      description: safeText(body.description, 300) || "A camera or sensor integration submitted a possible safety signal. Human review is required.",
      source: "device", confidence: Math.max(0, Math.min(1, Number(body.confidence) || 0)),
      outline: box,
      frameTimeSeconds: body.frameTimeSeconds,
      recordingDurationSeconds: body.recordingDurationSeconds
    });
    await recordIncident(incident);
    return { status: 201, data: { incident } };
  }

  function timingSafeToken(req) {
    const supplied = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const expected = deviceIngestToken;
    if (!expected || supplied.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  async function dispatch(req, res, pathname) {
    await storeReady;
    if (storeFailure) {
      const error = storeFailure.name === "MongoParseError"
        ? "MONGODB_URI has invalid syntax. Percent-encode reserved characters in the database username or password, then restart the dev server."
        : "MongoDB is configured but unavailable. Check the URI, database user permissions, and Atlas network access list.";
      return sendJson(res, 503, { error });
    }
    const method = req.method ?? "GET";

    if (pathname === "/api/ingest/events" && method === "POST") {
      if (!deviceIngestToken) return sendJson(res, 503, { error: "DEVICE_INGEST_TOKEN is not configured." });
      if (!timingSafeToken(req)) return sendJson(res, 401, { error: "The device integration token was not accepted." });
      const body = await readJson(req);
      const result = await receiveDeviceEvent(body);
      return sendJson(res, result.status, result.data ?? { error: result.error });
    }

    if (pathname === "/api/device-events" && method === "POST") {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const zoneId = safeText(body.zoneId, 40);
      if (!userCanSeeZone(user, zoneId)) return sendForbidden(res);
      const result = await receiveDeviceEvent(body);
      return sendJson(res, result.status, result.data ?? { error: result.error });
    }

    if (pathname === "/api/session" && method === "GET") {
      const user = findSession(req);
      return sendJson(res, 200, { user: user ? publicUser(user) : null });
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      const key = req.socket.remoteAddress ?? "local";
      const rate = checkLoginRateLimit(key);
      if (rate.blocked) return sendJson(res, 429, { error: "Too many sign-in attempts. Wait a few minutes before trying again." });
      const body = await readJson(req);
      const username = safeText(body.username, 64).toLowerCase();
      const password = typeof body.password === "string" ? body.password : "";
      const user = users.get(username);
      const passwordOk = await verifyPassword(password, user ? { salt: user.passwordSalt, hash: user.passwordHash } : dummyPassword);
      if (!user || !user.active || !passwordOk) {
        const blocked = recordFailedLogin(key);
        return sendJson(res, blocked ? 429 : 401, { error: blocked ? "Too many sign-in attempts. Wait a few minutes before trying again." : "Username or password was not accepted." });
      }
      attempts.delete(key);
      const token = randomBytes(32).toString("base64url");
      const tokenHash = tokenKey(token);
      const expiresAt = Date.now() + sessionLifetime;
      sessions.set(tokenHash, { userId: user.id, expiresAt });
      await store?.saveSession({ tokenHash, userId: user.id, expiresAt });
      return sendJson(res, 200, { user: publicUser(user) }, { "Set-Cookie": cookieHeader(req, token, Math.floor(sessionLifetime / 1000)) });
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      await clearSession(req, res);
      return sendJson(res, 200, { ok: true });
    }

    const user = requireUser(req, res);
    if (!user) return;

    if (pathname === "/api/dashboard" && method === "GET") {
      return sendJson(res, 200, overviewFor(user));
    }

    if (pathname === "/api/cameras" && method === "GET") {
      const cameras = await camerasFor(user).catch(() => dashboard.cameras.filter((camera) => userCanSeeZone(user, camera.zoneId)).map(clone));
      const zoneIds = new Set(cameras.map((camera) => camera.zoneId));
      return sendJson(res, 200, {
        cameras,
        zones: dashboard.zones.filter((zone) => zoneIds.has(zone.id)),
        inference: { ...(await localVisionStatus()), canRun: hasPermission(user, "analyzeCameras") },
        storage: store ? "mongodb" : "memory"
      });
    }

    if (pathname === "/api/cameras/analyze" && method === "POST") {
      if (!hasPermission(user, "analyzeCameras")) return sendForbidden(res);
      const body = await readJson(req, 6_000_000);
      const zoneId = safeText(body.zoneId, 40);
      if (!ZONE_IDS.includes(zoneId) || !userCanSeeZone(user, zoneId)) return sendForbidden(res);
      const cameraId = safeText(body.cameraId, 100);
      if (!/^CAM-LOCAL-[A-Z0-9]+$/.test(cameraId)) return sendJson(res, 400, { error: "Camera identifier is invalid." });
      const camera = { id: cameraId, name: safeText(body.cameraName, 100) || "Local camera", zoneId };
      const result = await analyzeCameraFrame(user, camera, body);
      return sendJson(res, result.status, result.data ?? { error: result.error });
    }

    if (pathname === "/api/inference/status" && method === "GET") {
      return sendJson(res, 200, { ...(await localVisionStatus()), canRun: hasPermission(user, "analyzeCameras") });
    }

    if (pathname === "/api/notifications" && method === "GET") {
      const visibleZoneIds = dashboard.zones.filter((zone) => userCanSeeZone(user, zone.id)).map((zone) => zone.id);
      const rows = store ? await store.loadNotifications(visibleZoneIds) : notifications.filter((item) => visibleZoneIds.includes(item.zoneId)).slice(0, 30);
      return sendJson(res, 200, { notifications: sortAlertsByPriority(rows.map((item) => ({ ...item, priority: item.priority || priorityForAlert(item) }))) });
    }

    if (pathname === "/api/users" && method === "GET") {
      if (!hasPermission(user, "manageUsers")) return sendForbidden(res);
      return sendJson(res, 200, { users: visibleUsers() });
    }

    if (pathname === "/api/users" && method === "POST") {
      if (!hasPermission(user, "manageUsers")) return sendForbidden(res);
      const body = await readJson(req);
      const username = safeText(body.username, 32);
      const displayName = safeText(body.displayName, 80);
      const role = safeText(body.role, 32);
      const password = typeof body.password === "string" ? body.password : "";
      const zoneIds = Array.isArray(body.zoneIds) ? [...new Set(body.zoneIds)] : [];
      if (!validUsername(username)) return sendJson(res, 400, { error: "Use a username with 3 to 32 letters, numbers, dots, underscores, or hyphens." });
      if (users.has(username.toLowerCase())) return sendJson(res, 409, { error: "That username is already in use." });
      if (!displayName) return sendJson(res, 400, { error: "Enter a display name." });
      if (!allowedRoles.has(role)) return sendJson(res, 400, { error: "Choose Operator or Safety officer." });
      if (password.length < 12) return sendJson(res, 400, { error: "Set a temporary password with at least 12 characters." });
      if (role === "Operator" && (!zoneIds.length || zoneIds.some((zoneId) => !ZONE_IDS.includes(zoneId)))) {
        return sendJson(res, 400, { error: "Assign at least one valid zone to an operator." });
      }
      const assignedZones = role === "Operator" ? zoneIds : [...ZONE_IDS];
      const passwordRecord = makePasswordRecord(password);
      const created = {
        id: randomUUID(), username, displayName, role, active: true, zoneIds: assignedZones,
        canAcknowledge: role === "Operator" && Boolean(body.canAcknowledge),
        passwordSalt: passwordRecord.salt, passwordHash: passwordRecord.hash
      };
      users.set(username.toLowerCase(), created);
      await store?.saveUser(created);
      return sendJson(res, 201, { user: publicUser(created) });
    }

    const userRoute = pathname.match(/^\/api\/users\/([0-9a-f-]+)$/i);
    if (userRoute && method === "PATCH") {
      if (!hasPermission(user, "manageUsers")) return sendForbidden(res);
      const target = [...users.values()].find((candidate) => candidate.id === userRoute[1]);
      if (!target || target.role === "Administrator") return sendJson(res, 404, { error: "That user cannot be changed here." });
      const body = await readJson(req);
      const displayName = body.displayName === undefined ? target.displayName : safeText(body.displayName, 80);
      const role = body.role === undefined ? target.role : safeText(body.role, 32);
      const zoneIds = body.zoneIds === undefined ? target.zoneIds : (Array.isArray(body.zoneIds) ? [...new Set(body.zoneIds)] : []);
      const active = body.active === undefined ? target.active : body.active;
      const canAcknowledge = body.canAcknowledge === undefined ? target.canAcknowledge : Boolean(body.canAcknowledge);
      if (!displayName) return sendJson(res, 400, { error: "Enter a display name." });
      if (!allowedRoles.has(role)) return sendJson(res, 400, { error: "Choose Operator or Safety officer." });
      if (typeof active !== "boolean") return sendJson(res, 400, { error: "Choose whether the account is active." });
      if (role === "Operator" && (!zoneIds.length || zoneIds.some((zoneId) => !ZONE_IDS.includes(zoneId)))) {
        return sendJson(res, 400, { error: "Assign at least one valid zone to an operator." });
      }
      const password = typeof body.password === "string" ? body.password : "";
      if (password && password.length < 12) return sendJson(res, 400, { error: "Set a temporary password with at least 12 characters." });
      target.displayName = displayName;
      target.role = role;
      target.zoneIds = role === "Operator" ? zoneIds : [...ZONE_IDS];
      target.canAcknowledge = role === "Operator" && canAcknowledge;
      target.active = active;
      if (password) {
        const record = makePasswordRecord(password);
        target.passwordSalt = record.salt;
        target.passwordHash = record.hash;
        invalidateUserSessions(target.id);
      }
      if (!target.active || role !== "Operator") invalidateUserSessions(target.id);
      await store?.saveUser(target);
      for (const [key, session] of sessions) {
        if (session.userId === target.id) await store?.saveSession({ tokenHash: key, ...session });
      }
      return sendJson(res, 200, { user: publicUser(target) });
    }

    const recordingRoute = pathname.match(/^\/api\/incidents\/([A-Z0-9-]+)\/recording$/i);
    const recordingUploadRoute = pathname.match(/^\/api\/incidents\/([A-Z0-9-]+)\/recording\/upload$/i);
    const recordingStreamRoute = pathname.match(/^\/api\/incidents\/([A-Z0-9-]+)\/recording\/stream$/i);
    if (recordingUploadRoute && method === "POST") {
      const incident = dashboard.incidents.find((entry) => entry.id === recordingUploadRoute[1]);
      if (!incident || !userCanSeeZone(user, incident.zoneId)) return sendJson(res, 404, { error: "That incident is not in an assigned zone." });
      const body = await readJson(req, 11_500_000);
      const base64 = typeof body.base64 === "string" ? body.base64 : "";
      if (!/^video\/webm(?:;codecs=[a-z0-9,.-]+)?$/i.test(body.mimeType || "") || !/^[A-Za-z0-9+/=]+$/.test(base64)) return sendJson(res, 400, { error: "Upload a WebM recording from the active camera." });
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length || bytes.length > 8_000_000) return sendJson(res, 413, { error: "Recording clips must be under 8 MB." });
      const mimeType = safeText(body.mimeType, 80) || "video/webm";
      recordings.set(incident.id, { mimeType, data: bytes });
      await store?.saveRecording(incident.id, mimeType, bytes);
      incident.recording = { ...incident.recording, clipAvailable: true, durationSeconds: Math.max(1, Math.min(30, Number(body.durationSeconds) || 12)) };
      incident.trail.push({ kind: "instrument", actor: "Local camera recorder", detail: "A short camera clip captured around the detector signal was saved.", time: currentLocalTime() });
      await store?.saveRecord("incidents", incident);
      return sendJson(res, 201, { ok: true, incidentId: incident.id });
    }
    if (recordingStreamRoute && ["GET", "HEAD"].includes(method)) {
      const incident = dashboard.incidents.find((entry) => entry.id === recordingStreamRoute[1]);
      if (!incident || !userCanSeeZone(user, incident.zoneId)) return sendJson(res, 404, { error: "That incident is not in an assigned zone." });
      const recording = recordings.get(incident.id) ?? await store?.loadRecording(incident.id);
      if (!recording) return sendJson(res, 404, { error: "No camera clip was captured for this event. The camera must be active when the signal is raised." });
      const data = recording.data;
      let start = 0;
      let end = data.length - 1;
      const range = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
      if (range) {
        start = range[1] ? Number(range[1]) : 0;
        end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end || start >= data.length) {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${data.length}`);
          return res.end();
        }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`);
      } else res.statusCode = 200;
      res.setHeader("Content-Type", recording.mimeType || "video/webm");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(end - start + 1));
      res.setHeader("Cache-Control", "private, no-store");
      if (method === "HEAD") return res.end();
      return res.end(data.subarray(start, end + 1));
    }
    if (recordingRoute && method === "GET") {
      const incident = dashboard.incidents.find((entry) => entry.id === recordingRoute[1]);
      if (!incident || !userCanSeeZone(user, incident.zoneId)) return sendJson(res, 404, { error: "That incident is not in an assigned zone." });
      const recording = incident.recording ?? {};
      const clip = recordings.get(incident.id) ?? await store?.loadRecording(incident.id);
      return sendJson(res, 200, {
        incidentId: incident.id,
        camera: incident.cameraId ? { id: incident.cameraId, name: incident.cameraName || incident.cameraId, zoneId: incident.zoneId } : null,
        videoUrl: clip ? `/api/incidents/${encodeURIComponent(incident.id)}/recording/stream` : null,
        startSeconds: 0,
        durationSeconds: Math.max(1, Number(recording.durationSeconds) || 12),
        clipDurationSeconds: Number(recording.durationSeconds) || null,
        overlay: recording.outline ?? null,
        overlaySource: recording.overlaySource ?? "model",
        isDemoFootage: false,
        message: clip ? "" : "No clip was captured. Keep the camera active while the detector is running to save event footage."
      });
    }

    const reviewRoute = pathname.match(/^\/api\/incidents\/([A-Z0-9-]+)\/review$/i);
    if (reviewRoute && method === "POST") {
      const incident = dashboard.incidents.find((item) => item.id === reviewRoute[1]);
      if (!incident) return sendJson(res, 404, { error: "This incident is no longer available." });
      const body = await readJson(req);
      const result = updateIncidentForAction(user, incident, body.action);
      if (result.status === 200) await store?.saveRecord("incidents", incident);
      return sendJson(res, result.status, result.data ? { incident: result.data } : { error: result.error });
    }

    if (pathname === "/api/incidents" && method === "DELETE") {
      if (!hasPermission(user, "resetDemo")) return sendForbidden(res);
      const removed = dashboard.incidents.length;
      await store?.clearAlertData();
      dashboard.incidents = [];
      notifications.length = 0;
      recordings.clear();
      incidentCooldowns.clear();
      return sendJson(res, 200, { ok: true, removed });
    }

    if (pathname === "/api/demo/reset" && method === "POST") {
      if (!hasPermission(user, "resetDemo")) return sendForbidden(res);
      dashboard = createInitialDashboard();
      notifications.length = 0;
      recordings.clear();
      await store?.replaceDashboard(dashboard);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "That endpoint is not available." });
  }

  const middleware = (req, res, next) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!pathname.startsWith("/api/")) return next();
    Promise.resolve(dispatch(req, res, pathname)).catch((error) => {
      if (!res.headersSent) sendJson(res, error.statusCode ?? 500, { error: error.statusCode ? error.message : "The local demo service could not complete that request." });
      else res.end();
    });
  };

  function requireSetup() {
    if (!ready) throw new Error("Set ADMIN_USERNAME and ADMIN_PASSWORD in the ignored .env.local file before starting the demo server.");
  }

  function configure(server) {
    requireSetup();
    storeReady = initializeStore().catch((error) => {
      storeFailure = error;
      if (error?.name === "MongoParseError") {
        console.error("[factory-safety] MongoDB URI is invalid. Check its scheme and percent-encode reserved characters in the database username or password.");
      } else {
        console.error(`[factory-safety] MongoDB initialization failed (${error?.name ?? "Error"}). Check the URI, database user permissions, and Atlas network access list.`);
      }
    });
    server.middlewares.use(middleware);
  }

  return {
    name: "factory-safety-demo-auth",
    configureServer: configure,
    configurePreviewServer: configure
  };
}
