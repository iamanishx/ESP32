import { config } from "./config.ts";

export async function transcribeAudio(audioBuffer: Uint8Array): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([audioBuffer.buffer as ArrayBuffer], { type: "audio/wav" });
  formData.append("file", blob, "audio.wav");
  formData.append("model", "stepfun/step-3.5-flash:free");
  formData.append("language", config.transcribeLanguage);
  formData.append("response_format", "text");

  const resp = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "HTTP-Referer": "https://github.com/home-voice-assistant",
      "X-Title": "Home Voice Assistant",
    },
    body: formData,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`STT failed: ${resp.status} ${err}`);
  }

  const text = await resp.text();
  console.log(`[STT] Transcription result: ${text.trim()}`);
  return text.trim();
}
