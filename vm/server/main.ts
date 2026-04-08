import { config } from "./config.ts";
import { logger } from "./logger.ts";
import { processAudioIntent } from "./ai-agent.ts";
import { getMqttClient } from "./mqtt-bus.ts";

const requestLog = new Map<string, unknown>();
let totalRequests = 0;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;
  const start = Date.now();

  logger.info(`[HTTP] ${method} ${url.pathname} from ${req.headers.get("X-Device-Id") || req.headers.get("user-agent") || "unknown"}`);

  if (url.pathname === "/health") {
    logger.info("[HTTP] Health check OK");
    return jsonResponse(200, {
      status: "ok",
      totalRequests,
      activeJobs: [...requestLog.values()].filter((r: unknown) => (r as Record<string, unknown>).status === "processing").length,
    });
  }

  // Audio upload
  if (url.pathname === "/v1/audio/upload") {
    totalRequests++;

    if (method !== "POST") {
      logger.warn(`[HTTP] Rejected: method ${method} not allowed`);
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const auth = req.headers.get("Authorization");
    if (auth !== `Bearer ${config.deviceToken}`) {
      logger.warn("[AUTH] Unauthorized request, token mismatch");
      return jsonResponse(401, { error: "Unauthorized" });
    }

    const deviceId = req.headers.get("X-Device-Id") || "unknown-device";
    const contentType = req.headers.get("Content-Type") || "unknown";
    const contentLength = req.headers.get("Content-Length") || "unknown";
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    logger.info(`[RECV] -------- New Audio Upload --------`);
    logger.info(`[RECV] Request ID: ${requestId}`);
    logger.info(`[RECV] Device: ${deviceId}`);
    logger.info(`[RECV] Content-Type: ${contentType}`);
    logger.info(`[RECV] Content-Length: ${contentLength} bytes`);

    let audioBuffer: Uint8Array;
    try {
      const buf = await req.arrayBuffer();
      audioBuffer = new Uint8Array(buf);
      logger.info(`[RECV] Received ${audioBuffer.length} bytes of audio data`);
    } catch (err) {
      logger.error(`[RECV] Failed to read audio body:`, err);
      return jsonResponse(400, { error: "Invalid audio data" });
    }

    if (audioBuffer.length < 1000) {
      logger.warn(`[RECV] Audio too short (${audioBuffer.length} bytes), rejecting`);
      return jsonResponse(400, { error: "Audio too short" });
    }

    const durationEstimate = (audioBuffer.length / (16000 * 2)).toFixed(1);
    logger.info(`[RECV] Estimated audio duration: ~${durationEstimate}s`);

    requestLog.set(requestId, { deviceId, status: "processing", startedAt: Date.now() });

    // Process in background
    (async () => {
      try {
        // Single step: send audio directly to Gemini (STT + Intent in one call)
        const t0 = Date.now();
        logger.info(`[AI] Sending audio directly to Gemini for transcription + intent...`);
        const result = await processAudioIntent(audioBuffer, deviceId);
        const aiTotalMs = Date.now() - t0;
        logger.info(`[AI] Done in ${aiTotalMs}ms`);
        logger.info(`[AI] Model: ${result.model}`);
        logger.info(`[AI] Response: "${result.responseText}"`);
        if (result.toolCalls.length > 0) {
          logger.info(`[AI] Tool calls: ${result.toolCalls.join(", ")}`);
        } else {
          logger.info(`[AI] No tool calls made`);
        }

        logger.info(`[DONE] Request ${requestId} completed in ${aiTotalMs}ms`);
        logger.info(`[DONE] -------- End ${requestId} --------`);

        requestLog.set(requestId, {
          deviceId,
          status: "completed",
          transcript: result.transcript,
          responseText: result.responseText,
          toolCalls: result.toolCalls,
          model: result.model,
          totalMs: aiTotalMs,
        });
      } catch (err) {
        logger.error(`[ERR] Pipeline failed for ${requestId}:`, err);
        requestLog.set(requestId, { deviceId, status: "error", error: String(err) });
      }
    })();

    logger.info(`[HTTP] Accepted ${requestId}, processing in background`);
    return jsonResponse(202, {
      requestId,
      accepted: true,
      status: "processing",
    });
  }

  // Status check
  if (url.pathname === "/v1/status") {
    const id = url.searchParams.get("requestId");
    if (!id) {
      logger.warn("[HTTP] Status check missing requestId");
      return jsonResponse(400, { error: "Missing requestId" });
    }
    const entry = requestLog.get(id);
    if (!entry) {
      logger.warn(`[HTTP] Status check: ${id} not found`);
      return jsonResponse(404, { error: "Not found" });
    }
    logger.info(`[HTTP] Status for ${id}: ${(entry as Record<string, unknown>).status}`);
    return jsonResponse(200, entry as Record<string, unknown>);
  }

  // TTS
  if (url.pathname === "/v1/tts") {
    const text = url.searchParams.get("text");
    if (!text) return jsonResponse(400, { error: "Missing text param" });
    logger.info(`[TTS] Request: "${text}"`);
    return jsonResponse(501, { error: "TTS endpoint not yet enabled" });
  }

  const elapsed = Date.now() - start;
  logger.warn(`[HTTP] 404 ${url.pathname} (${elapsed}ms)`);
  return jsonResponse(404, { error: "Not found" });
}

// ===== Startup =====
logger.info("========================================");
logger.info("  Home Voice Assistant Server v1.0");
logger.info("========================================");
logger.info(`Port:           ${config.port}`);
logger.info(`Primary model:  ${config.primaryModelId}`);
logger.info(`Fallback model: ${config.fallbackModelId}`);
logger.info(`Device token:   ${config.deviceToken.slice(0, 8)}...`);
logger.info(`MQTT broker:    ${config.mqttUrl}`);
logger.info("----------------------------------------");

try {
  getMqttClient();
  logger.info("[MQTT] Client initialized");
} catch (err) {
  logger.warn("[MQTT] Not available:", err);
}

Deno.serve({ port: config.port, hostname: "0.0.0.0" }, (req) => {
  return handleRequest(req).catch((err) => {
    logger.error("[HTTP] Unhandled error:", err);
    return jsonResponse(500, { error: "Internal server error" });
  });
});
