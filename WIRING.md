# Wiring: ESP32-S3 Mini + INMP441 + Relay

## ESP32-S3 -> INMP441 (I2S Microphone)

| ESP32-S3 Pin | INMP441 Pin | Notes |
|-------------|-------------|-------|
| 3.3V | VDD | Power |
| GND | GND | Ground |
| GPIO 1 (I2S_WS) | WS | Word Select / LRCLK |
| GPIO 2 (I2S_SCK) | SCK | Bit Clock / BCLK |
| GPIO 3 (I2S_SD) | SD | Data Out / DOUT |
| GND | L/R | Left channel |

## ESP32-S3 -> Relay Module

| ESP32-S3 Pin | Relay Board | Notes |
|-------------|-------------|-------|
| GPIO 10 | IN1 | Light - Living Room |
| GPIO 11 | IN2 | Light - Bedroom |
| GPIO 12 | IN3 | Light - Kitchen |
| GPIO 13 | IN4 | Fan - Living Room |
| GND | GND | Common ground |
| 5V | VCC | Relay power (external if needed) |

## ESP32-S3 -> Status LED

| ESP32-S3 Pin | LED | Notes |
|-------------|-----|-------|
| GPIO 14 | LED+ | Through 220 ohm resistor |
| GND | LED- | Cathode |

## ESP32-S3 -> Button

| ESP32-S3 Pin | Button | Notes |
|-------------|--------|-------|
| GPIO 0 | One side | Uses internal pull-up |
| GND | Other side | Press connects to GND |

## Important Notes

- Relays are active-LOW: GPIO LOW = relay ON, GPIO HIGH = relay OFF
- All relays start HIGH (OFF) on boot for safety
- Use external 5V supply for relay module if ESP32 USB power is insufficient
- Keep mains wiring separate and use proper enclosures
- INMP441 operates at 3.3V only - do not connect to 5V
