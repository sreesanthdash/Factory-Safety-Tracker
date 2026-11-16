import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, jsonRequest } from "./api.js";

const DevicesContext = createContext(null);

function cameraId(deviceId) {
  let hash = 2166136261;
  for (let index = 0; index < deviceId.length; index += 1) hash = Math.imul(hash ^ deviceId.charCodeAt(index), 16777619);
  return `CAM-LOCAL-${(hash >>> 0).toString(36).toUpperCase()}`;
}

function supportedRecordingType() {
  if (typeof MediaRecorder === "undefined") return "";
  return ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

export function DevicesProvider({ children }) {
  const [cameras, setCameras] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [streams, setStreams] = useState({});
  const [monitoring, setMonitoring] = useState(false);
  const [cameraAnalysis, setCameraAnalysis] = useState({});
  const [inferenceStatus, setInferenceStatus] = useState(null);
  const [cameraError, setCameraError] = useState("");
  const [cameraBusy, setCameraBusy] = useState(false);
  const [zoneAssignments, setZoneAssignments] = useState(() => {
    try { return JSON.parse(localStorage.getItem("safety.cameraZones") || "{}"); } catch { return {}; }
  });
  const [sensors, setSensors] = useState([]);
  const [sensorError, setSensorError] = useState("");
  const [sensorConnected, setSensorConnected] = useState(false);
  const streamsRef = useRef(new Map());
  const captureVideosRef = useRef(new Map());
  const monitoringRef = useRef(false);
  const analysisBusyRef = useRef(false);
  const captureJobsRef = useRef(new Map());
  const captureRecordersRef = useRef(new Set());
  const serialPortRef = useRef(null);
  const serialIntentionalRef = useRef(false);

  const listCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error("Camera access is unavailable here. Open the app on localhost or HTTPS in a supported browser.");
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((item) => item.kind === "videoinput");
    const next = inputs.map((item, index) => ({
      id: cameraId(item.deviceId || item.label || `camera-${index}`),
      deviceId: item.deviceId,
      name: item.label || `Camera ${index + 1}`,
      connected: true,
      status: "available"
    }));
    setCameras((current) => {
      const presentIds = new Set(next.map((item) => item.id));
      const discovered = next.map((item) => ({ ...item, status: streamsRef.current.has(item.id) ? "streaming" : current.find((old) => old.id === item.id)?.status === "streaming" ? "available" : "available" }));
      const missing = current.filter((item) => !presentIds.has(item.id)).map((item) => ({ ...item, connected: false, status: "malfunctioned" }));
      return [...discovered, ...missing];
    });
    setSelectedId((current) => next.some((item) => item.id === current) ? current : next[0]?.id || "");
    return next;
  }, []);

  const stopCamera = useCallback((id) => {
    const targets = id ? [id] : [...streamsRef.current.keys()];
    for (const cameraId of targets) {
      streamsRef.current.get(cameraId)?.getTracks().forEach((track) => track.stop());
      streamsRef.current.delete(cameraId);
      const video = captureVideosRef.current.get(cameraId);
      if (video) video.srcObject = null;
      captureVideosRef.current.delete(cameraId);
    }
    setStreams(Object.fromEntries(streamsRef.current));
    setCameras((current) => current.map((item) => ({ ...item, status: streamsRef.current.has(item.id) ? "streaming" : item.connected ? "available" : item.status })));
    setCameraAnalysis((current) => {
      const updated = { ...current };
      targets.forEach((cameraId) => delete updated[cameraId]);
      return updated;
    });
    if (!id || streamsRef.current.size === 0) {
      monitoringRef.current = false;
      setMonitoring(false);
    }
  }, []);

  const startCamera = useCallback(async (id = selectedId) => {
    const target = cameras.find((item) => item.id === id);
    if (!target) {
      setCameraError("No camera is available. Connect a camera, then scan again.");
      return;
    }
    setCameraBusy(true);
    setCameraError("");
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: target.deviceId }, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 15, max: 20 } }
      });
      streamsRef.current.set(target.id, media);
      const video = document.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = media;
      video.play().catch(() => {});
      captureVideosRef.current.set(target.id, video);
      setStreams(Object.fromEntries(streamsRef.current));
      setSelectedId(target.id);
      setCameras((current) => current.map((item) => ({ ...item, status: streamsRef.current.has(item.id) ? "streaming" : item.connected ? "available" : item.status })));
      monitoringRef.current = true;
      setMonitoring(true);
      const track = media.getVideoTracks()[0];
      track?.addEventListener("ended", () => {
        if (streamsRef.current.get(target.id) !== media) return;
        streamsRef.current.delete(target.id);
        const captureVideo = captureVideosRef.current.get(target.id);
        if (captureVideo) captureVideo.srcObject = null;
        captureVideosRef.current.delete(target.id);
        setStreams(Object.fromEntries(streamsRef.current));
        setCameras((current) => current.map((item) => item.id === target.id ? { ...item, status: "malfunctioned" } : item));
        if (!streamsRef.current.size) { monitoringRef.current = false; setMonitoring(false); }
        setCameraError(`${target.name} stopped unexpectedly. Reconnect it or select another camera.`);
      }, { once: true });
      track?.addEventListener("mute", () => setCameras((current) => current.map((item) => item.id === target.id ? { ...item, status: "unresponsive" } : item)));
      track?.addEventListener("unmute", () => setCameras((current) => current.map((item) => item.id === target.id ? { ...item, status: "streaming" } : item)));
    } catch (error) {
      setCameraError(error.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in the browser address bar and scan again." : error.name === "NotFoundError" ? "The selected camera is no longer connected." : error.message || "The camera could not be opened.");
      setCameras((current) => current.map((item) => item.id === id ? { ...item, status: error.name === "NotFoundError" ? "malfunctioned" : "available" } : item));
    } finally {
      setCameraBusy(false);
    }
  }, [cameras, selectedId]);

  const startAllCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access requires localhost or HTTPS in a supported browser.");
      return;
    }
    setCameraBusy(true);
    setCameraError("");
    let permissionStream;
    const failures = [];
    try {
      if (!streamsRef.current.size) {
        permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        permissionStream.getTracks().forEach((track) => track.stop());
      }
      const found = await listCameras();
      if (!found.length) {
        setCameraError("No camera detected. A connected phone must be exposed to Windows as a webcam.");
        return;
      }
      for (const camera of found) {
        if (streamsRef.current.has(camera.id)) continue;
        try {
          const media = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { deviceId: { exact: camera.deviceId }, width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 10, max: 15 } }
          });
          streamsRef.current.set(camera.id, media);
          const video = document.createElement("video");
          video.muted = true;
          video.autoplay = true;
          video.playsInline = true;
          video.srcObject = media;
          video.play().catch(() => {});
          captureVideosRef.current.set(camera.id, video);
          const track = media.getVideoTracks()[0];
          track?.addEventListener("ended", () => {
            if (streamsRef.current.get(camera.id) !== media) return;
            streamsRef.current.delete(camera.id);
            const captureVideo = captureVideosRef.current.get(camera.id);
            if (captureVideo) captureVideo.srcObject = null;
            captureVideosRef.current.delete(camera.id);
            setStreams(Object.fromEntries(streamsRef.current));
            setCameras((current) => current.map((item) => item.id === camera.id ? { ...item, status: "malfunctioned" } : item));
            if (!streamsRef.current.size) { monitoringRef.current = false; setMonitoring(false); }
            setCameraError(`${camera.name} stopped unexpectedly. Reconnect it or select another camera.`);
          }, { once: true });
          track?.addEventListener("mute", () => setCameras((current) => current.map((item) => item.id === camera.id ? { ...item, status: "unresponsive" } : item)));
          track?.addEventListener("unmute", () => setCameras((current) => current.map((item) => item.id === camera.id ? { ...item, status: "streaming" } : item)));
        } catch (error) {
          failures.push(`${camera.name}: ${error.name === "NotReadableError" ? "camera is already in use" : error.message || "could not open"}`);
        }
      }
      setStreams(Object.fromEntries(streamsRef.current));
      setCameras((current) => current.map((item) => ({ ...item, status: streamsRef.current.has(item.id) ? "streaming" : item.connected ? "available" : item.status })));
      setSelectedId((current) => streamsRef.current.has(current) ? current : streamsRef.current.keys().next().value || "");
      if (streamsRef.current.size) {
        monitoringRef.current = true;
        setMonitoring(true);
        setCameraError(failures.length ? `${streamsRef.current.size} camera(s) started. ${failures.join("; ")}` : "");
      } else {
        setCameraError(failures.length ? failures.join("; ") : "No cameras could be opened.");
      }
    } catch (error) {
      setCameraError(error.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in the browser address bar, then try again." : error.message || "Could not start the connected cameras.");
    } finally {
      permissionStream?.getTracks().forEach((track) => { if (track.readyState === "live") track.stop(); });
      setCameraBusy(false);
    }
  }, [listCameras]);

  const scanCameras = useCallback(async () => {
    setCameraBusy(true);
    setCameraError("");
    let permissionStream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires localhost or HTTPS in a supported browser.");
      if (!streamsRef.current.size) {
        permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        permissionStream.getTracks().forEach((track) => track.stop());
      }
      const found = await listCameras();
      if (!found.length) setCameraError("No camera detected. A connected phone must be exposed to Windows as a webcam.");
      return found;
    } catch (error) {
      setCameraError(error.name === "NotAllowedError" ? "Camera permission was denied. Allow it in the browser address bar, then scan again." : error.message || "Could not discover cameras.");
      return [];
    } finally {
      permissionStream?.getTracks().forEach((track) => { if (track.readyState === "live") track.stop(); });
      setCameraBusy(false);
    }
  }, [listCameras]);

  const assignZone = useCallback((id, zoneId) => {
    setZoneAssignments((current) => {
      const updated = { ...current, [id]: zoneId };
      localStorage.setItem("safety.cameraZones", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const captureIncidentRecording = useCallback(async (incidentId, cameraId = selectedId) => {
    if (captureJobsRef.current.has(incidentId)) return captureJobsRef.current.get(incidentId);
    const media = streamsRef.current.get(cameraId) || streamsRef.current.values().next().value;
    const type = supportedRecordingType();
    if (!media || !type) return false;
    if (captureRecordersRef.current.size >= 2) throw new Error("Two incident clips are already being captured. Wait a few seconds and retry.");
    const recorder = new MediaRecorder(media, { mimeType: type, videoBitsPerSecond: 650_000 });
    const chunks = [];
    const job = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error("The camera clip could not be recorded."));
      recorder.onstop = async () => {
        captureRecordersRef.current.delete(recorder);
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
          if (!blob.size) return resolve(false);
          if (blob.size > 8_000_000) throw new Error("The camera clip exceeded 8 MB and was not saved.");
          const base64 = await new Promise((innerResolve, innerReject) => {
            const reader = new FileReader();
            reader.onload = () => innerResolve(String(reader.result).split(",")[1] || "");
            reader.onerror = () => innerReject(new Error("The camera clip could not be prepared."));
            reader.readAsDataURL(blob);
          });
          await api(`/api/incidents/${encodeURIComponent(incidentId)}/recording/upload`, jsonRequest("POST", { mimeType: blob.type || "video/webm", base64, durationSeconds: 8 }));
          resolve(true);
        } catch (error) { reject(error); }
      };
      recorder.start(1000);
      captureRecordersRef.current.add(recorder);
      window.setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 8000);
    });
    captureJobsRef.current.set(incidentId, job);
    try { return await job; } finally { captureJobsRef.current.delete(incidentId); }
  }, [selectedId]);

  useEffect(() => {
    if (!monitoring || !Object.keys(streams).length) return undefined;
    let cancelled = false;
    let timer;
    let lastStatusCheck = 0;
    let lastZoneCheck = 0;
    let status = null;
    let zones = [];

    const setCameraMessage = (cameraId, message, extra = {}) => {
      setCameraAnalysis((current) => ({ ...current, [cameraId]: { ...current[cameraId], ...extra, message } }));
    };

    const analyze = async () => {
      if (cancelled) return;
      if (analysisBusyRef.current) {
        timer = window.setTimeout(analyze, 1000);
        return;
      }
      analysisBusyRef.current = true;
      try {
        if (!status || Date.now() - lastStatusCheck > 30_000) {
          status = await api("/api/inference/status");
          lastStatusCheck = Date.now();
          if (!cancelled) setInferenceStatus(status);
        }
        if (!status.canRun) {
          for (const cameraId of streamsRef.current.keys()) setCameraMessage(cameraId, "Your account cannot analyze cameras.");
          return;
        }
        if (!status.enabled) {
          for (const cameraId of streamsRef.current.keys()) setCameraMessage(cameraId, status.message || "Configure model weights to begin automatic analysis.");
          return;
        }
        if (!zones.length || Date.now() - lastZoneCheck > 60_000) {
          const dashboard = await api("/api/dashboard");
          zones = dashboard.zones || [];
          lastZoneCheck = Date.now();
        }

        for (const [cameraId, media] of [...streamsRef.current.entries()]) {
          if (cancelled) break;
          const video = captureVideosRef.current.get(cameraId);
          if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 960 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) continue;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const zoneId = zoneAssignments[cameraId] || zones[0]?.id;
          if (!zoneId) continue;
          try {
            const camera = cameras.find((item) => item.id === cameraId);
            const result = await api("/api/cameras/analyze", jsonRequest("POST", {
              imageData: canvas.toDataURL("image/jpeg", 0.72),
              cameraId,
              cameraName: camera?.name || "Local camera",
              zoneId,
              frameTimeSeconds: video.currentTime
            }));
            if (cancelled || streamsRef.current.get(cameraId) !== media) continue;
            const predictions = result.predictions || [];
            setCameraAnalysis((current) => ({ ...current, [cameraId]: { predictions, message: `${predictions.length} prediction${predictions.length === 1 ? "" : "s"} · analyzed ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`, analyzedAt: Date.now(), error: "" } }));
            for (const incident of result.incidents || []) {
              void captureIncidentRecording(incident.id, cameraId).then((saved) => {
                if (!cancelled) setCameraMessage(cameraId, saved ? `Incident ${incident.id} logged · footage saved.` : `Incident ${incident.id} logged · recording unavailable.`, { analyzedAt: Date.now() });
              }).catch((error) => {
                if (!cancelled) setCameraMessage(cameraId, `Incident ${incident.id} logged · ${error.message}`, { analyzedAt: Date.now() });
              });
            }
          } catch (error) {
            if (!cancelled) setCameraAnalysis((current) => ({ ...current, [cameraId]: { ...current[cameraId], error: error.message, message: `Analysis paused for this camera: ${error.message}` } }));
          }
        }
      } catch (error) {
        if (!cancelled) {
          setInferenceStatus((current) => ({ ...(current || {}), available: false, message: error.message }));
          for (const cameraId of streamsRef.current.keys()) setCameraMessage(cameraId, `Vision service unavailable: ${error.message}`);
        }
      } finally {
        analysisBusyRef.current = false;
        if (!cancelled) timer = window.setTimeout(analyze, 1000);
      }
    };

    analyze();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [monitoring, streams, cameras, zoneAssignments, captureIncidentRecording]);

  const connectSensor = useCallback(async (zoneId) => {
    if (!navigator.serial?.requestPort) {
      setSensorError("This browser does not support Web Serial. Use Chrome or Edge on localhost/HTTPS, or connect a sensor through a local hardware gateway.");
      return;
    }
    setSensorError("");
    try {
      serialIntentionalRef.current = false;
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 9600 });
      serialPortRef.current = port;
      setSensorConnected(true);
      const info = port.getInfo?.() || {};
      const sensorId = `SERIAL-${(info.usbVendorId || 0).toString(16)}-${(info.usbProductId || 0).toString(16)}`.toUpperCase();
      const sensor = { id: sensorId, type: "Serial safety sensor", zoneId, status: "waiting", connectedAt: Date.now(), lastSignal: "", protocol: "JSON Lines / 9600 baud" };
      setSensors([sensor]);
      const decoder = new TextDecoderStream();
      const pipeClosed = port.readable.pipeTo(decoder.writable).catch(() => {});
      const reader = decoder.readable.getReader();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += value;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const packet = JSON.parse(line);
            const now = new Date().toISOString();
            setSensors((current) => current.map((item) => ({ ...item, status: "reporting", lastSignal: now })));
            const type = String(packet.type || packet.signalType || "").toLowerCase();
            const triggered = packet.triggered === true || packet.status === "triggered" || (Number.isFinite(Number(packet.value)) && Number.isFinite(Number(packet.threshold)) && Number(packet.value) >= Number(packet.threshold));
            if (triggered && ["smoke", "fire", "electrical", "short_circuit", "fight", "accident", "ppe"].includes(type)) {
              const signalType = ({ fire: "smoke", short_circuit: "electrical" })[type] || type;
              const localCamera = cameras.find((item) => streamsRef.current.has(item.id) && (zoneAssignments[item.id] || zoneId) === zoneId) || cameras.find((item) => item.id === selectedId && streamsRef.current.has(item.id));
              const result = await api("/api/device-events", jsonRequest("POST", { signalType, zoneId, deviceId: sensorId, ...(localCamera ? { cameraId: localCamera.id, cameraName: localCamera.name } : {}), description: `Connected sensor reported ${type}${packet.value !== undefined ? ` at ${packet.value}` : ""}. Human review is required.`, confidence: Number(packet.confidence) || 1 }));
              if (result.incident && localCamera) void captureIncidentRecording(result.incident.id, localCamera.id).catch(() => {});
            }
          } catch (error) {
            if (error instanceof SyntaxError) setSensorError("Sensor input must be newline-delimited JSON. See the protocol note below the sensor list.");
            else setSensorError(error.message);
          }
        }
      }
      await pipeClosed;
    } catch (error) {
      if (!serialIntentionalRef.current && error.name !== "NotFoundError") setSensorError(error.message || "Could not connect to the sensor.");
      setSensorConnected(false);
      setSensors((current) => current.map((item) => ({ ...item, status: serialIntentionalRef.current ? "disconnected" : "malfunctioned" })));
    }
  }, [cameras, captureIncidentRecording, selectedId, zoneAssignments]);

  const disconnectSensor = useCallback(async () => {
    serialIntentionalRef.current = true;
    try { await serialPortRef.current?.close(); } catch { /* disconnected */ }
    serialPortRef.current = null;
    setSensorConnected(false);
    setSensors((current) => current.map((item) => ({ ...item, status: "disconnected" })));
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return undefined;
    const onDeviceChange = () => { listCameras().catch(() => {}); };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
  }, [listCameras]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const threshold = Date.now() - 30_000;
      setSensors((current) => current.map((sensor) => ["reporting", "waiting"].includes(sensor.status) && (sensor.lastSignal ? Date.parse(sensor.lastSignal) : sensor.connectedAt) < threshold ? { ...sensor, status: "unresponsive" } : sensor));
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    streamsRef.current.forEach((media) => media.getTracks().forEach((track) => track.stop()));
    streamsRef.current.clear();
    captureVideosRef.current.forEach((video) => { video.srcObject = null; });
    captureVideosRef.current.clear();
    captureRecordersRef.current.forEach((recorder) => { if (recorder.state === "recording") recorder.stop(); });
    serialPortRef.current?.close().catch(() => {});
  }, []);

  const value = useMemo(() => ({ cameras, selectedId, setSelectedId, streams, monitoring, cameraAnalysis, inferenceStatus, cameraError, cameraBusy, scanCameras, listCameras, startCamera, startAllCameras, stopCamera, zoneAssignments, assignZone, captureIncidentRecording, sensors, sensorError, sensorConnected, connectSensor, disconnectSensor }), [cameras, selectedId, streams, monitoring, cameraAnalysis, inferenceStatus, cameraError, cameraBusy, scanCameras, listCameras, startCamera, startAllCameras, stopCamera, zoneAssignments, assignZone, captureIncidentRecording, sensors, sensorError, sensorConnected, connectSensor, disconnectSensor]);
  return <DevicesContext.Provider value={value}>{children}</DevicesContext.Provider>;
}

export const useDevices = () => useContext(DevicesContext);
