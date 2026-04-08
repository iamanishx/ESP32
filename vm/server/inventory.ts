export interface DeviceEntry {
  room: string;
  device: string;
  nodeId: string;
  relay: number;
  activeLow: boolean;
  supports: string[];
}

export const deviceInventory: DeviceEntry[] = [
  {
    room: "living_room",
    device: "light",
    nodeId: "esp32-livingroom-01",
    relay: 1,
    activeLow: false,
    supports: ["on", "off"],
  },
  {
    room: "bedroom",
    device: "light",
    nodeId: "esp32-livingroom-01",
    relay: 2,
    activeLow: false,
    supports: ["on", "off"],
  },
];

export function findDevice(room: string, device: string): DeviceEntry | undefined {
  return deviceInventory.find(
    (d) => d.room === room && d.device === device
  );
}

export function getInventorySummary(): string {
  return deviceInventory
    .map(
      (d) =>
        `- ${d.room} ${d.device} (relay ${d.relay}, supports: ${d.supports.join(", ")})`
    )
    .join("\n");
}
