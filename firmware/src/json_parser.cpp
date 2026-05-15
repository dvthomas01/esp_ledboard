#include "json_parser.h"
#include "config.h"
#include <ArduinoJson.h>
#include <Arduino.h>
#include <string.h>

// ── Lightweight raw-JSON helpers ────────────────────────────────────────────
// These parse frame pixel data directly without building an ArduinoJson DOM,
// keeping peak heap usage to only the raw JSON string + binary frame buffer.

static const char* skipWs(const char* p) {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') ++p;
    return p;
}

// Count top-level arrays in the "frames" array without allocating any objects.
static uint16_t countFramesInJson(const char* json) {
    const char* p = strstr(json, "\"frames\"");
    if (!p) return 0;
    p += 8; // skip "frames"
    p = skipWs(p);
    if (*p == ':') ++p;
    p = skipWs(p);
    if (*p != '[') return 0;
    ++p; // enter outer frames [

    uint16_t count = 0;
    int depth = 0;
    bool inStr = false;

    for (; *p; ++p) {
        if (inStr) {
            if (*p == '"' && *(p - 1) != '\\') inStr = false;
        } else {
            if      (*p == '"') { inStr = true; }
            else if (*p == '[') { if (depth++ == 0) ++count; }
            else if (*p == ']') { if (--depth < 0) return count; }
        }
    }
    return count;
}

// Parse one frame's pixel data from the JSON, advancing *pp past the closing ].
// Writes RGB bytes into dest (pixelsPerFrame * 3 bytes).
static bool parseOneFrame(const char*& pp, uint8_t* dest, uint32_t pixelsPerFrame) {
    pp = skipWs(pp);
    if (*pp != '[') return false;
    ++pp; // enter frame [

    for (uint32_t px = 0; px < pixelsPerFrame; ++px) {
        if (px > 0) {
            pp = skipWs(pp);
            if (*pp == ',') ++pp;
        }
        pp = skipWs(pp);
        if (*pp != '[') return false;
        ++pp; // enter pixel [

        // R
        pp = skipWs(pp);
        unsigned r = 0;
        while (*pp >= '0' && *pp <= '9') r = r * 10 + (unsigned)(*pp++ - '0');
        pp = skipWs(pp);
        if (*pp != ',') return false;
        ++pp;

        // G
        pp = skipWs(pp);
        unsigned g = 0;
        while (*pp >= '0' && *pp <= '9') g = g * 10 + (unsigned)(*pp++ - '0');
        pp = skipWs(pp);
        if (*pp != ',') return false;
        ++pp;

        // B
        pp = skipWs(pp);
        unsigned b = 0;
        while (*pp >= '0' && *pp <= '9') b = b * 10 + (unsigned)(*pp++ - '0');

        pp = skipWs(pp);
        if (*pp != ']') return false;
        ++pp; // exit pixel ]

        dest[px * 3]     = (uint8_t)(r > 255 ? 255 : r);
        dest[px * 3 + 1] = (uint8_t)(g > 255 ? 255 : g);
        dest[px * 3 + 2] = (uint8_t)(b > 255 ? 255 : b);
    }

    pp = skipWs(pp);
    if (*pp != ']') return false;
    ++pp; // exit frame ]
    return true;
}

static bool parseFramesManual(const char* json, uint8_t** framePtrs,
                               uint16_t frameCount, uint32_t pixelsPerFrame) {
    const char* p = strstr(json, "\"frames\"");
    if (!p) return false;
    p += 8;
    p = skipWs(p);
    if (*p == ':') ++p;
    p = skipWs(p);
    if (*p != '[') return false;
    ++p; // enter outer frames [

    for (uint16_t f = 0; f < frameCount; ++f) {
        if (f > 0) {
            p = skipWs(p);
            if (*p == ',') ++p;
        }
        p = skipWs(p);
        if (!parseOneFrame(p, framePtrs[f], pixelsPerFrame)) {
            Serial.printf("[json] pixel parse failed at frame %u\n", f);
            return false;
        }
    }
    return true;
}

// ── Public API ──────────────────────────────────────────────────────────────

bool parseAnimationJson(const char* json, Animation& out) {
    Serial.printf("[json] free heap before parse: %u bytes\n", (unsigned)esp_get_free_heap_size());

    // Phase 1: parse ONLY meta+config with ArduinoJson (filter out frames).
    // This keeps ArduinoJson DOM tiny (~2 KB) regardless of frame count.
    JsonDocument filter;
    filter["version"]              = true;
    filter["type"]                 = true;
    filter["meta"]["name"]         = true;
    filter["meta"]["created_at"]   = true;
    filter["meta"]["author"]       = true;
    filter["config"]["width"]      = true;
    filter["config"]["height"]     = true;
    filter["config"]["fps"]        = true;
    filter["config"]["loop"]       = true;
    filter["config"]["brightness"] = true;
    // "frames" intentionally absent → ArduinoJson skips it entirely.

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, json, DeserializationOption::Filter(filter));
    if (err) {
        Serial.printf("[json] parse error: %s\n", err.c_str());
        return false;
    }

    if (doc["version"].as<int>() != 1) {
        Serial.println("[json] unsupported version");
        return false;
    }
    if (strcmp(doc["type"].as<const char*>(), "animation") != 0) {
        Serial.println("[json] type is not 'animation'");
        return false;
    }

    JsonObject meta = doc["meta"];
    strlcpy(out.meta.name,      meta["name"]       | "untitled", sizeof(out.meta.name));
    strlcpy(out.meta.createdAt, meta["created_at"] | "",         sizeof(out.meta.createdAt));
    strlcpy(out.meta.author,    meta["author"]      | "",         sizeof(out.meta.author));

    JsonObject cfg = doc["config"];
    out.config.width      = cfg["width"]      | 0;
    out.config.height     = cfg["height"]     | 0;
    out.config.fps        = cfg["fps"]        | 10;
    out.config.loop       = cfg["loop"]       | true;
    out.config.brightness = cfg["brightness"] | 1.0f;

    if (out.config.width == 0 || out.config.height == 0) {
        Serial.println("[json] invalid dimensions");
        return false;
    }
    if (out.config.fps < MIN_FPS || out.config.fps > MAX_FPS) {
        Serial.printf("[json] fps %u out of range\n", out.config.fps);
        return false;
    }

    uint32_t pixelsPerFrame = (uint32_t)out.config.width * out.config.height;
    if (pixelsPerFrame > MAX_PIXELS) {
        Serial.printf("[json] too many pixels: %u (max %u)\n", pixelsPerFrame, MAX_PIXELS);
        return false;
    }

    // Phase 2: count frames via raw scan (O(n) time, O(1) space).
    uint16_t frameCount = countFramesInJson(json);
    if (frameCount == 0) {
        Serial.println("[json] no frames found");
        return false;
    }
    if (frameCount > MAX_FRAMES) {
        Serial.printf("[json] too many frames: %u (max %u)\n", frameCount, MAX_FRAMES);
        return false;
    }

    out.pixelsPerFrame = pixelsPerFrame;
    out.frameCount     = frameCount;
    uint32_t frameSizeBytes = pixelsPerFrame * 3;

    // Phase 3: allocate per-frame buffers.
    // ps_malloc() prefers PSRAM (8 MB on XIAO ESP32-S3); falls back to SRAM
    // on boards without PSRAM.  free() handles both regions correctly.
    out.framePtrs = (uint8_t**)malloc(frameCount * sizeof(uint8_t*));
    if (!out.framePtrs) {
        Serial.printf("[json] malloc failed for ptr array (free heap: %u)\n",
                      (unsigned)esp_get_free_heap_size());
        return false;
    }
    memset(out.framePtrs, 0, frameCount * sizeof(uint8_t*));

    for (uint16_t f = 0; f < frameCount; ++f) {
        out.framePtrs[f] = (uint8_t*)ps_malloc(frameSizeBytes);
        if (!out.framePtrs[f]) {
            Serial.printf("[json] ps_malloc failed for frame %u/%u (psram free: %u, heap: %u)\n",
                          f, frameCount,
                          (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                          (unsigned)esp_get_free_heap_size());
            out.freeFrames();
            return false;
        }
    }

    // Phase 4: parse pixel data into per-frame buffers — no ArduinoJson DOM.
    if (!parseFramesManual(json, out.framePtrs, frameCount, pixelsPerFrame)) {
        out.freeFrames();
        return false;
    }

    Serial.printf("[json] loaded \"%s\" (%u frames, %ux%u @ %u fps)\n",
                  out.meta.name, frameCount,
                  out.config.width, out.config.height, out.config.fps);
    return true;
}

bool parseAnimationFrameJson(const char* frameJson, uint8_t* dest, uint32_t pixelsPerFrame) {
    const char* p = skipWs(frameJson);
    return parseOneFrame(p, dest, pixelsPerFrame);
}

bool parseProfileJson(const char* json, HardwareProfile& out) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, json);
    if (err) {
        Serial.printf("[json] profile parse error: %s\n", err.c_str());
        return false;
    }

    if (doc["version"].as<int>() != 1) {
        Serial.println("[json] unsupported profile version");
        return false;
    }
    if (strcmp(doc["type"].as<const char*>(), "hardware_profile") != 0) {
        Serial.println("[json] type is not 'hardware_profile'");
        return false;
    }

    strlcpy(out.profileName, doc["profile_name"] | "default", sizeof(out.profileName));

    JsonObject grid = doc["grid"];
    out.width       = grid["width"]        | 32;
    out.height      = grid["height"]       | 48;
    out.serpentine  = grid["serpentine"]   | false;
    out.columnMajor = grid["column_major"] | false;
    out.rotation    = grid["rotation"]     | 0;
    out.origin      = parseOrigin(grid["origin"] | "top_left");

    JsonObject led = doc["led"];
    out.ledType      = parseLedType(led["type"]         | "WS2812B");
    out.colorOrder   = parseColorOrder(led["color_order"] | "GRB");
    out.gpioPin      = led["gpio_pin"]                   | DEFAULT_GPIO_PIN;
    out.gpioPinSecondary = static_cast<uint8_t>(255);
    if (!led["gpio_pin_secondary"].isNull()) {
        int v = led["gpio_pin_secondary"].as<int>();
        if (v >= 0 && v <= 48) out.gpioPinSecondary = static_cast<uint8_t>(v);
    }
    out.maxBrightness = led["max_brightness"] | 1.0f;
    out.maxCurrentMa  = led["max_current_ma"] | 5000;

    if (out.gpioPinSecondary != static_cast<uint8_t>(255)) {
        if ((out.width & 1) != 0) {
            Serial.println("[json] dual strip requires even grid.width");
            return false;
        }
        if (out.gpioPin == out.gpioPinSecondary) {
            Serial.println("[json] gpio_pin and gpio_pin_secondary must differ");
            return false;
        }
    }

    if (out.rotation != 0 && out.rotation != 90 &&
        out.rotation != 180 && out.rotation != 270) {
        Serial.printf("[json] invalid rotation: %u\n", out.rotation);
        out.rotation = 0;
    }

    return true;
}
