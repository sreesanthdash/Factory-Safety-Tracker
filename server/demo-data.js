const initialDashboard = {
  site: { id: "site-example", name: "Example Works", area: "North floor" },
  zones: [
    { id: "assembly", name: "Assembly", deviceIds: [], workerIds: [] },
    { id: "welding", name: "Welding bay", deviceIds: [], workerIds: [] },
    { id: "packing", name: "Packing", deviceIds: [], workerIds: [] },
    { id: "loading", name: "Loading dock", deviceIds: [], workerIds: [] }
  ],
  workers: [],
  devices: [],
  cameras: [],
  incidents: []
};

export const ZONE_IDS = initialDashboard.zones.map((zone) => zone.id);

export function createInitialDashboard() {
  return structuredClone(initialDashboard);
}
