import mqtt from "mqtt";
import { config } from "./config.ts";
import { logger } from "./logger.ts";

let client: ReturnType<typeof mqtt.connect> | null = null;
const pendingAcks = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

export function getMqttClient() {
  if (client) return client;

  client = mqtt.connect(config.mqttUrl, {
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    clientId: `home-server-${Date.now()}`,
  });

  client.on("connect", () => {
    logger.info("MQTT connected to", config.mqttUrl);
  });

  client.on("error", (err) => {
    logger.error("MQTT error:", err.message);
  });

  client.on("message", (topic, payload) => {
    const msg = JSON.parse(payload.toString());
    if (msg.id && pendingAcks.has(msg.id)) {
      const entry = pendingAcks.get(msg.id)!;
      clearTimeout(entry.timer);
      pendingAcks.delete(msg.id);
      entry.resolve(msg);
      logger.info("ACK received for", msg.id, "on", topic);
    }
  });

  return client;
}

export async function publishCommand(nodeId: string, cmd: Record<string, unknown>): Promise<void> {
  const topic = `home/${nodeId}/cmd`;
  const ackTopic = `home/${nodeId}/ack`;

  const mqttClient = getMqttClient();
  mqttClient.subscribe(ackTopic);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(cmd.id as string);
      logger.warn("Command ACK timeout for", cmd.id);
      reject(new Error(`Command ${cmd.id} timed out after 10s`));
    }, 10000);

    pendingAcks.set(cmd.id as string, { resolve, reject, timer });

    mqttClient.publish(topic, JSON.stringify(cmd), { qos: 1 }, (err) => {
      if (err) {
        clearTimeout(timer);
        pendingAcks.delete(cmd.id as string);
        reject(err);
      } else {
        logger.info("Published to", topic, JSON.stringify(cmd));
      }
    });
  });
}
