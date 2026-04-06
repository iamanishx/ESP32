import { load } from "@std/dotenv";

const env = await load({ export: true });

export const config = {
  port: parseInt(env.PORT || "8080"),
  openRouterApiKey: env.OPENROUTER_API_KEY || "",
  awsRegion: env.AWS_REGION || "us-east-1",
  awsAccessKeyId: env.AWS_ACCESS_KEY_ID || "",
  awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY || "",
  mqttUrl: env.MQTT_URL || "mqtt://localhost:1883",
  mqttUsername: env.MQTT_USERNAME || "",
  mqttPassword: env.MQTT_PASSWORD || "",
  deviceToken: env.DEVICE_TOKEN || "dev-token-change-me",
  primaryModelId: env.PRIMARY_MODEL_ID || "qwen/qwen3.6-plus:free",
  fallbackModelId: env.FALLBACK_MODEL_ID || "openrouter/free",
  bedrockModelId: env.BEDROCK_MODEL_ID || "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  transcribeLanguage: env.TRANSCRIBE_LANGUAGE || "en-US",
  ttsVoiceId: env.TTS_VOICE_ID || "Joanna",
  ttsEngine: env.TTS_ENGINE || "neural",
  logLevel: env.LOG_LEVEL || "info",
};

if (!config.openRouterApiKey) {
  console.warn("WARN: OPENROUTER_API_KEY not set");
}
if (!config.awsAccessKeyId) {
  console.warn("WARN: AWS credentials not set, Bedrock fallback disabled");
}
