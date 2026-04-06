import { config } from "./config.ts";

export async function synthesizeSpeech(text: string): Promise<Uint8Array> {
  const body = JSON.stringify({
    Text: text,
    OutputFormat: "mp3",
    VoiceId: config.ttsVoiceId,
    Engine: config.ttsEngine,
  });

  const resp = await fetch(
    `https://polly.${config.awsRegion}.amazonaws.com/v1/speech`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "Pollex.SynthesizeSpeech",
      },
      body,
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`TTS failed: ${resp.status} ${err}`);
  }

  const buf = await resp.arrayBuffer();
  return new Uint8Array(buf);
}
