#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("ESP32-S3 Test Started!");
}

void loop() {
  Serial.println("LED ON");
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
  Serial.println("LED OFF");
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
}
