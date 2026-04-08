# Wiring: ESP32-S3 Mini + INMP441 + Relay

## ESP32-S3 -> INMP441 (I2S Microphone)

| ESP32-S3 Pin | INMP441 Pin | Wire Type | Notes |
|-------------|-------------|-----------|-------|
| 3.3V | VDD | F-F | Power |
| GND | GND | F-F | Ground |
| GPIO 1 | WS | F-F | Word Select / LRCLK |
| GPIO 2 | SCK | F-F | Bit Clock / BCLK |
| GPIO 3 | SD | F-F | Data Out / DOUT |
| GND | L/R | F-F | Left channel (tie to GND) |

## ESP32-S3 -> Relay Module

| ESP32-S3 Pin | Relay Board | Wire Type | Notes |
|-------------|-------------|-----------|-------|
| GPIO 10 | IN1 | F-M | Light - Living Room |
| GPIO 11 | IN2 | F-M | Light - Bedroom |
| GPIO 12 | IN3 | F-M | Light - Kitchen |
| GPIO 13 | IN4 | F-M | Fan - Living Room |
| GND | GND | F-M | Common ground |
| 5V | VCC | F-M | Relay power (external if needed) |

## ESP32-S3 -> Button

| ESP32-S3 Pin | Button | Wire Type | Notes |
|-------------|--------|-----------|-------|
| GPIO 4 | One side | F-M | Uses internal pull-up |
| GND | Other side | F-M | Press connects to GND |

## Important Notes

- Relays are active-LOW: GPIO LOW = relay ON, GPIO HIGH = relay OFF
- All relays start HIGH (OFF) on boot for safety
- Use external 5V supply for relay module if ESP32 USB power is insufficient
- Keep mains wiring separate and use proper enclosures
- INMP441 operates at 3.3V only - do not connect to 5V
- Button changed to GPIO 4 to avoid boot loop (GPIO 0 is BOOT pin)
