#pragma once

#include <stdint.h>

// Maximum supported grid dimensions (for static buffer allocation)
constexpr uint16_t MAX_GRID_WIDTH  = 128;
constexpr uint16_t MAX_GRID_HEIGHT = 128;
constexpr uint32_t MAX_PIXELS      = 8192;
constexpr uint16_t MAX_FRAMES      = 256;
constexpr uint8_t  MIN_FPS         = 1;
constexpr uint8_t  MAX_FPS         = 60;

// Default hardware profile — 32×48 dual GPIO (two 768-LED strands; left/right).
// Animation JSON remains row-major, top→bottom, left→right; firmware maps to strips.
constexpr uint16_t DEFAULT_WIDTH        = 32;
constexpr uint16_t DEFAULT_HEIGHT       = 48;
constexpr bool     DEFAULT_COLUMN_MAJOR = false;

// XIAO ESP32-S3: D0 = GPIO1 (left half, strip 0), D1 = GPIO2 (right half, strip 1).
constexpr uint8_t  DEFAULT_GPIO_PIN           = 1;
constexpr uint8_t  DEFAULT_GPIO_PIN_SECONDARY = 2;
constexpr uint8_t  DEFAULT_BRIGHTNESS  = 40;  // FastLED 0–255 scale

// Compile-time pin constants required by FastLED templates.
// If the physical wiring changes, update these AND recompile.
constexpr uint8_t  FASTLED_STRIP0_PIN = 1;    // D0 — left half  (x <  width/2)
constexpr uint8_t  FASTLED_STRIP1_PIN = 2;    // D1 — right half (x >= width/2)

// Maximum addressable LEDs per strip for the current hardware (32×48 / 2 strips).
// Sized to the actual hardware to avoid wasting ~20 KB of static RAM.
// If the grid dimensions change, update this constant and recompile.
constexpr uint32_t MAX_LEDS_PER_STRIP = (DEFAULT_WIDTH / 2) * DEFAULT_HEIGHT;  // 768
constexpr bool     DEFAULT_SERPENTINE  = true;
constexpr uint16_t DEFAULT_ROTATION    = 0;

// JSON document sizes (ArduinoJson)
constexpr size_t PROFILE_JSON_SIZE   = 1024;
constexpr size_t COMMAND_JSON_SIZE   = 512;
