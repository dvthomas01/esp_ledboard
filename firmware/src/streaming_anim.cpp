#include "streaming_anim.h"
#include "animation.h"
#include "config.h"

#include <WiFi.h>
#include <ArduinoJson.h>
#include <Arduino.h>

// ── Constants ─────────────────────────────────────────────────────────────────

constexpr uint16_t STREAM_PORT   = 8081;
constexpr uint32_t IO_TIMEOUT_MS = 15000;

// Must be large enough to hold the full JSON up to and including the "frames"
// key (meta + config section).  Pretty-printed header ≈ 350 chars; 768 is safe.
constexpr size_t CFG_BUF_SIZE = 768;

// Max frames to pre-allocate.  Realloc'd in 2-frame increments if exceeded.
constexpr uint16_t PREALLOC_FRAMES = 4;

// ── State ─────────────────────────────────────────────────────────────────────

static WiFiServer      _srv(STREAM_PORT);
static AnimationEngine* _eng = nullptr;

// ── Low-level I/O ─────────────────────────────────────────────────────────────

// Read one byte with deadline; returns byte value (≥0), -1 on disconnect, -2 on timeout.
static int timedRead(WiFiClient& c, uint32_t deadline) {
    while ((int32_t)(millis() - deadline) < 0) {
        int v = c.read();
        if (v >= 0) return v;
        if (!c.connected()) return -1;
        delay(1);
    }
    return -2;
}

// Read one HTTP header line, strip \r, return char count (0 = blank / end of headers).
static int readHttpLine(WiFiClient& c, char* buf, int cap, uint32_t deadline) {
    int n = 0;
    while (true) {
        int v = timedRead(c, deadline);
        if (v < 0) break;
        if (v == '\n') break;
        if (v != '\r' && n < cap - 1) buf[n++] = (char)v;
    }
    buf[n] = '\0';
    return n;
}

// ── Config-section extractor ──────────────────────────────────────────────────

// Stream bytes into buf until the literal token "frames" is found.
// buf is null-terminated on return.  Returns true if found within cap bytes.
static bool bufferUntilFrames(WiFiClient& c, char* buf, size_t cap, uint32_t deadline) {
    static const char KEY[] = "\"frames\"";
    constexpr size_t  KLEN  = sizeof(KEY) - 1;   // 8
    size_t n = 0, matched = 0;
    while (n < cap - 1) {
        int v = timedRead(c, deadline);
        if (v < 0) break;
        char ch = (char)v;
        buf[n++] = ch;
        if (ch == KEY[matched]) {
            if (++matched == KLEN) { buf[n] = '\0'; return true; }
        } else {
            matched = (ch == KEY[0]) ? 1 : 0;
        }
    }
    buf[n] = '\0';
    return false;
}

// Patch cfgBuf to be a valid closed JSON object by replacing the comma that
// precedes "frames" with '}' and truncating there.
// Turns  {"meta":{...},"config":{...},"frames"  →  {"meta":{...},"config":{...}}
static void patchConfigJson(char* buf) {
    char* framesPos = strstr(buf, "\"frames\"");
    if (!framesPos) return;
    char* comma = framesPos - 1;
    while (comma > buf && *comma != ',') comma--;
    if (*comma == ',') { *comma = '}'; *(comma + 1) = '\0'; }
}

// ── Pixel parser ──────────────────────────────────────────────────────────────

// Read an unsigned decimal integer from the stream.
// firstDigit is the first digit character already read.
// *termCh receives the first non-digit character that terminated the number.
static uint32_t readUint(WiFiClient& c, int firstDigit, int* termCh, uint32_t dl) {
    uint32_t v = (uint32_t)(firstDigit - '0');
    for (;;) {
        int ch = timedRead(c, dl);
        if (ch >= '0' && ch <= '9') { v = v * 10 + (uint32_t)(ch - '0'); }
        else { *termCh = ch; return v; }
    }
}

// Read one [R,G,B] pixel from the stream.
// Stream may be positioned anywhere before the pixel's opening '['.
// Works with both compact ([255,0,0]) and pretty-printed (newlines + spaces) JSON.
static bool readPixel(WiFiClient& c, uint8_t& r, uint8_t& g, uint8_t& b, uint32_t dl) {
    int ch, term;

    // Skip to '['
    do { ch = timedRead(c, dl); } while (ch >= 0 && ch != '[');
    if (ch < 0) return false;

    // R: skip whitespace, then read digits
    do { ch = timedRead(c, dl); } while (ch >= 0 && (ch < '0' || ch > '9'));
    if (ch < 0) return false;
    uint32_t rv = readUint(c, ch, &term, dl);

    // G: skip comma + whitespace, then read digits
    do { ch = timedRead(c, dl); } while (ch >= 0 && (ch < '0' || ch > '9'));
    if (ch < 0) return false;
    uint32_t gv = readUint(c, ch, &term, dl);

    // B: skip comma + whitespace, then read digits
    do { ch = timedRead(c, dl); } while (ch >= 0 && (ch < '0' || ch > '9'));
    if (ch < 0) return false;
    uint32_t bv = readUint(c, ch, &term, dl);

    // Skip to ']' that closes this pixel (term is already the first non-digit after B)
    while (term >= 0 && term != ']') term = timedRead(c, dl);

    r = (rv > 255u) ? 255u : (uint8_t)rv;
    g = (gv > 255u) ? 255u : (uint8_t)gv;
    b = (bv > 255u) ? 255u : (uint8_t)bv;
    return (term == ']');
}

// ── Frame stream parser ───────────────────────────────────────────────────────

// Parse the frames array directly from the socket into per-frame heap buffers.
// Stream must be positioned just after the "frames" token (at the ':[[' part).
// On success sets *framePtrsOut / *frameCountOut; caller calls anim.freeFrames().
static bool parseFramesStream(WiFiClient& c,
                              uint32_t    pxPerFrame,
                              uint8_t***  framePtrsOut,
                              uint16_t*   frameCountOut,
                              uint32_t    deadline) {
    *framePtrsOut  = nullptr;
    *frameCountOut = 0;

    const uint32_t frameSz = pxPerFrame * 3;

    // Allocate the pointer array (tiny — PREALLOC_FRAMES × 4 bytes); grown with
    // realloc as needed.  Individual frame buffers are small (4 608 B for 32×48),
    // so they fit into scattered heap gaps that a flat contiguous buffer could not.
    uint16_t allocFrames = PREALLOC_FRAMES;
    uint8_t** ptrs = (uint8_t**)malloc(allocFrames * sizeof(uint8_t*));
    if (!ptrs) { Serial.println("[stream] malloc failed for ptr array"); return false; }
    memset(ptrs, 0, allocFrames * sizeof(uint8_t*));

    // Find the outer '[' of the frames array
    int ch;
    do { ch = timedRead(c, deadline); } while (ch >= 0 && ch != '[');
    if (ch < 0) { free(ptrs); Serial.println("[stream] timeout before outer ["); return false; }

    while (true) {
        // Skip whitespace and commas; look for '[' (next frame) or ']' (end)
        do { ch = timedRead(c, deadline); }
        while (ch == ' ' || ch == ',' || ch == '\n' || ch == '\r' || ch == '\t');
        if (ch < 0) {
            for (uint16_t i = 0; i < *frameCountOut; ++i) free(ptrs[i]);
            free(ptrs);
            Serial.println("[stream] read error between frames"); return false;
        }
        if (ch == ']') break;
        if (ch != '[') {
            for (uint16_t i = 0; i < *frameCountOut; ++i) free(ptrs[i]);
            free(ptrs);
            Serial.printf("[stream] expected '[' for frame, got 0x%02X\n", (unsigned)ch);
            return false;
        }

        uint16_t f = *frameCountOut;

        // Grow pointer array if needed (realloc is cheap — only pointer-sized entries)
        if (f >= allocFrames) {
            uint16_t newAlloc = allocFrames + 2;
            if (newAlloc > MAX_FRAMES) {
                Serial.printf("[stream] hit MAX_FRAMES (%u), truncating\n", (unsigned)MAX_FRAMES);
                break;
            }
            uint8_t** newPtrs = (uint8_t**)realloc(ptrs, newAlloc * sizeof(uint8_t*));
            if (!newPtrs) {
                Serial.println("[stream] realloc of ptr array failed; keeping frames so far");
                break;
            }
            ptrs = newPtrs;
            allocFrames = newAlloc;
        }

        // Allocate this frame's buffer individually
        ptrs[f] = (uint8_t*)malloc(frameSz);
        if (!ptrs[f]) {
            Serial.printf("[stream] malloc failed for frame %u\n", (unsigned)f);
            for (uint16_t i = 0; i < f; ++i) free(ptrs[i]);
            free(ptrs);
            return false;
        }

        // Parse every pixel of this frame directly into its buffer
        for (uint32_t px = 0; px < pxPerFrame; px++) {
            uint8_t r, g, b;
            if (!readPixel(c, r, g, b, deadline)) {
                Serial.printf("[stream] pixel %u of frame %u failed\n", (unsigned)px, (unsigned)f);
                for (uint16_t i = 0; i <= f; ++i) if (ptrs[i]) free(ptrs[i]);
                free(ptrs);
                return false;
            }
            ptrs[f][px * 3]     = r;
            ptrs[f][px * 3 + 1] = g;
            ptrs[f][px * 3 + 2] = b;
        }

        // Consume the closing ']' of this frame
        do { ch = timedRead(c, deadline); } while (ch >= 0 && ch != ']');
        if (ch < 0) {
            for (uint16_t i = 0; i <= f; ++i) if (ptrs[i]) free(ptrs[i]);
            free(ptrs);
            Serial.println("[stream] timeout after last pixel"); return false;
        }

        (*frameCountOut)++;
        Serial.printf("[stream] frame %u done, heap: %u\n",
                      (unsigned)(*frameCountOut), (unsigned)esp_get_free_heap_size());
    }

    if (*frameCountOut == 0) { free(ptrs); return false; }
    *framePtrsOut = ptrs;
    return true;
}

// ── HTTP response helper ──────────────────────────────────────────────────────

static void sendResp(WiFiClient& c, int code, const char* status, const char* body) {
    size_t len = strlen(body);
    c.printf(
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: application/json\r\n"
        "Content-Length: %u\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "\r\n"
        "%s",
        code, status, (unsigned)len, body);
}

// ── Connection handler ────────────────────────────────────────────────────────

static void handleStreamClient(WiFiClient& client) {
    const uint32_t deadline = millis() + IO_TIMEOUT_MS;
    char line[256];

    // Parse HTTP request line
    readHttpLine(client, line, sizeof(line), deadline);
    Serial.printf("[stream] %s\n", line);
    const bool isPost = (strncmp(line, "POST ", 5) == 0);

    // Read headers; extract Content-Length
    size_t contentLength = 0;
    while (true) {
        int n = readHttpLine(client, line, sizeof(line), deadline);
        if (n == 0) break;
        if (strncasecmp(line, "Content-Length:", 15) == 0)
            contentLength = (size_t)atol(line + 15);
    }

    if (!isPost || contentLength == 0) {
        sendResp(client, 400, "Bad Request",
                 "{\"status\":\"error\",\"message\":\"POST with non-empty body required\"}");
        return;
    }

    Serial.printf("[stream] body %u B, free heap %u B\n",
                  (unsigned)contentLength, (unsigned)esp_get_free_heap_size());

    // Buffer the opening section until we find "frames" to extract meta + config
    static char cfgBuf[CFG_BUF_SIZE + 1];
    if (!bufferUntilFrames(client, cfgBuf, CFG_BUF_SIZE, deadline)) {
        sendResp(client, 400, "Bad Request",
                 "{\"status\":\"error\",\"message\":\"\\\"frames\\\" key not found in first 768 chars\"}");
        return;
    }
    patchConfigJson(cfgBuf);    // close the JSON object before "frames"

    // Parse meta + config with ArduinoJson (tiny DOM, no frames included)
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

    JsonDocument doc;
    deserializeJson(doc, cfgBuf, DeserializationOption::Filter(filter));

    Animation anim{};
    strlcpy(anim.meta.name,      doc["meta"]["name"]       | "untitled", sizeof(anim.meta.name));
    strlcpy(anim.meta.createdAt, doc["meta"]["created_at"] | "",         sizeof(anim.meta.createdAt));
    strlcpy(anim.meta.author,    doc["meta"]["author"]     | "",         sizeof(anim.meta.author));
    anim.config.width      = doc["config"]["width"]      | (uint16_t)0;
    anim.config.height     = doc["config"]["height"]     | (uint16_t)0;
    anim.config.fps        = doc["config"]["fps"]        | (uint8_t)10;
    anim.config.loop       = doc["config"]["loop"]       | true;
    anim.config.brightness = doc["config"]["brightness"] | 1.0f;

    if (anim.config.width == 0 || anim.config.height == 0) {
        sendResp(client, 400, "Bad Request",
                 "{\"status\":\"error\",\"message\":\"missing config.width / config.height\"}");
        return;
    }

    const uint32_t pxPerFrame = (uint32_t)anim.config.width * anim.config.height;
    if (pxPerFrame > MAX_PIXELS) {
        sendResp(client, 400, "Bad Request",
                 "{\"status\":\"error\",\"message\":\"pixel count exceeds MAX_PIXELS\"}");
        return;
    }
    anim.pixelsPerFrame = pxPerFrame;

    // Stream-parse frames into per-frame heap buffers
    uint8_t** framePtrs = nullptr;
    uint16_t  frameCount = 0;
    if (!parseFramesStream(client, pxPerFrame, &framePtrs, &frameCount, deadline)
            || frameCount == 0) {
        sendResp(client, 400, "Bad Request",
                 "{\"status\":\"error\",\"message\":\"frame parsing failed\"}");
        return;
    }

    anim.framePtrs  = framePtrs;
    anim.frameCount = frameCount;

    if (!_eng->loadAnimation(anim)) {
        anim.freeFrames();  // engine did not take ownership
        sendResp(client, 400, "Bad Request",
                 "{\"status\":\"error\",\"message\":\"animation rejected by engine\"}");
        return;
    }

    Serial.printf("[stream] loaded %u frame(s) [%u×%u], heap after: %u B\n",
                  (unsigned)frameCount,
                  (unsigned)anim.config.width, (unsigned)anim.config.height,
                  (unsigned)esp_get_free_heap_size());

    sendResp(client, 200, "OK", "{\"status\":\"ok\",\"message\":\"animation loaded\"}");
}

// ── Public API ────────────────────────────────────────────────────────────────

void streamingAnimServerBegin(AnimationEngine& engine) {
    _eng = &engine;
    _srv.begin();
    Serial.printf("[stream] animation server listening on :%u\n", STREAM_PORT);
}

void streamingAnimServerLoop() {
    WiFiClient client = _srv.available();
    if (!client) return;
    Serial.println("[stream] client connected");
    client.setNoDelay(true);
    handleStreamClient(client);
    client.stop();
}
