import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool } from "ai";
import { z } from "zod";
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { getInventorySummary, findDevice } from "./inventory.ts";
import { publishCommand } from "./mqtt-bus.ts";

const google = createGoogleGenerativeAI({
  apiKey: config.geminiApiKey,
});

const homeInventory = getInventorySummary();

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
    parameters: z.object({
      room: z.string().describe("Room name: living_room, bedroom, or kitchen"),
      state: z.enum(["on", "off"]).describe("on or off"),
    }),
    execute: async ({ room, state }) => {
      logger.info(`[TOOL] set_light(${room}, ${state})`);
      return await sendRelayCommand(room, "light", state);
    },
  }),
  set_fan: tool({
    description: "Turn a fan on or off in a specific room",
    parameters: z.object({
      room: z.string().describe("Room name: living_room"),
      state: z.enum(["on", "off"]).describe("on or off"),
    }),
    execute: async ({ room, state }) => {
      logger.info(`[TOOL] set_fan(${room}, ${state})`);
      return await sendRelayCommand(room, "fan", state);
    },
  }),
};

const systemPrompt = `You are a voice-controlled home automation assistant.

Listen to the audio recording. Understand what the user wants to do. Use the correct tool to control the device.

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

export async function processAudioIntent(
  audioBuffer: Uint8Array,
  deviceId: string,
): Promise<VoiceIntentResult> {
  const start = Date.now();
  const toolCalls: string[] = [];
  const modelName = "gemini-3-pro-preview";

  logger.info(`[AI] Device: ${deviceId} | Audio: ${audioBuffer.length} bytes | Model: ${modelName}`);

  const result = await generateText({
    model: google(modelName),
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Listen to this voice recording and control the home device.",
          },
          {
            type: "file",
            data: audioBuffer.buffer as ArrayBuffer,
            mediaType: "audio/wav",
          },
        ],
      },
    ],
    tools,
    maxSteps: 5,
  });

  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      const call = `${tc.toolName}(${JSON.stringify(tc.args)})`;
      toolCalls.push(call);
      logger.info(`[AI] Tool: ${call}`);
    }
  }

  const latencyMs = Date.now() - start;
  logger.info(`[AI] Response: "${result.text}" | ${latencyMs}ms | tools: ${toolCalls.join(", ") || "none"}`);

  return { transcript: "(audio)", responseText: result.text, toolCalls, model: modelName, latencyMs };
}

export async function processVoiceIntent(
  transcript: string,
  deviceId: string,
): Promise<VoiceIntentResult> {
  const start = Date.now();
  const toolCalls: string[] = [];
  const modelName = "gemini-2.5-flash";

  logger.info(`[AI] Text intent: "${transcript}" from ${deviceId}`);

  const result = await generateText({
    model: google(modelName),
    system: systemPrompt,
    prompt: `User said: "${transcript}"`,
    tools,
    maxSteps: 3,
  });

  for (const step of result.steps) {
    for (const tc of step.toolCalls) {
      const call = `${tc.toolName}(${JSON.stringify(tc.args)})`;
      toolCalls.push(call);
      logger.info(`[AI] Tool: ${call}`);
    }
  }

  const latencyMs = Date.now() - start;
  logger.info(`[AI] Response: "${result.text}" | ${latencyMs}ms`);

  return { transcript, responseText: result.text, toolCalls, model: modelName, latencyMs };
}
