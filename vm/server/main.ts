import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { transcribeAudio } from "./stt.ts";
import { processVoiceIntent } from "./ai-agent.ts";
import { getMqttClient } from "./mqtt-bus.ts";

const requestLog = new Map<string, unknown>();

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return jsonResponse(200, { status: "ok", uptime: process.uptime() });
  }

  if (url.pathname === "/v1/audio/upload") {
    if (req.method !== "POST") {
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${config.deviceToken}`) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    const deviceId = req.headers.get("X-Device-Id") || "unknown-device";
    const requestId = `req_${Date.now()}`;
    logger.info(`[${requestId}] Audio upload from ${deviceId}`);

    let audioBuffer: Uint8Array;
    try {
      const buf = await req.arrayBuffer();
      audioBuffer = new Uint8Array(buf);
    } catch {
      return jsonResponse(400, { error: "Invalid audio data" });
    }

    if (audioBuffer.length < 1000) {
      return jsonResponse(400, { error: "Audio too short" });
    }

    requestLog.set(requestId, { deviceId, status: "processing", startedAt: Date.now() });

    (async () => {
      try {
        const t0 = Date.now();
        const transcript = await transcribeAudio(audioBuffer);
        logger.info(`[${requestId}] STT in ${Date.now() - t0}ms: "${transcript}"`);

        if (!transcript || transcript.length < 2) {
          requestLog.set(requestId, { deviceId, status: "empty_transcript", transcript });
          return;
        }

        const t1 = Date.now();
        const result = await processVoiceIntent(transcript, deviceId);
        logger.info(`[${requestId}] AI in ${result.latencyMs}ms | model: ${result.model}`);

        requestLog.set(requestId, {
          deviceId,
          status: "completed",
          transcript,
          responseText: result.responseText,
          toolCalls: result.toolCalls,
          model: result.model,
          totalLatencyMs: Date.now() - t0,
        });
      } catch (err) {
        logger.error(`[${requestId}] Processing failed:`, err);
        requestLog.set(requestId, { deviceId, status: "error", error: String(err) });
      }
    })();

    return jsonResponse(202, {
      requestId,
      accepted: true,
      status: "processing",
    });
  }

  if (url.pathname === "/v1/status") {
    const id = url.searchParams.get("requestId");
    if (!id) return jsonResponse(400, { error: "Missing requestId" });
    const entry = requestLog.get(id);
    if (!entry) return jsonResponse(404, { error: "Not found" });
    return jsonResponse(200, entry as Record<string, unknown>);
  }

  if (url.pathname === "/v1/tts") {
    const text = url.searchParams.get("text");
    if (!text) return jsonResponse(400, { error: "Missing text param" });
    return jsonResponse(501, { error: "TTS endpoint not yet enabled" });
  }

  return jsonResponse(404, { error: "Not found" });
}

logger.info("Starting Home Voice Assistant server...");
logger.info("Port:", config.port);
logger.info("Primary model:", config.primaryModelId);
logger.info("Fallback model:", config.fallbackModelId);

try {
  getMqttClient();
} catch (err) {
  logger.warn("MQTT not available, commands will not be delivered:", err);
}

Deno.serve({ port: config.port }, (req) => {
  return handleRequest(req).catch((err) => {
    logger.error("Unhandled error:", err);
    return jsonResponse(500, { error: "Internal server error" });
  });
});
