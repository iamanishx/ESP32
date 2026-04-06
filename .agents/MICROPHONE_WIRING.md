# INMP441 Microphone Wiring Guide

## What You Need

- ESP32-S3 Mini Board
- INMP441 I2S MEMS Microphone Module
- 6x Jumper Wires (Female-to-Female)

## Pin Mapping

| INMP441 Pin | ESP32-S3 GPIO | Wire Color (suggested) | Notes |
|-------------|---------------|------------------------|-------|
| **VDD** | **3.3V** | Red | Power (3.3V only, NOT 5V) |
| **GND** | **GND** | Black | Ground |
| **SCK** | **GPIO 2** | Yellow | Bit Clock (BCLK) |
| **WS** | **GPIO 1** | Green | Word Select (LRCLK) |
| **SD** | **GPIO 3** | Blue | Serial Data (DOUT) |
| **L/R** | **GND** | White | Left channel (tie to GND) |

## Visual Wiring Diagram

```
ESP32-S3 Mini                    INMP441 Module
┌─────────────┐                  ┌─────────────┐
│             │                  │             │
│  3.3V  ─────┼──────────────────┤ VDD         │
│  GND   ─────┼──────┬───────────┤ GND         │
│  GPIO1 ─────┼──────┤           │             │
│  GPIO2 ─────┼──────┤           │             │
│  GPIO3 ─────┼──────┤           │             │
│             │      │           │   ┌───┐     │
│             │      └───────────┤   │ ● │ Mic │
│             │                  │   └───┘     │
│             │                  │             │
│             │                  └─────────────┘
│             │
│             │  GPIO1 ──┐
│             │  GND   ──┤ (L/R pin to GND)
└─────────────┘
```

## Step-by-Step Connection

### 1. Power (VDD and GND)

- Connect **INMP441 VDD** to **ESP32-S3 3.3V** pin
- Connect **INMP441 GND** to **ESP32-S3 GND** pin
- **WARNING**: Do NOT connect VDD to 5V. The INMP441 is 3.3V only.

### 2. I2S Clock Lines

- Connect **INMP441 SCK** (Serial Clock) to **ESP32 GPIO 2**
- Connect **INMP441 WS** (Word Select) to **ESP32 GPIO 1**

### 3. Data Line

- Connect **INMP441 SD** (Serial Data) to **ESP32 GPIO 3**

### 4. Channel Selection

- Connect **INMP441 L/R** to **GND**
- This selects the **Left** audio channel
- If you connect L/R to VDD, it outputs Right channel instead

## Firmware Configuration

Your `src/main.cpp` already has these pins defined:

```cpp
#define I2S_WS        1   // Word Select -> GPIO 1
#define I2S_SCK       2   // Serial Clock -> GPIO 2
#define I2S_SD        3   // Serial Data -> GPIO 3
```

## Verification Steps

1. Double-check all 6 connections before powering on
2. Ensure no loose wires or short circuits
3. Power the ESP32 via USB-C
4. Open Serial Monitor at 115200 baud
5. Press BOOT button to record
6. You should see: `Recording...` then `Recorded XXXX samples (X.Xs)`

## Troubleshooting

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| No audio data / all zeros | SD wire loose or wrong pin | Check GPIO 3 connection |
| Distorted audio | SCK/WS swapped | Verify GPIO 1 and 2 |
| No response at all | VDD not connected | Check 3.3V connection |
| Module gets hot | VDD connected to 5V | Disconnect immediately, use 3.3V |
| Only noise | L/R floating | Connect L/R to GND |

## Notes

- The INMP441 is a digital MEMS microphone. It outputs I2S data directly, no ADC needed
- Keep wires as short as possible (under 10cm) for best signal quality
- The small hole on the module is the sound port. Keep it unobstructed
- Speak from 10-30cm away for best results
