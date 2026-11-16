import { MongoClient } from "mongodb";

const tableNames = ["factories", "zones", "devices", "cameras", "workers", "incidents", "recordings", "users", "sessions", "notifications", "app_state"];

function withoutMongoId(document) {
  if (!document) return document;
  const { _id, ...record } = document;
  return record;
}

function persistenceRecord(record) {
  const { _id, ...plain } = record;
  return plain;
}

function orderedRows(rows, fallback) {
  if (!rows.length) return fallback;
  const records = new Map(rows.map((row) => [row.id, withoutMongoId(row)]));
  const result = fallback.map((row) => records.get(row.id)).filter(Boolean);
  const known = new Set(result.map((row) => row.id));
  for (const row of rows) if (!known.has(row.id)) result.push(withoutMongoId(row));
  return result;
}

function orderedIncidents(rows, fallback) {
  const result = orderedRows(rows, fallback);
  const fallbackOrder = new Map(fallback.map((row, index) => [row.id, index]));
  return result.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || "");
    const rightTime = Date.parse(right.createdAt || "");
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    return (fallbackOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (fallbackOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER);
  });
}

export async function openMongoStore(uri, databaseName, initialDashboard) {
  if (!uri) return null;
  const client = new MongoClient(uri, {
    appName: "factory-safety-console",
    serverSelectionTimeoutMS: 6000,
    maxPoolSize: 10
  });
  await client.connect();
  const db = client.db(databaseName || "factory_safety");
  await db.command({ ping: 1 });

  const collections = Object.fromEntries(tableNames.map((name) => [name, db.collection(name)]));
  await Promise.all([
    collections.factories.createIndex({ id: 1 }, { unique: true }),
    collections.zones.createIndex({ id: 1 }, { unique: true }),
    collections.devices.createIndex({ id: 1 }, { unique: true }),
    collections.cameras.createIndex({ id: 1 }, { unique: true }),
    collections.workers.createIndex({ id: 1 }, { unique: true }),
    collections.incidents.createIndex({ id: 1 }, { unique: true }),
    collections.incidents.createIndex({ zoneId: 1, createdAt: -1 }),
    collections.recordings.createIndex({ incidentId: 1 }, { unique: true }),
    collections.users.createIndex({ id: 1 }, { unique: true }),
    collections.users.createIndex({ usernameNormalized: 1 }, { unique: true }),
    collections.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.notifications.createIndex({ createdAt: -1 }),
    collections.app_state.createIndex({ id: 1 }, { unique: true })
  ]);

  const alertSeedState = await collections.app_state.findOne({ id: "alert-data-seed" });

  await seedRows(collections.factories, [initialDashboard.site]);
  await seedRows(collections.zones, initialDashboard.zones);
  await seedRows(collections.devices, initialDashboard.devices);
  await seedRows(collections.cameras, initialDashboard.cameras ?? []);
  await seedRows(collections.workers, initialDashboard.workers);
  if (!alertSeedState) {
    await seedRows(collections.incidents, initialDashboard.incidents);
    await collections.app_state.updateOne(
      { id: "alert-data-seed" },
      { $setOnInsert: { id: "alert-data-seed", createdAt: new Date() } },
      { upsert: true }
    );
  }

  return {
    mode: "mongodb",
    async pruneLegacyDemoData() {
      const sampleCameraIds = ["CAM-04", "CAM-05", "CAM-09", "CAM-12"];
      const sampleDeviceIds = [...sampleCameraIds, "PPE-02", "SMK-06", "TMP-03", "SMK-11"];
      const sampleIncidentIds = ["EV-204", "EV-203", "EV-201", "EV-198"];
      const sampleWorkerIds = ["WRK-014", "WRK-018", "WRK-021", "WRK-038", "WRK-041", "WRK-044", "WRK-048", "WRK-052", "WRK-060", "WRK-063"];
      await Promise.all([
        collections.cameras.deleteMany({ $or: [{ sourceType: "public-demo" }, { id: { $in: sampleCameraIds } }] }),
        collections.devices.deleteMany({ id: { $in: sampleDeviceIds } }),
        collections.workers.deleteMany({ id: { $in: sampleWorkerIds } }),
        collections.incidents.deleteMany({ $or: [{ id: { $in: sampleIncidentIds } }, { source: "sample" }] }),
        collections.recordings.deleteMany({ incidentId: { $in: sampleIncidentIds } }),
        collections.notifications.deleteMany({ incidentId: { $in: sampleIncidentIds } })
      ]);
      const zones = await collections.zones.find({}).toArray();
      await Promise.all(zones.map((row) => {
        const deviceIds = (row.deviceIds || []).filter((id) => !sampleDeviceIds.includes(id));
        const workerIds = (row.workerIds || []).filter((id) => !sampleWorkerIds.includes(id));
        return collections.zones.updateOne({ _id: row._id }, { $set: { deviceIds, workerIds } });
      }));
    },
    async loadDashboard(fallback) {
      const [siteDoc, zones, devices, cameras, workers, incidents] = await Promise.all([
        collections.factories.findOne({ id: fallback.site.id }),
        collections.zones.find({}).toArray(),
        collections.devices.find({}).toArray(),
        collections.cameras.find({}).toArray(),
        collections.workers.find({}).toArray(),
        collections.incidents.find({}).sort({ createdAt: -1 }).toArray()
      ]);
      return {
        site: withoutMongoId(siteDoc) ?? fallback.site,
        zones: orderedRows(zones, fallback.zones),
        devices: orderedRows(devices, fallback.devices),
        cameras: orderedRows(cameras, fallback.cameras ?? []),
        workers: orderedRows(workers, fallback.workers),
        incidents: orderedIncidents(incidents, fallback.incidents)
      };
    },
    async loadUsers() {
      return (await collections.users.find({}).toArray()).map(withoutMongoId);
    },
    async saveUser(user) {
      const record = { ...persistenceRecord(user), usernameNormalized: user.username.toLowerCase() };
      await collections.users.replaceOne({ id: user.id }, record, { upsert: true });
    },
    async loadSessions() {
      const rows = await collections.sessions.find({ expiresAt: { $gt: new Date() } }).toArray();
      return rows.map((row) => ({ tokenHash: row.tokenHash, userId: row.userId, expiresAt: row.expiresAt.getTime() }));
    },
    async saveSession(session) {
      await collections.sessions.replaceOne(
        { tokenHash: session.tokenHash },
        { tokenHash: session.tokenHash, userId: session.userId, expiresAt: new Date(session.expiresAt) },
        { upsert: true }
      );
    },
    async deleteSession(tokenHash) {
      await collections.sessions.deleteOne({ tokenHash });
    },
    async saveRecord(table, record) {
      if (!collections[table]) throw new Error("Unknown persistence collection.");
      await collections[table].replaceOne({ id: record.id }, persistenceRecord(record), { upsert: true });
    },
    async saveRecording(incidentId, mimeType, data) {
      await collections.recordings.replaceOne({ incidentId }, { incidentId, mimeType, data: Buffer.from(data), createdAt: new Date() }, { upsert: true });
    },
    async loadRecording(incidentId) {
      const row = await collections.recordings.findOne({ incidentId });
      if (!row) return null;
      const binary = row.data;
      const data = Buffer.isBuffer(binary) ? binary : Buffer.from(binary?.buffer ?? binary?.value?.() ?? []);
      return { mimeType: row.mimeType || "video/webm", data: binary?.position ? data.subarray(0, binary.position) : data };
    },
    async saveNotification(notification) {
      await collections.notifications.insertOne(persistenceRecord(notification));
    },
    async loadNotifications(zoneIds, limit = 30) {
      return (await collections.notifications.find({ zoneId: { $in: zoneIds } }).sort({ createdAt: -1 }).limit(limit).toArray()).map(withoutMongoId);
    },
    async replaceDashboard(dashboard) {
      await replaceRows(collections.factories, [dashboard.site]);
      await replaceRows(collections.zones, dashboard.zones);
      await replaceRows(collections.devices, dashboard.devices);
      await replaceRows(collections.cameras, dashboard.cameras ?? []);
      await replaceRows(collections.workers, dashboard.workers);
      await replaceRows(collections.incidents, dashboard.incidents);
      await collections.recordings.deleteMany({});
      await collections.notifications.deleteMany({});
    },
    async clearAlertData() {
      await collections.app_state.updateOne(
        { id: "alert-data-seed" },
        { $setOnInsert: { id: "alert-data-seed", createdAt: new Date() }, $set: { clearedAt: new Date() } },
        { upsert: true }
      );
      await Promise.all([
        collections.incidents.deleteMany({}),
        collections.recordings.deleteMany({}),
        collections.notifications.deleteMany({})
      ]);
    },
    async close() {
      await client.close();
    }
  };
}

async function seedRows(collection, records) {
  if (await collection.estimatedDocumentCount() === 0 && records.length) {
    await collection.insertMany(records.map(persistenceRecord));
  }
}

async function replaceRows(collection, records) {
  await collection.deleteMany({});
  if (records.length) await collection.insertMany(records.map(persistenceRecord));
}
