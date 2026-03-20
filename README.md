## Home automation with esp32

This is a smart home voice assistant that runs entirely on edge devices. You talk to it, it listens, understands what you mean using AI, and controls your lights and appliances. Simple as that.

No cloud-dependent gadgets. No privacy concerns about always-on microphones sending everything to some server. The brain (AI) lives in the cloud, but the ears and hands live right in your home.

## How It Works

The system has three main parts working together:

**1. The Listener (ESP32-S3)**
A small microcontroller sits in your home with a microphone attached. It's always listening, but not always recording. When you press a button or say a wake word, it starts capturing audio. It then sends that audio over WiFi to our server.

**2. The Brain (Hetzner VPS + OpenAI)**
The server receives your voice recording and sends it to OpenAI's Whisper API, which converts speech to text. That text goes to ChatGPT, which figures out what you actually want. Did you ask to turn on the lights? Turn them off? Change the brightness? ChatGPT understands intent and returns a clear command.

**3. The Executor (ESP32-S3 + Relays)**
The server sends the command back through MQTT to your ESP32. The ESP32 flips the relay, and your light turns on or off.

## The Flow

Here is the step by step journey of a single command:

1. You press a button on the ESP32 device
2. The ESP32 records 3-5 seconds of audio
3. It uploads the audio to our Hetzner VPS via HTTPS
4. The VPS sends the audio to OpenAI Whisper for transcription
5. The transcribed text goes to ChatGPT with instructions on what devices you have
6. ChatGPT responds with a structured command like "turn on living room light"
7. The VPS publishes this command to our MQTT broker
8. The ESP32 receives the command and toggles the appropriate relay
9. Your light turns on

The whole process takes about 2-4 seconds from speaking to action.

**Hardware:**
- ESP32-S3 Mini development board
- INMP441 I2S digital microphone
- 4-channel relay module (5V)
- Push button
- Jumper wires
- 5V power supply

**Software:**
- PlatformIO for ESP32 firmware
- Node.js for the proxy server
- Mosquitto MQTT broker (runs on the VPS)
- OpenAI API account (Whisper + GPT)

**Infrastructure:**
- Hetzner VPS (or any cloud server)
- WiFi network at home

## Why This Architecture?

We chose to keep things simple and secure. The ESP32 does not store any API keys. It only knows how to record audio, send it to the server, and listen for commands. All the AI heavy lifting happens on the VPS, which talks to OpenAI. This means you can update your prompts, add new devices, or change behavior without touching the firmware on your ESP32.

The MQTT layer makes it easy to add more devices later. Want a second ESP32 in the bedroom? Just point it to the same MQTT broker and it immediately becomes part of the system.

## What's Next?

The current version is a proof of concept. It handles basic on/off commands for lights. The roadmap includes:

- Adding wake word detection so you do not need to press a button
- Voice feedback so the system can confirm actions
- Support for dimmers and fan speed control
- Scene support like "movie mode" or "goodnight"
- Multi-language support

## Project Structure

```
esp82/
├── src/
│   └── main.cpp          # ESP32 firmware
├── platformio.ini        # Build configuration
├── proxy/                 # VPS server code
│   ├── server.js         # Main proxy server
│   └── mqtt.js           # MQTT handler
└── README.md
```

