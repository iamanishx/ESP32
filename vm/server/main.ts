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

function addWavHeader(pcm: Uint8Array, sampleRate = 16000, channels = 1, bitsPerSample = 16): Uint8Array {
  const dataSize = pcm.length;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  v.setUint16(32, channels * bitsPerSample / 8, true); v.setUint16(34, bitsPerSample, true);
  w(36, "data"); v.setUint32(40, dataSize, true);
  const wav = new Uint8Array(44 + dataSize);
  wav.set(new Uint8Array(header)); wav.set(pcm, 44);
  return wav;
}

async function saveAudioOnly(audioBuffer: Uint8Array, requestId: string): Promise<string> {
  await Deno.mkdir(config.audioSavePath, { recursive: true });
  const filename = `${config.audioSavePath}/${requestId}.wav`;
  const wav = addWavHeader(audioBuffer);
  await Deno.writeFile(filename, wav);
  return filename;
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
        const t0 = Date.now();

        // Save audio for debugging
        const filename = await saveAudioOnly(audioBuffer, requestId);
        logger.info(`[AUDIO] Saved to ${filename} - play with: ffplay "${filename}"`);

        // Step 1: Voxtral ASR (DeepInfra) → transcript
        // Step 2: StepFun Step-3.5-Flash (DeepInfra) → intent + tool calling
        logger.info(`[AI] Starting pipeline...`);
        const result = await processAudioIntent(audioBuffer, deviceId);

        const totalMs = Date.now() - t0;
        logger.info(`[DONE] ${requestId} completed in ${totalMs}ms`);
        logger.info(`[DONE] Transcript: "${result.transcript}"`);
        logger.info(`[DONE] Response: "${result.responseText}"`);
        logger.info(`[DONE] Tools: ${result.toolCalls.join(", ") || "none"}`);

        requestLog.set(requestId, {
          deviceId,
          status: "completed",
          transcript: result.transcript,
          responseText: result.responseText,
          toolCalls: result.toolCalls,
          model: result.model,
          totalMs,
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
logger.info("  Home Voice Assistant - FULL PIPELINE");
logger.info("========================================");
logger.info(`Port:         ${config.port}`);
logger.info(`Device token: ${config.deviceToken.slice(0, 8)}...`);
logger.info(`MQTT broker:  ${config.mqttUrl}`);
logger.info(`STT:          Voxtral-Small-24B (DeepInfra ASR)`);
logger.info(`LLM:          stepfun-ai/Step-3.5-Flash (DeepInfra)`);
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
