import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { generateText, tool } from "ai";
import { z } from "zod";
import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { deviceInventory, getInventorySummary, findDevice } from "./inventory.ts";
import { publishCommand } from "./mqtt-bus.ts";

const openrouter = createOpenRouter({
  apiKey: config.openRouterApiKey,
});

const bedrock = createAmazonBedrock({
  region: config.awsRegion,
  accessKeyId: config.awsAccessKeyId || undefined,
  secretAccessKey: config.awsSecretAccessKey || undefined,
});

const homeInventory = getInventorySummary();

const tools = {
  set_light: tool({
    description: "Turn a light on or off in a specific room",
    inputSchema: z.object({
      room: z.string().describe("Room name (e.g. living_room, bedroom, kitchen)"),
      state: z.enum(["on", "off"]).describe("Desired state"),
    }),
    execute: async ({ room, state }: { room: string; state: "on" | "off" }) => {
      const device = findDevice(room, "light");
      if (!device) {
        return { error: `No light found in ${room}`, ok: false };
      }
      const relayState = device.activeLow ? (state === "on" ? 0 : 1) : (state === "on" ? 1 : 0);
      const cmd = {
        id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        action: "relay_set",
        relay: device.relay,
        state: relayState,
        reason: `voice: ${state} ${room} light`,
        replyTo: `home/${device.nodeId}/ack`,
      };
      await publishCommand(device.nodeId, cmd);
      logger.info("Light command sent:", cmd);
      return { ok: true, room, state, relay: device.relay, cmdId: cmd.id };
    },
  }),
  set_fan: tool({
    description: "Turn a fan on or off in a specific room",
    inputSchema: z.object({
      room: z.string().describe("Room name"),
      state: z.enum(["on", "off"]).describe("Desired state"),
    }),
    execute: async ({ room, state }: { room: string; state: "on" | "off" }) => {
      const device = findDevice(room, "fan");
      if (!device) {
        return { error: `No fan found in ${room}`, ok: false };
      }
      const relayState = device.activeLow ? (state === "on" ? 0 : 1) : (state === "on" ? 1 : 0);
      const cmd = {
        id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        action: "relay_set",
        relay: device.relay,
        state: relayState,
        reason: `voice: ${state} ${room} fan`,
        replyTo: `home/${device.nodeId}/ack`,
      };
      await publishCommand(device.nodeId, cmd);
      logger.info("Fan command sent:", cmd);
      return { ok: true, room, state, relay: device.relay, cmdId: cmd.id };
    },
  }),
  get_device_state: tool({
    description: "Get the current state of a device in a room",
    inputSchema: z.object({
      room: z.string().describe("Room name"),
      device: z.string().describe("Device type (light, fan)"),
    }),
    execute: async ({ room, device: devType }: { room: string; device: string }) => {
      const device = findDevice(room, devType);
      if (!device) {
        return { error: `Device ${devType} not found in ${room}`, ok: false };
      }
      return { ok: true, room, device: devType, status: "unknown (no feedback sensor)", relay: device.relay };
    },
  }),
  confirm_action: tool({
    description: "Ask the user to confirm an action before executing",
    inputSchema: z.object({
      message: z.string().describe("Confirmation message to speak to user"),
    }),
    execute: async ({ message }: { message: string }) => {
      return { ok: true, message, confirmed: true };
    },
  }),
};

const systemPrompt = `You are a voice-controlled home automation assistant. You control devices via tool calls only.

Available devices:
${homeInventory}

Rules:
- Only use the tools provided. Do not make up devices or rooms.
- If the user asks about a device that does not exist, say so clearly.
- Keep responses short and natural (1 sentence max).
- After a successful tool call, confirm the action in a friendly way.
- If unsure, use confirm_action to ask the user.`;

export interface VoiceIntentResult {
  transcript: string;
  responseText: string;
  toolCalls: string[];
  model: string;
  latencyMs: number;
}

export async function processVoiceIntent(
  transcript: string,
  deviceId: string,
): Promise<VoiceIntentResult> {
  const start = Date.now();
  const toolCalls: string[] = [];

  async function runModel(modelId: string): Promise<string> {
    const result = await generateText({
      model: modelId,
      system: systemPrompt,
      prompt: `User said: "${transcript}"`,
      tools,
      maxSteps: 3,
      onStepFinish: (step: { toolCalls?: { toolName: string; args: Record<string, unknown> }[] }) => {
        if (step.toolCalls) {
          for (const tc of step.toolCalls) {
            toolCalls.push(`${tc.toolName}(${JSON.stringify(tc.args)})`);
          }
        }
      },
    });
    return result.text;
  }

  let responseText: string;
  let usedModel: string;

  try {
    usedModel = config.primaryModelId;
    responseText = await runModel(
      config.primaryModelId.includes("/")
        ? openrouter.chat(config.primaryModelId)
        : bedrock(config.primaryModelId),
    );
  } catch (err) {
    logger.warn("Primary model failed, trying fallback:", err);
    try {
      usedModel = config.fallbackModelId;
      responseText = await runModel(
        config.fallbackModelId.includes("/")
          ? openrouter.chat(config.fallbackModelId)
          : bedrock(config.fallbackModelId),
      );
    } catch (err2) {
      logger.error("All models failed:", err2);
      responseText = "Sorry, I could not process that right now. Please try again.";
      usedModel = "fallback-error";
    }
  }

  const latencyMs = Date.now() - start;
  logger.info(`Intent processed in ${latencyMs}ms | model: ${usedModel} | tools: ${toolCalls.join(", ")}`);

  return {
    transcript,
    responseText,
    toolCalls,
    model: usedModel,
    latencyMs,
  };
}
