import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { getInventorySummary, findDevice } from "./inventory.ts";
import { publishCommand } from "./mqtt-bus.ts";

const voxtral = createOpenAICompatible({
  name: "deepinfra",
  baseURL: "https://api.deepinfra.com/v1/openai",
  apiKey: config.deepInfraApiKey,
});

const VOXTRAL_MODEL = "mistralai/Voxtral-Small-24B-2507";
const homeInventory = getInventorySummary();

function addWavHeader(pcmData: Uint8Array, sampleRate = 16000, channels = 1, bitsPerSample = 16): Uint8Array {
  const dataSize = pcmData.length;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const wav = new Uint8Array(44 + dataSize);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcmData, 44);
  return wav;
}

async function saveAudioFile(audioBuffer: Uint8Array): Promise<string> {
  try {
    await Deno.mkdir(config.audioSavePath, { recursive: true });
    const filename = `${config.audioSavePath}/audio_${Date.now()}.wav`;
    const wavWithHeader = addWavHeader(audioBuffer);
    await Deno.writeFile(filename, wavWithHeader);
    logger.info(`[AUDIO] Saved to ${filename} (${wavWithHeader.length} bytes with WAV header)`);
    return filename;
  } catch (err) {
    logger.warn(`[AUDIO] Failed to save:`, err);
    return "";
  }
}

async function transcribeWithVoxtral(audioBuffer: Uint8Array): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([audioBuffer.buffer as ArrayBuffer], { type: "audio/wav" });
  formData.append("audio", blob, "audio.wav");

  logger.info(`[STT] Sending audio to Voxtral ASR...`);
  const resp = await fetch(
    "https://api.deepinfra.com/v1/inference/mistralai/Voxtral-Small-24B-2507",
    {
      method: "POST",
      headers: {
        Authorization: `bearer ${config.deepInfraApiKey}`,
      },
      body: formData,
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Voxtral ASR failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  const transcript = (
    data.text ||
    data.segments?.map((s: { text: string }) => s.text).join(" ") ||
    ""
  ).trim();

  return transcript;
}

async function sendRelayCommand(room: string, deviceType: string, state: "on" | "off") {
  const device = findDevice(room, deviceType);
  if (!device) {
    logger.warn(`[TOOL] Device not found: ${room} ${deviceType}`);
    return { ok: false, error: `No ${deviceType} found in ${room}` };
  }
  const relayState = device.activeLow ? (state === "on" ? 0 : 1) : (state === "on" ? 1 : 0);
  const cmd = {
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    action: "relay_set",
    relay: device.relay,
    state: relayState,
    reason: `voice: ${state} ${room} ${deviceType}`,
    replyTo: `home/${device.nodeId}/ack`,
  };
  logger.info(`[TOOL] ${deviceType} relay=${device.relay} → ${state} (gpio=${relayState})`);
  try {
    await publishCommand(device.nodeId, cmd);
    logger.info(`[TOOL] Command delivered: ${cmd.id}`);
  } catch (err) {
    logger.error(`[TOOL] Publish failed:`, err);
  }
  return { ok: true, room, state, relay: device.relay, cmdId: cmd.id };
}

const tools = {
  set_light: tool({
    description: "Turn a light on or off in a specific room",
    inputSchema: z.object({
      room: z.string().describe("Room name: living_room, bedroom, or kitchen"),
      state: z.enum(["on", "off"]).describe("on or off"),
    }),
    execute: async ({ room, state }: { room: string; state: "on" | "off" }) => {
      logger.info(`[TOOL] set_light(${room}, ${state})`);
      return await sendRelayCommand(room, "light", state);
    },
  }),
  set_fan: tool({
    description: "Turn a fan on or off in a specific room",
    inputSchema: z.object({
      room: z.string().describe("Room name: living_room"),
      state: z.enum(["on", "off"]).describe("on or off"),
    }),
    execute: async ({ room, state }: { room: string; state: "on" | "off" }) => {
      logger.info(`[TOOL] set_fan(${room}, ${state})`);
      return await sendRelayCommand(room, "fan", state);
    },
  }),
};

const systemPrompt = `You are a voice-controlled home automation assistant.

The user will tell you what they want. Use the correct tool to control the device.

Available devices:
${homeInventory}

Rules:
- Use set_light for lights, set_fan for fans.
- Room names: living_room, bedroom, kitchen.
- Respond in 1 short sentence after executing the tool.`;

export interface VoiceIntentResult {
  transcript: string;
  responseText: string;
  toolCalls: string[];
  model: string;
  latencyMs: number;
}

// ===== Main Pipeline =====
// Step 1: DeepInfra Voxtral ASR endpoint → transcript
// Step 2: DeepInfra Voxtral chat endpoint + tools → relay command
export async function processAudioIntent(
  audioBuffer: Uint8Array,
  deviceId: string,
): Promise<VoiceIntentResult> {
  const start = Date.now();
  const toolCalls: string[] = [];

  logger.info(`[AI] Device: ${deviceId} | Audio: ${audioBuffer.length} bytes`);

  // Save audio for debugging
  await saveAudioFile(audioBuffer);

  // Step 1: Voxtral ASR
  const t0 = Date.now();
  const transcript = await transcribeWithVoxtral(audioBuffer);
  logger.info(`[STT] Done in ${Date.now() - t0}ms: "${transcript}"`);

  if (!transcript || transcript.length < 2) {
    logger.warn(`[STT] Empty transcript, skipping LLM`);
    return {
      transcript: "",
      responseText: "Sorry, I couldn't hear that clearly.",
      toolCalls: [],
      model: VOXTRAL_MODEL,
      latencyMs: Date.now() - start,
    };
  }

  // Step 2: Voxtral chat + tool calling
  logger.info(`[AI] Intent: "${transcript}"`);
  const t1 = Date.now();
  const result = await generateText({
    model: voxtral(VOXTRAL_MODEL),
    system: systemPrompt,
    prompt: `User said: "${transcript}"`,
    tools,
    stopWhen: stepCountIs(3),
  });
  logger.info(`[AI] Done in ${Date.now() - t1}ms: "${result.text}"`);

  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      const call = `${tc.toolName}(${JSON.stringify(tc.input)})`;
      toolCalls.push(call);
      logger.info(`[AI] Tool: ${call}`);
    }
  }

  const latencyMs = Date.now() - start;
  logger.info(`[AI] Total: ${latencyMs}ms | tools: ${toolCalls.join(", ") || "none"}`);

  return {
    transcript,
    responseText: result.text,
    toolCalls,
    model: VOXTRAL_MODEL,
    latencyMs,
  };
}

export async function processVoiceIntent(
  transcript: string,
  deviceId: string,
): Promise<VoiceIntentResult> {
  const start = Date.now();
  const toolCalls: string[] = [];

  logger.info(`[AI] Text intent: "${transcript}" from ${deviceId}`);

  const result = await generateText({
    model: voxtral(VOXTRAL_MODEL),
    system: systemPrompt,
    prompt: `User said: "${transcript}"`,
    tools,
    stopWhen: stepCountIs(3),
  });

  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      const call = `${tc.toolName}(${JSON.stringify(tc.input)})`;
      toolCalls.push(call);
      logger.info(`[AI] Tool: ${call}`);
    }
  }

  const latencyMs = Date.now() - start;
  logger.info(`[AI] Response: "${result.text}" | ${latencyMs}ms`);

  return { transcript, responseText: result.text, toolCalls, model: VOXTRAL_MODEL, latencyMs };
}
