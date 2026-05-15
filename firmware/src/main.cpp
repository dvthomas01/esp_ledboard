#include <Arduino.h>
#include <stdlib.h>
#include <string.h>
#include <esp_heap_caps.h>

#include "animation.h"
#include "config.h"
#include "hardware_profile.h"
#include "animation_engine.h"
#include "json_parser.h"
#include "http_server.h"

AnimationEngine engine;

// Boot animation (replaced by POST /animation): four lit corners, 32×48 × 2 frames.
static bool buildBootCornerAnimation(Animation& out) {
    strlcpy(out.meta.name, "Corner blink", sizeof(out.meta.name));
    strlcpy(out.meta.createdAt, "2026-04-28T00:00:00Z", sizeof(out.meta.createdAt));
    strlcpy(out.meta.author, "firmware", sizeof(out.meta.author));

    out.config.width      = DEFAULT_WIDTH;
    out.config.height     = DEFAULT_HEIGHT;
    out.config.fps        = 2;
    out.config.loop       = true;
    out.config.brightness = 0.85f;

    out.frameCount     = 2;
    out.pixelsPerFrame = (uint32_t)DEFAULT_WIDTH * DEFAULT_HEIGHT;
    uint32_t frameSz   = out.pixelsPerFrame * 3;

    out.framePtrs = (uint8_t**)malloc(out.frameCount * sizeof(uint8_t*));
    if (!out.framePtrs) return false;
    for (uint16_t f = 0; f < out.frameCount; ++f) {
        out.framePtrs[f] = (uint8_t*)ps_malloc(frameSz);
        if (!out.framePtrs[f]) { out.freeFrames(); return false; }
        memset(out.framePtrs[f], 0, frameSz);
    }

    const uint16_t W = DEFAULT_WIDTH;
    const uint16_t H = DEFAULT_HEIGHT;

    auto setPix = [&](uint16_t frame, uint16_t lx, uint16_t ly, uint8_t r, uint8_t g, uint8_t b) {
        uint32_t idx = (uint32_t)ly * W + lx;
        out.framePtrs[frame][idx * 3]     = r;
        out.framePtrs[frame][idx * 3 + 1] = g;
        out.framePtrs[frame][idx * 3 + 2] = b;
    };

    uint8_t rr = 220, gg = 40, bb = 40;
    setPix(0, 0, 0, rr, gg, bb);
    setPix(0, (uint16_t)(W - 1), 0, rr, gg, bb);
    setPix(0, 0, (uint16_t)(H - 1), rr, gg, bb);
    setPix(0, (uint16_t)(W - 1), (uint16_t)(H - 1), rr, gg, bb);
    /* frame 1: all black (calloc zero) */
    return true;
}

void setup() {
    Serial.begin(115200);
    // Native USB CDC on ESP32-S3: wait up to 3 s for the host to open the serial
    // monitor before printing anything, so the boot log is always visible.
    unsigned long t0 = millis();
    while (!Serial && (millis() - t0) < 3000) delay(50);
    delay(200);
    Serial.println("\n=== LED Poster Firmware v1 ===");

    HardwareProfile profile;
    profile.width            = DEFAULT_WIDTH;
    profile.height           = DEFAULT_HEIGHT;
    profile.columnMajor      = DEFAULT_COLUMN_MAJOR;
    profile.gpioPin          = DEFAULT_GPIO_PIN;
    profile.gpioPinSecondary = DEFAULT_GPIO_PIN_SECONDARY;
    profile.serpentine       = DEFAULT_SERPENTINE;
    profile.maxBrightness    = (float)DEFAULT_BRIGHTNESS / 255.0f;
    strlcpy(profile.profileName, "Poster 32x48 dual", sizeof(profile.profileName));

    Serial.printf("[main] heap before engine init: %u B\n", (unsigned)esp_get_free_heap_size());
    engine.begin(profile);
    Serial.printf("[main] heap after engine init:  %u B\n", (unsigned)esp_get_free_heap_size());

    Animation anim{};
    if (buildBootCornerAnimation(anim)) {
        if (!engine.loadAnimation(anim)) {
            anim.freeFrames();
        } else {
            engine.play();
            Serial.println("[main] boot animation playing");
        }
    }

    httpServerBegin(engine);

    Serial.printf("[main] heap after wifi+http:    %u B  (%.1f KB free)\n",
                  (unsigned)esp_get_free_heap_size(),
                  (float)esp_get_free_heap_size() / 1024.0f);
    Serial.println("[main] ready — send animations via HTTP");
    Serial.println("[main] tip: run `pio device monitor` after upload to see the ESP base URL at boot");
}

void loop() {
    engine.tick();
    httpServerLoop();
}
