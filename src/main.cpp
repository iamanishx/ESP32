#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <driver/i2s.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "Q7A-5G";
const char* WIFI_PASS = "iitbbsr";

const char* SERVER_URL = "http://172.60.3.80:8080";
const char* DEVICE_TOKEN = "dev-token-change-me";
const char* DEVICE_ID = "esp32-livingroom-01";

const char* MQTT_HOST = "172.60.3.80";
const int   MQTT_PORT = 1883;
const char* MQTT_TOPIC_CMD = "home/esp32-livingroom-01/cmd";
const char* MQTT_TOPIC_ACK = "home/esp32-livingroom-01/ack";

#define BUTTON_PIN    4
#define RELAY_1       10
#define RELAY_2       11
#define RELAY_3       12
#define RELAY_4       13
#define STATUS_LED    14

#define I2S_WS        1
#define I2S_SCK       2
#define I2S_SD        3
#define I2S_PORT      I2S_NUM_0
#define SAMPLE_RATE   16000
#define BUF_SAMPLES   1024

WiFiClient espClient;
PubSubClient mqttClient(espClient);
int16_t* audioBuffer = nullptr;
size_t audioSamples = 0;
size_t audioMaxSamples = 16000 * 5;
volatile bool recording = false;
volatile bool buttonPressed = false;

void mqttCallback(char* topic, byte* payload, unsigned int length);

void setupI2S() {
  i2s_config_t i2sConfig = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
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

  i2s_driver_install(I2S_PORT, &i2sConfig, 0, NULL);
  i2s_set_pin(I2S_PORT, &pinConfig);
}

void setupWiFi() {
  Serial.println("Connecting to WiFi...");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
}

void setupMQTT() {
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
}

void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.print("Connecting MQTT...");
    if (mqttClient.connect(DEVICE_ID)) {
      Serial.println("connected");
      mqttClient.subscribe(MQTT_TOPIC_CMD);
    } else {
      Serial.print("failed, rc=");
      Serial.print(mqttClient.state());
      delay(2000);
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String msg;
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.println("MQTT received: " + msg);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, msg);
  if (err) {
    Serial.println("JSON parse failed");
    return;
  }

  int relay = doc["relay"] | -1;
  int state = doc["state"] | -1;
  const char* cmdId = doc["id"] | "";

  if (relay >= 1 && relay <= 4 && state >= 0) {
    int relayPin = RELAY_1 + relay - 1;
    digitalWrite(relayPin, state);
    Serial.printf("Relay %d set to %d\n", relay, state);

    JsonDocument ack;
    ack["id"] = cmdId;
    ack["ok"] = true;
    ack["appliedAt"] = millis();
    ack["gpio"] = relayPin;
    String ackStr;
    serializeJson(ack, ackStr);
    mqttClient.publish(MQTT_TOPIC_ACK, ackStr.c_str());
  }
}

void IRAM_ATTR buttonISR() {
  static unsigned long lastInterrupt = 0;
  unsigned long now = millis();
  if (now - lastInterrupt > 500) {
    buttonPressed = true;
    lastInterrupt = now;
  }
}

bool uploadAudio() {
  HTTPClient http;
  http.begin(String(SERVER_URL) + "/v1/audio/upload");
  http.addHeader("Authorization", "Bearer " + String(DEVICE_TOKEN));
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("Content-Type", "audio/wav");

  int httpResponse = http.POST((uint8_t*)audioBuffer, audioSamples * 2);
  String response = http.getString();
  Serial.printf("Upload response: %d %s\n", httpResponse, response.c_str());

  http.end();
  return httpResponse == 202;
}

void writeWavHeader(uint8_t* header, size_t dataSize) {
  memcpy(header, "RIFF", 4);
  uint32_t chunkSize = 36 + dataSize;
  memcpy(header + 4, &chunkSize, 4);
  memcpy(header + 8, "WAVE", 4);
  memcpy(header + 12, "fmt ", 4);
  uint32_t subchunk1Size = 16;
  memcpy(header + 16, &subchunk1Size, 4);
  uint16_t audioFormat = 1;
  memcpy(header + 20, &audioFormat, 2);
  uint16_t numChannels = 1;
  memcpy(header + 22, &numChannels, 2);
  uint32_t sampleRate = SAMPLE_RATE;
  memcpy(header + 24, &sampleRate, 4);
  uint32_t byteRate = SAMPLE_RATE * 2;
  memcpy(header + 28, &byteRate, 4);
  uint16_t blockAlign = 2;
  memcpy(header + 32, &blockAlign, 2);
  uint16_t bitsPerSample = 16;
  memcpy(header + 34, &bitsPerSample, 2);
  memcpy(header + 36, "data", 4);
  uint32_t subchunk2Size = dataSize;
  memcpy(header + 40, &subchunk2Size, 4);
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Home Voice Assistant ===");

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(RELAY_1, OUTPUT);
  pinMode(RELAY_2, OUTPUT);
  pinMode(RELAY_3, OUTPUT);
  pinMode(RELAY_4, OUTPUT);
  pinMode(STATUS_LED, OUTPUT);

  digitalWrite(RELAY_1, HIGH);
  digitalWrite(RELAY_2, HIGH);
  digitalWrite(RELAY_3, HIGH);
  digitalWrite(RELAY_4, HIGH);
  digitalWrite(STATUS_LED, LOW);

  attachInterrupt(digitalPinToInterrupt(BUTTON_PIN), buttonISR, FALLING);

  audioBuffer = (int16_t*)malloc(audioMaxSamples * sizeof(int16_t));
  if (!audioBuffer) {
    Serial.println("Failed to allocate audio buffer!");
    while (1) delay(1000);
  }

  setupI2S();
  setupWiFi();
  setupMQTT();

  Serial.println("Ready. Press BOOT button to record.");
}

void loop() {
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  if (buttonPressed) {
    buttonPressed = false;
    recording = true;
    audioSamples = 0;
    digitalWrite(STATUS_LED, HIGH);
    Serial.println("Recording...");

    unsigned long startTime = millis();
    size_t samplesRead = 0;

    while (recording && (millis() - startTime < 5000)) {
      size_t bytesRead = 0;
      i2s_read(I2S_PORT, &audioBuffer[audioSamples], BUF_SAMPLES * sizeof(int16_t), &bytesRead, portMAX_DELAY);
      samplesRead = bytesRead / sizeof(int16_t);
      audioSamples += samplesRead;

      if (audioSamples >= audioMaxSamples) break;
    }

    recording = false;
    digitalWrite(STATUS_LED, LOW);
    Serial.printf("Recorded %d samples (%.1fs)\n", audioSamples, (float)audioSamples / SAMPLE_RATE);

    if (audioSamples > SAMPLE_RATE) {
      Serial.println("Uploading...");
      if (uploadAudio()) {
        Serial.println("Upload OK, waiting for response...");
      } else {
        Serial.println("Upload failed");
      }
    } else {
      Serial.println("Recording too short, skipping");
    }

    audioSamples = 0;
  }

  delay(10);
}
