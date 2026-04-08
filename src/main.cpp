#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <driver/i2s.h>
#include <ArduinoJson.h>

// ===== Config =====
const char* WIFI_SSID = "Manish’s iPhone";
const char* WIFI_PASS = "manish07";

const char* SERVER_URL = "http://172.20.10.2:8080";
const char* DEVICE_TOKEN = "dev-token-change-me";
const char* DEVICE_ID = "esp32-livingroom-01";

const char* MQTT_HOST = "172.20.10.2";
const int   MQTT_PORT = 1883;
const char* MQTT_TOPIC_CMD = "home/esp32-livingroom-01/cmd";
const char* MQTT_TOPIC_ACK = "home/esp32-livingroom-01/ack";

// ===== Pins =====
#define BUTTON_PIN    4
#define RELAY_1       10
#define RELAY_2       11
#define RELAY_3       12
#define RELAY_4       13
#define STATUS_LED    21

// ===== I2S Mic (INMP441) =====
#define I2S_WS        1
#define I2S_SCK       2
#define I2S_SD        3
#define I2S_PORT      I2S_NUM_0
#define SAMPLE_RATE   16000
#define BUF_SAMPLES   1024

// ===== Globals =====
WiFiClient espClient;
PubSubClient mqttClient(espClient);
int32_t  i2sRawBuf[BUF_SAMPLES];   // 32-bit read buffer
int16_t* audioBuffer = nullptr;     // 16-bit output buffer
size_t audioSamples = 0;
size_t audioMaxSamples = 16000 * 3;
volatile bool recording = false;
volatile bool buttonPressed = false;
bool wifiConnected = false;
bool mqttConnected = false;
unsigned long lastMqttRetry = 0;

// ===== Forward declarations =====
void mqttCallback(char* topic, byte* payload, unsigned int length);

// ===== I2S Setup =====
void setupI2S() {
  Serial.println("[I2S] Configuring INMP441 mic...");

  i2s_config_t i2sConfig = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = BUF_SAMPLES,
    .use_apll = false,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pinConfig = {
    .bck_io_num = I2S_SCK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  esp_err_t err = i2s_driver_install(I2S_PORT, &i2sConfig, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("[I2S] ERROR: driver install failed: %d\n", err);
    return;
  }

  err = i2s_set_pin(I2S_PORT, &pinConfig);
  if (err != ESP_OK) {
    Serial.printf("[I2S] ERROR: pin config failed: %d\n", err);
    return;
  }

  Serial.println("[I2S] OK: WS=GPIO1, SCK=GPIO2, SD=GPIO3");
}

// ===== WiFi Setup =====
void setupWiFi() {
  Serial.printf("[WIFI] Connecting to '%s'...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.printf("\n[WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("[WIFI] RSSI: %d dBm\n", WiFi.RSSI());
  } else {
    wifiConnected = false;
    Serial.println("\n[WIFI] FAILED to connect after 15s");
    Serial.println("[WIFI] Check SSID/password and try again");
  }
}

// ===== MQTT Setup =====
void setupMQTT() {
  Serial.printf("[MQTT] Broker: %s:%d\n", MQTT_HOST, MQTT_PORT);
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(1024);
}

void tryMqttConnect() {
  if (millis() - lastMqttRetry < 5000) return;
  lastMqttRetry = millis();

  Serial.printf("[MQTT] Connecting as '%s'...\n", DEVICE_ID);
  if (mqttClient.connect(DEVICE_ID)) {
    mqttConnected = true;
    mqttClient.subscribe(MQTT_TOPIC_CMD);
    Serial.printf("[MQTT] Connected! Subscribed to: %s\n", MQTT_TOPIC_CMD);
  } else {
    mqttConnected = false;
    Serial.printf("[MQTT] Failed, rc=%d (", mqttClient.state());
    switch (mqttClient.state()) {
      case -4: Serial.print("timeout"); break;
      case -3: Serial.print("connection lost"); break;
      case -2: Serial.print("connect failed"); break;
      case -1: Serial.print("disconnected"); break;
      case 1:  Serial.print("bad protocol"); break;
      case 2:  Serial.print("bad client id"); break;
      case 3:  Serial.print("unavailable"); break;
      case 4:  Serial.print("bad credentials"); break;
      case 5:  Serial.print("unauthorized"); break;
      default: Serial.print("unknown"); break;
    }
    Serial.println(") retrying in 5s...");
  }
}

// ===== MQTT Callback =====
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.printf("[MQTT] Received on '%s': %s\n", topic, msg.c_str());

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.printf("[MQTT] JSON parse failed: %s\n", err.c_str());
    return;
  }

  int relay = doc["relay"] | -1;
  int state = doc["state"] | -1;
  const char* cmdId = doc["id"] | "";

  if (relay >= 1 && relay <= 4 && state >= 0) {
    int relayPin = RELAY_1 + relay - 1;
    digitalWrite(relayPin, state);
    Serial.printf("[RELAY] Relay %d (GPIO %d) set to %s\n", relay, relayPin, state == 0 ? "ON" : "OFF");

    JsonDocument ack;
    ack["id"] = cmdId;
    ack["ok"] = true;
    ack["appliedAt"] = millis();
    ack["gpio"] = relayPin;
    String ackStr;
    serializeJson(ack, ackStr);
    mqttClient.publish(MQTT_TOPIC_ACK, ackStr.c_str());
    Serial.printf("[MQTT] ACK sent: %s\n", ackStr.c_str());
  } else {
    Serial.println("[MQTT] Invalid command: relay or state out of range");
  }
}

// ===== Button ISR =====
void IRAM_ATTR buttonISR() {
  static unsigned long lastInterrupt = 0;
  unsigned long now = millis();
  if (now - lastInterrupt > 500) {
    buttonPressed = true;
    lastInterrupt = now;
  }
}

// ===== Upload Audio =====
bool uploadAudio() {
  if (!wifiConnected) {
    Serial.println("[UPLOAD] No WiFi, skipping");
    return false;
  }

  Serial.printf("[UPLOAD] Sending %d bytes to %s/v1/audio/upload\n", audioSamples * 2, SERVER_URL);

  HTTPClient http;
  http.begin(String(SERVER_URL) + "/v1/audio/upload");
  http.addHeader("Authorization", "Bearer " + String(DEVICE_TOKEN));
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("Content-Type", "audio/wav");
  http.setTimeout(10000);

  int httpResponse = http.POST((uint8_t*)audioBuffer, audioSamples * 2);
  String response = http.getString();
  Serial.printf("[UPLOAD] Response: %d %s\n", httpResponse, response.c_str());

  http.end();
  return httpResponse == 202;
}

// ===== Setup =====
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=============================");
  Serial.println("  Home Voice Assistant v1.0");
  Serial.println("=============================");
  Serial.printf("Device ID: %s\n", DEVICE_ID);
  Serial.printf("Server: %s\n", SERVER_URL);
  Serial.printf("MQTT: %s:%d\n", MQTT_HOST, MQTT_PORT);
  Serial.println("-----------------------------");

  // Pin setup
  Serial.println("[GPIO] Configuring pins...");
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(RELAY_1, OUTPUT);
  pinMode(RELAY_2, OUTPUT);
  pinMode(RELAY_3, OUTPUT);
  pinMode(RELAY_4, OUTPUT);

  // All relays OFF (active LOW = HIGH is OFF)
  digitalWrite(RELAY_1, HIGH);
  digitalWrite(RELAY_2, HIGH);
  digitalWrite(RELAY_3, HIGH);
  digitalWrite(RELAY_4, HIGH);
  Serial.println("[GPIO] Relays: OFF (GPIO 10-13)");
  Serial.println("[GPIO] Button: GPIO 4");

  // Button interrupt
  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), buttonISR, FALLING);

  // Audio buffer - force internal SRAM (not PSRAM)
  Serial.printf("[MEM] Allocating %d bytes for audio buffer...\n", audioMaxSamples * sizeof(int16_t));
  audioBuffer = (int16_t*)heap_caps_malloc(audioMaxSamples * sizeof(int16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!audioBuffer) {
    Serial.println("[MEM] ERROR: Failed to allocate audio buffer!");
    while (1) delay(1000);
  }
  memset(audioBuffer, 0, audioMaxSamples * sizeof(int16_t));
  Serial.printf("[MEM] Audio buffer OK at address: %p\n", audioBuffer);

  // I2S
  setupI2S();

  // WiFi
  setupWiFi();

  // MQTT
  setupMQTT();

  Serial.println("=============================");
  Serial.println("  Ready! Press button (GPIO 4) to record.");
  Serial.println("=============================");
}

// ===== Loop =====
void loop() {
  // Reconnect WiFi if lost
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiConnected) {
      Serial.println("[WIFI] Connection lost! Reconnecting...");
      wifiConnected = false;
    }
    WiFi.reconnect();
    delay(1000);
    return;
  } else if (!wifiConnected) {
    wifiConnected = true;
    Serial.printf("[WIFI] Reconnected! IP: %s\n", WiFi.localIP().toString().c_str());
  }

  // MQTT keep alive (non-blocking)
  if (!mqttClient.connected()) {
    mqttConnected = false;
    tryMqttConnect();
  }
  mqttClient.loop();

  // Check serial for 'r' command to trigger recording
  if (Serial.available()) {
    char c = Serial.read();
    if (c == 'r' || c == 'R') {
      Serial.println("[CMD] Record triggered via serial");
      buttonPressed = true;
    } else if (c == 't' || c == 'T') {
      // Mic test: read 10 samples and print
      Serial.println("[TEST] Reading mic samples...");
      int16_t testBuf[10];
      size_t bytesRead = 0;
      i2s_read(I2S_PORT, testBuf, sizeof(testBuf), &bytesRead, 1000);
      Serial.printf("[TEST] Read %d bytes: ", bytesRead);
      for (int i = 0; i < 10; i++) {
        Serial.printf("%d ", testBuf[i]);
      }
      Serial.println();
      if (bytesRead == 0) {
        Serial.println("[TEST] WARNING: No data from mic! Check wiring.");
      } else {
        bool allZero = true;
        for (int i = 0; i < 10; i++) {
          if (testBuf[i] != 0) { allZero = false; break; }
        }
        if (allZero) {
          Serial.println("[TEST] WARNING: All zeros! Mic may not be connected.");
        } else {
          Serial.println("[TEST] Mic is working!");
        }
      }
    }
  }

  // Button pressed: record and upload
  if (buttonPressed) {
    buttonPressed = false;
    recording = true;
    audioSamples = 0;
    Serial.println("[REC] Recording started (5s max)...");

    unsigned long startTime = millis();

    while (recording && (millis() - startTime < 5000)) {
      size_t bytesRead = 0;
      // Read 32-bit samples (INMP441 outputs 24-bit left-aligned in 32-bit frame)
      i2s_read(I2S_PORT, i2sRawBuf, BUF_SAMPLES * sizeof(int32_t), &bytesRead, portMAX_DELAY);
      size_t samplesRead = bytesRead / sizeof(int32_t);
      // Shift >>14: INMP441 is 18-bit effective, left-aligned in 32-bit
      // >>14 scales correctly to 16-bit without noise amplification
      for (size_t i = 0; i < samplesRead && audioSamples < audioMaxSamples; i++) {
        audioBuffer[audioSamples++] = (int16_t)(i2sRawBuf[i] >> 14);
      }
      if (audioSamples >= audioMaxSamples) break;
    }

    recording = false;
    float duration = (float)audioSamples / SAMPLE_RATE;
    Serial.printf("[REC] Done: %d samples (%.1fs)\n", audioSamples, duration);

    // Print first 10 samples for debug
    Serial.print("[REC] First samples: ");
    for (int i = 0; i < 10 && i < (int)audioSamples; i++) {
      Serial.printf("%d ", audioBuffer[i]);
    }
    Serial.println();

    if (audioSamples > SAMPLE_RATE) {
      uploadAudio();
    } else {
      Serial.println("[REC] Too short, skipping upload");
    }

    audioSamples = 0;
  }

  delay(10);
}
