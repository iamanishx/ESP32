# End-to-End Plan: ESP32 Voice Home Automation Agent

## 1) Mission

Build a voice-first home automation system with no phone in the loop.

- ESP32-S3 captures mic audio and controls relays
- Deno server on VPS acts as the secure AI gateway
- LLM uses tool calling to issue device actions
- Command execution is translated into hardware-safe relay operations

This plan is architecture-first. Code is implemented.

## Status: IMPLEMENTED

## 2) Final Architecture

### Edge (at home)

- `ESP32-S3` firmware (PlatformIO / Arduino framework)
- `INMP441` I2S microphone for capture
- Relay module for switching loads
- Wi-Fi uplink to VPS

### Cloud/Gateway (Hetzner VPS)

- `Deno` API server (`vm/server/main.ts`)
- `Vercel AI SDK` for model/tool orchestration
- `OpenRouter` as LLM provider
- STT + TTS endpoints (AWS recommended)
- MQTT broker or HTTPS callback to deliver final actions

### AI Brain

- Primary model (free): `qwen/qwen3.6-plus:free`
- Optional paid model: `qwen/qwen3.5-plus-02-15`
- Fallback: `openrouter/free` router for uptime

Note: Qwen 3.5 Plus is not the free tier model right now. The free equivalent is Qwen 3.6 Plus free.

## 3) Why This Split

- ESP32 is excellent for audio capture and GPIO control
- Server is better for secret management, retries, auditing, and policy checks
- LLM tool calls stay server-side so no API keys are exposed on device
- We can evolve the brain without reflashing firmware

## 4) Protocol and Data Contracts

### 4.1 ESP32 -> Server audio upload

`POST /v1/audio/upload`

Headers:

- `Authorization: Bearer <DEVICE_TOKEN>`
- `X-Device-Id: esp32-livingroom-01`
- `Content-Type: audio/wav`

Body:

- mono PCM WAV, 16 kHz, 16-bit, 3 to 8 seconds

Response:

```json
{
  "requestId": "req_123",
  "accepted": true,
  "status": "processing"
}
```

### 4.2 Server internal normalized intent

```json
{
  "requestId": "req_123",
  "transcript": "turn off bedroom light",
  "intent": {
    "tool": "set_light",
    "args": {
      "room": "bedroom",
      "state": "off"
    }
  },
  "confidence": 0.94
}
```

### 4.3 Server -> ESP32 command

MQTT topic: `home/esp32-livingroom-01/cmd`

Payload:

```json
{
  "id": "cmd_456",
  "ts": 1770000000,
  "action": "relay_set",
  "relay": 1,
  "state": 0,
  "reason": "user_voice_intent",
  "replyTo": "home/esp32-livingroom-01/ack"
}
```

Where:

- `state: 0` means ON for active-low relay boards
- `state: 1` means OFF for active-low relay boards

### 4.4 ESP32 -> Server/MQTT acknowledgment

Topic: `home/esp32-livingroom-01/ack`

```json
{
  "id": "cmd_456",
  "ok": true,
  "appliedAt": 1770000002,
  "gpio": 18
}
```

## 5) Tool Calling Design (LLM -> Real World)

The LLM never touches hardware directly. It can only call approved tools.

### Exposed tools to model

1. `set_light(room, state)`
2. `set_fan(room, speed)`
3. `get_device_state(room, device)`
4. `confirm_action(message)`

### Execution chain

1. User speech -> transcript
2. LLM receives transcript + home inventory + safety policy
3. LLM picks tool call (structured args)
4. Server validator enforces:
   - allowed rooms
   - allowed states
   - rate limits
   - quiet-hours policy (optional)
5. Server maps tool args -> relay command packet
6. Packet sent to target ESP32
7. ACK required within timeout
8. LLM generates final spoken text response

### Hardware translation layer

Create a deterministic mapping table on server:

```ts
// example
{ room: "bedroom", device: "light" } -> { nodeId: "esp32-bedroom-01", relay: 1, activeLow: true }
```

Then translator computes output bit value safely.

## 6) STT and TTS Strategy

### Recommended for your stack

- STT: `Amazon Transcribe` (streaming or batch)
- TTS: `Amazon Polly` (neural voice)

Why:

- strong reliability
- easy AWS scaling
- good language support

### Alternative

- STT/TTS through OpenAI-compatible providers via OpenRouter where supported
- Keep adapters behind one interface so we can switch providers without touching ESP32

## 7) Security and Production Controls

- No LLM keys on ESP32
- Per-device bearer token and optional HMAC signature
- TLS for all uplink traffic
- Command idempotency key to avoid duplicate switching
- Relay safety policy for high-power lines
- Full audit logs: transcript, tool-call, command, ack, latency
- Circuit breaker if repeated unknown intents or command failures

## 8) Latency Budget Target

- capture window: 3.0 to 6.0 s
- upload: 0.2 to 1.0 s
- STT: 0.6 to 1.8 s
- LLM tool call: 0.4 to 1.5 s
- command dispatch + ack: 0.05 to 0.4 s

Target end-to-end: 2 to 5 seconds after user finishes speaking.

## 9) Repository Execution Plan

## Phase A: server foundation (Deno)

- Implement `vm/server/main.ts` HTTP server
- Add env config and secrets loader
- Add health endpoint and structured logger

## Phase B: AI and tools layer

- Integrate `ai` SDK with OpenRouter provider config
- Add system prompt and strict tool schemas
- Implement tool dispatcher with validation

## Phase C: speech pipeline

- Add STT adapter (`transcribeAudio`)
- Add TTS adapter (`synthesizeSpeech`)
- Add transcript normalization and language routing

## Phase D: device command bus

- Add MQTT publisher/subscriber
- Implement command translator and ACK tracker
- Add retries and timeout policy

## Phase E: ESP32 firmware

- I2S mic capture (INMP441)
- button-triggered record first, wake-word later
- HTTPS upload client
- MQTT command listener + relay GPIO control
- ACK publish + local status LED

## Phase F: hardening

- auth, rate limits, replay protection
- command safety rules
- integration tests and soak tests

## 10) API and Model Configuration Plan

### Vercel AI SDK notes (from docs)

- Use `generateText`/`streamText`
- define tools with schema and `execute`
- keep tool execution on server side

### OpenRouter notes (from docs)

- base URL: `https://openrouter.ai/api/v1`
- endpoint: `POST /chat/completions`
- auth: `Authorization: Bearer <OPENROUTER_API_KEY>`

### Model routing

- default: `qwen/qwen3.6-plus:free`
- optional paid: `qwen/qwen3.5-plus-02-15`
- fallback: `openrouter/free`

## 11) Device Inventory Contract

Server keeps a single source of truth:

```json
{
  "devices": [
    {
      "room": "living_room",
      "device": "light",
      "nodeId": "esp32-livingroom-01",
      "relay": 1,
      "activeLow": true,
      "supports": ["on", "off"]
    }
  ]
}
```

LLM sees only this inventory to avoid hallucinated devices.

## 12) Failure Handling

- STT failed -> ask user to repeat
- LLM uncertain -> `confirm_action`
- tool args invalid -> reject and ask clarification
- device offline -> queue short retry then notify user
- ACK timeout -> mark command failed and log incident

## 13) What We Build Immediately After Green Signal

1. Replace `vm/server/main.ts` with Deno API skeleton
2. Add OpenRouter + AI SDK integration with tool-calling
3. Add MQTT command dispatch module
4. Add first ESP32 firmware for relay + audio upload
5. Add `.env.example` and runbook

## 14) Acceptance Criteria

- User says: "turn on living room light"
- STT transcript recognized
- LLM emits `set_light` tool call with valid args
- Translator sends correct relay packet
- ESP32 toggles relay and sends ACK
- Server returns spoken confirmation text
- Full trace logged with request id

## 15) Source Notes Used

- Vercel AI SDK docs for tools and generation flow
- OpenRouter chat completion API reference and model pages
- AWS Transcribe and AWS Polly service docs for speech pipeline choice
