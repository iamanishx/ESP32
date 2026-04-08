import { load } from "@std/dotenv";

const env = await load({ export: true });

export const config = {
  port: parseInt(env.PORT || "8080"),
  deepInfraApiKey: env.DEEPINFRA_API_KEY || "",
  deepgramApiKey: env.DEEPGRAM_API_KEY || "",
  mqttUrl: env.MQTT_URL || "mqtt://localhost:1883",
  mqttUsername: env.MQTT_USERNAME || "",
  mqttPassword: env.MQTT_PASSWORD || "",
  deviceToken: env.DEVICE_TOKEN || "dev-token-change-me",
  logLevel: env.LOG_LEVEL || "info",
  audioSavePath: env.AUDIO_SAVE_PATH || "./recordings",
};

if (!config.deepInfraApiKey) {
  console.warn("WARN: DEEPINFRA_API_KEY not set - LLM will fail");
}
if (!config.deepgramApiKey) {
  console.warn("WARN: DEEPGRAM_API_KEY not set - STT will fail");
}
