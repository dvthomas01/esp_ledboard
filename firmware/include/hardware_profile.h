#pragma once

#include <stdint.h>
#include <Arduino.h>

enum class Origin : uint8_t {
    TOP_LEFT,
    TOP_RIGHT,
    BOTTOM_LEFT,
    BOTTOM_RIGHT
};

enum class ColorOrder : uint8_t {
    GRB,
    RGB,
    BRG,
    RBG
};

enum class LedType : uint8_t {
    WS2812B,
    SK6812
};

struct HardwareProfile {
    char     profileName[64] = "Poster 32x48 Dual";
    uint16_t width           = 32;
    uint16_t height          = 48;
    bool     serpentine      = false;
    bool     columnMajor     = false;  // true when strips run vertically (each strip = one column)
    uint16_t rotation        = 0;      // 0, 90, 180, 270
    Origin   origin          = Origin::TOP_LEFT;
    LedType  ledType         = LedType::WS2812B;
    ColorOrder colorOrder    = ColorOrder::GRB;
    uint8_t  gpioPin         = 2;
    /** If != 255, second strip drives the right half (x ≥ width/2); see logicalToDualStrip(). */
    uint8_t  gpioPinSecondary = 255;
    float    maxBrightness   = 1.0f;
    uint16_t maxCurrentMa    = 5000;

    uint32_t pixelCount() const { return (uint32_t)width * height; }
};

Origin     parseOrigin(const char* str);
ColorOrder parseColorOrder(const char* str);
LedType    parseLedType(const char* str);
