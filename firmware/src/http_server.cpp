#include "http_server.h"
#include "wifi_config.h"
#include "json_parser.h"
#include "config.h"

#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <cstring>
#include <esp_heap_caps.h>

static WebServer server(HTTP_PORT);
static AnimationEngine* _engine = nullptr;

static void printEspBaseUrlBanner() {
    const String ip = WiFi.localIP().toString();
    String url = String("http://") + ip;
    if (HTTP_PORT != 80) {
        url += ':';
        url += HTTP_PORT;
    }
    Serial.println();
    Serial.println("************************************************************");
    Serial.println("*  ESP BASE URL — paste into the phone app (Settings):     *");
    Serial.println("*                                                          *");
    Serial.printf("*     %s\n", url.c_str());
    Serial.println("*                                                          *");
    Serial.println("************************************************************");
    Serial.println("*  Upload (pio run -t upload) does NOT show this output.  *");
    Serial.println("*  After flashing, run:   pio device monitor             *");
    Serial.println("*  (115200 baud, same USB port) then press RESET on board. *");
    Serial.println("************************************************************");
    Serial.println();
}

static void connectWiFi() {
  if (strcmp(WIFI_SSID, "YOUR_WIFI_SSID") == 0) {
    Serial.println("");
    Serial.println("Set WIFI_SSID and WIFI_PASSWORD in wifi_config.h then flash again.");
    while (true) { delay(1000); }
  }
  WiFi.mode(WIFI_STA);
  if (WIFI_LOCK_BSSID) {
    Serial.printf("[wifi] joining SSID \"%s\" via 2.4 GHz BSSID "
                  "%02X:%02X:%02X:%02X:%02X:%02X\n",
                  WIFI_SSID,
                  WIFI_STA_BSSID[0], WIFI_STA_BSSID[1], WIFI_STA_BSSID[2],
                  WIFI_STA_BSSID[3], WIFI_STA_BSSID[4], WIFI_STA_BSSID[5]);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD, 0, WIFI_STA_BSSID, true);
  } else {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("Connecting WiFi: ");
    Serial.println(WIFI_SSID);
  }
  const unsigned long kTimeoutMs = 60000;
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 > kTimeoutMs) {
      Serial.println("\n[wifi] timeout — check SSID/password in wifi_config.h and reflash");
      while (true) { delay(1000); }
    }
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.println("[wifi] connected.");
  Serial.print("[wifi] IP address: ");
  Serial.println(WiFi.localIP());
  // Default STA power-save delays the RF after idle; first inbound HTTP can exceed
  // short client timeouts. Disable modem sleep for reliable LAN control from the phone.
  WiFi.setSleep(false);
}

static void handleRoot();

// ── Chunked animation upload state ──────────────────────────────────────────
// Animation arrives in small pieces: POST /animation/begin → /animation/frame
// (one frame per request) → /animation/commit.  Each per-frame payload is
// ~22 KB compact JSON, well within the WebServer's single-request RAM budget.

struct PendingAnim {
    bool     active         = false;
    Animation anim;           // framePtrs malloc'd on begin; engine owns on commit
    uint16_t expectedFrames = 0;
    uint16_t receivedFrames = 0;
};
static PendingAnim _pending;

// ── Helpers ─────────────────────────────────────────────────────────

static void sendOk(const char* message = "ok") {
    JsonDocument doc;
    doc["status"] = "ok";
    doc["message"] = message;
    String body;
    serializeJson(doc, body);
    server.send(200, "application/json", body);
}

static void sendError(int code, const char* message) {
    JsonDocument doc;
    doc["status"] = "error";
    doc["message"] = message;
    String body;
    serializeJson(doc, body);
    server.send(code, "application/json", body);
}

// ── POST /animation/begin ────────────────────────────────────────────────────
// Body: {"meta":{...},"config":{...},"frame_count":N}  (~150 bytes)

static void handleAnimBegin() {
    if (server.method() != HTTP_POST) { sendError(405, "POST required"); return; }

    String payload = server.arg("plain");
    if (payload.length() == 0) { sendError(400, "empty body"); return; }

    // Reset any in-progress upload
    if (_pending.active) { _pending.anim.freeFrames(); _pending = {}; }

    JsonDocument doc;
    if (deserializeJson(doc, payload)) { sendError(400, "invalid JSON"); return; }

    uint16_t frameCount = doc["frame_count"] | (uint16_t)0;
    if (frameCount == 0 || frameCount > MAX_FRAMES) {
        sendError(400, "frame_count missing or out of range");
        return;
    }

    _pending.anim = Animation{};
    strlcpy(_pending.anim.meta.name,
            doc["meta"]["name"] | "untitled", sizeof(_pending.anim.meta.name));
    strlcpy(_pending.anim.meta.createdAt,
            doc["meta"]["created_at"] | "", sizeof(_pending.anim.meta.createdAt));
    _pending.anim.config.width      = doc["config"]["width"]      | (uint16_t)0;
    _pending.anim.config.height     = doc["config"]["height"]     | (uint16_t)0;
    _pending.anim.config.fps        = doc["config"]["fps"]        | (uint8_t)10;
    _pending.anim.config.loop       = doc["config"]["loop"]       | true;
    _pending.anim.config.brightness = doc["config"]["brightness"] | 1.0f;

    if (_pending.anim.config.width == 0 || _pending.anim.config.height == 0) {
        sendError(400, "invalid config dimensions"); return;
    }

    uint32_t pxPerFrame = (uint32_t)_pending.anim.config.width * _pending.anim.config.height;
    if (pxPerFrame > MAX_PIXELS) { sendError(400, "pixel count exceeds MAX_PIXELS"); return; }

    uint32_t frameSz    = pxPerFrame * 3;
    uint32_t totalBytes = frameSz * frameCount;

    // Soft pre-check: reject early when memory is clearly insufficient.
    // On PSRAM boards (XIAO ESP32-S3) frames go to ps_malloc (PSRAM), so check
    // PSRAM free space with a tiny reserve.  On non-PSRAM boards check internal
    // heap with a 25 KB reserve (largest transient: ~18 KB frame JSON String).
    uint32_t freeForFrames;
    uint32_t HEAP_RESERVE;
    if (psramFound()) {
        freeForFrames = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
        HEAP_RESERVE  = 1024;   // PSRAM is not used by WiFi/HTTP buffers
    } else {
        freeForFrames = esp_get_free_heap_size();
        HEAP_RESERVE  = 25000;  // 25 KB for frame JSON String + WiFi jitter
    }
    if (totalBytes + HEAP_RESERVE > freeForFrames) {
        uint16_t maxF = (freeForFrames > HEAP_RESERVE)
                      ? (uint16_t)((freeForFrames - HEAP_RESERVE) / frameSz) : 0;
        char msg[96];
        snprintf(msg, sizeof(msg),
                 "insufficient memory: need %lu B total, max %u frames at %ux%u",
                 (unsigned long)totalBytes, maxF,
                 _pending.anim.config.width, _pending.anim.config.height);
        Serial.printf("[http] begin pre-check: %s (free: %u psram: %u)\n",
                      msg, (unsigned)esp_get_free_heap_size(),
                      (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        sendError(507, msg);
        return;
    }

    // Allocate the pointer array (tiny: frameCount × 4 bytes).
    _pending.anim.framePtrs = (uint8_t**)malloc(frameCount * sizeof(uint8_t*));
    if (!_pending.anim.framePtrs) {
        sendError(507, "malloc failed for frame pointer array");
        return;
    }
    memset(_pending.anim.framePtrs, 0, frameCount * sizeof(uint8_t*));

    // Allocate each frame via ps_malloc — goes to PSRAM on S3 (8 MB), falls
    // back to internal SRAM on boards without PSRAM.
    for (uint16_t i = 0; i < frameCount; ++i) {
        _pending.anim.framePtrs[i] = (uint8_t*)ps_malloc(frameSz);
        if (!_pending.anim.framePtrs[i]) {
            for (uint16_t j = 0; j < i; ++j) free(_pending.anim.framePtrs[j]);
            free(_pending.anim.framePtrs);
            _pending.anim.framePtrs = nullptr;
            char msg[80];
            snprintf(msg, sizeof(msg),
                     "ps_malloc failed at frame %u/%u",
                     (unsigned)i, (unsigned)frameCount);
            Serial.printf("[http] begin alloc: %s (psram: %u heap: %u)\n",
                          msg,
                          (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                          (unsigned)esp_get_free_heap_size());
            sendError(507, msg);
            return;
        }
    }

    _pending.anim.pixelsPerFrame = pxPerFrame;
    _pending.expectedFrames = frameCount;
    _pending.receivedFrames = 0;
    _pending.active = true;

    Serial.printf("[http] anim begin: %ux%u %u frames, %lu B total, heap: %u\n",
                  _pending.anim.config.width, _pending.anim.config.height,
                  frameCount, (unsigned long)totalBytes,
                  (unsigned)esp_get_free_heap_size());
    sendOk("animation begin accepted");
}

// ── POST /animation/frame ────────────────────────────────────────────────────
// Body: [[R,G,B],[R,G,B],...] — ONE frame, compact JSON (no whitespace), ~22 KB
// for 32x48.  WebServer peak RAM: ~44 KB + WiFi ~80 KB = ~124 KB. Fits easily.

static void handleAnimFrame() {
    if (server.method() != HTTP_POST) { sendError(405, "POST required"); return; }
    if (!_pending.active) { sendError(400, "call /animation/begin first"); return; }
    if (_pending.receivedFrames >= _pending.expectedFrames) {
        sendError(400, "all frames already received"); return;
    }

    String payload = server.arg("plain");
    if (payload.length() == 0) { sendError(400, "empty frame body"); return; }

    uint8_t* dest = _pending.anim.framePtrs[_pending.receivedFrames];

    if (!parseAnimationFrameJson(payload.c_str(), dest, _pending.anim.pixelsPerFrame)) {
        sendError(400, "frame pixel parse failed");
        return;
    }

    _pending.receivedFrames++;

    JsonDocument resp;
    resp["status"]          = "ok";
    resp["frames_received"] = _pending.receivedFrames;
    resp["frames_expected"] = _pending.expectedFrames;
    String body; serializeJson(resp, body);
    server.send(200, "application/json", body);
}

// ── POST /animation/commit ───────────────────────────────────────────────────

static void handleAnimCommit() {
    if (!_pending.active) { sendError(400, "no pending animation"); return; }
    if (_pending.receivedFrames != _pending.expectedFrames) {
        sendError(400, "frame count mismatch — abort and retry");
        return;
    }

    _pending.anim.frameCount = _pending.receivedFrames;

    if (!_engine->loadAnimation(_pending.anim)) {
        _pending.anim.freeFrames();
        _pending = {};
        sendError(400, "animation rejected by engine");
        return;
    }

    _pending = {};   // engine now owns frameData
    Serial.printf("[http] animation committed, heap: %u\n", (unsigned)esp_get_free_heap_size());
    sendOk("animation loaded");
}

// ── POST /animation/abort ────────────────────────────────────────────────────

static void handleAnimAbort() {
    if (_pending.active) { _pending.anim.freeFrames(); _pending = {}; }
    sendOk("pending animation cleared");
}

// ── POST /animation ─────────────────────────────────────────────────────────

static void handleAnimation() {
    if (server.method() != HTTP_POST) {
        sendError(405, "POST required");
        return;
    }
    String payload = server.arg("plain");
    if (payload.length() == 0) {
        sendError(400, "empty body");
        return;
    }

    Animation anim;
    if (!parseAnimationJson(payload.c_str(), anim)) {
        sendError(400, "invalid animation JSON");
        return;
    }
    if (!_engine->loadAnimation(anim)) {
        sendError(400, "animation rejected by engine");
        return;
    }
    sendOk("animation loaded");
}

// ── POST /play ──────────────────────────────────────────────────────

static void handlePlay() {
    _engine->play();
    sendOk("playing");
}

// ── POST /pause ─────────────────────────────────────────────────────

static void handlePause() {
    _engine->pause();
    sendOk("paused");
}

// ── POST /stop ──────────────────────────────────────────────────────

static void handleStop() {
    _engine->stop();
    sendOk("stopped");
}

// ── POST /clear ─────────────────────────────────────────────────────

static void handleClear() {
    _engine->clearDisplay();
    sendOk("display cleared");
}

// ── POST /brightness ────────────────────────────────────────────────

static void handleBrightness() {
    if (server.method() != HTTP_POST) {
        sendError(405, "POST required");
        return;
    }
    String payload = server.arg("plain");
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (err) {
        sendError(400, "invalid JSON");
        return;
    }
    if (!doc["value"].is<float>() && !doc["value"].is<int>()) {
        sendError(400, "missing 'value' (0.0–1.0)");
        return;
    }
    float val = doc["value"].as<float>();
    if (val < 0.0f || val > 1.0f) {
        sendError(400, "'value' must be 0.0–1.0");
        return;
    }
    _engine->setBrightness(val);
    sendOk("brightness set");
}

// ── POST /profile ───────────────────────────────────────────────────

static void handleProfile() {
    if (server.method() != HTTP_POST) {
        sendError(405, "POST required");
        return;
    }
    String payload = server.arg("plain");
    if (payload.length() == 0) {
        sendError(400, "empty body");
        return;
    }

    HardwareProfile profile;
    if (!parseProfileJson(payload.c_str(), profile)) {
        sendError(400, "invalid profile JSON");
        return;
    }
    _engine->setProfile(profile);
    sendOk("profile applied");
}

// ── GET /status ─────────────────────────────────────────────────────

static void handleStatus() {
    JsonDocument doc;
    doc["status"] = "ok";

    const char* stateStr = "idle";
    switch (_engine->getState()) {
        case PlaybackState::PLAYING: stateStr = "playing"; break;
        case PlaybackState::PAUSED:  stateStr = "paused";  break;
        case PlaybackState::STOPPED: stateStr = "stopped"; break;
        default: break;
    }

    JsonObject data = doc["data"].to<JsonObject>();
    data["state"]          = stateStr;
    data["frame_index"]    = _engine->getCurrentFrame();
    data["animation_name"] = _engine->getAnimationName();
    data["profile_name"]   = _engine->getProfileName();

    String body;
    serializeJson(doc, body);
    server.send(200, "application/json", body);
}

// ── GET /caps ────────────────────────────────────────────────────────
// Reports device memory capacity so the app can compute a safe maxGifFrames
// dynamically without relying on a hardcoded constant.
// Response: {"max_frames":N,"width":W,"height":H,"free_heap":X,"largest_block":Y}

static void handleCaps() {
    uint32_t pxPerFrame = (uint32_t)DEFAULT_WIDTH * DEFAULT_HEIGHT;
    uint32_t frameSz    = pxPerFrame * 3;

    uint32_t freeHeap     = (uint32_t)esp_get_free_heap_size();
    uint32_t largestBlock = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);

    // PSRAM boards: frames live in PSRAM — use its free space with tiny reserve.
    // Non-PSRAM: use internal heap with 25 KB reserve for WebServer buffers.
    uint32_t freeForFrames;
    uint32_t HEAP_RESERVE;
    if (psramFound()) {
        freeForFrames = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
        HEAP_RESERVE  = 1024;
    } else {
        freeForFrames = freeHeap;
        HEAP_RESERVE  = 25000;
    }
    uint16_t maxFrames = (freeForFrames > HEAP_RESERVE && frameSz > 0)
                       ? (uint16_t)((freeForFrames - HEAP_RESERVE) / frameSz)
                       : 0;
    if (maxFrames > MAX_FRAMES) maxFrames = MAX_FRAMES;

    JsonDocument doc;
    doc["max_frames"]    = maxFrames;
    doc["width"]         = DEFAULT_WIDTH;
    doc["height"]        = DEFAULT_HEIGHT;
    doc["free_heap"]     = freeHeap;
    doc["largest_block"] = largestBlock;
    doc["psram_found"]   = (bool)psramFound();
    doc["free_psram"]    = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);

    String body;
    serializeJson(doc, body);
    server.send(200, "application/json", body);

    Serial.printf("[http] /caps: max_frames=%u free_heap=%u psram=%u\n",
                  maxFrames, freeHeap,
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

// ── GET /heap ────────────────────────────────────────────────────────
// Quick diagnostic: reports free heap and largest free block.
// Hit http://<ip>/heap in a browser to check memory at any time.

static void handleHeap() {
    uint32_t freeHeap     = (uint32_t)esp_get_free_heap_size();
    uint32_t largestBlock = (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);

    JsonDocument doc;
    doc["free_heap"]     = freeHeap;
    doc["largest_block"] = largestBlock;
    doc["free_kb"]       = freeHeap / 1024;

    String body;
    serializeJson(doc, body);
    server.send(200, "application/json", body);
    Serial.printf("[http] /heap: free=%u (%u KB) largest=%u\n",
                  freeHeap, freeHeap / 1024, largestBlock);
}

// ── 404 ─────────────────────────────────────────────────────────────
// ESP32 WebServer sometimes does not dispatch GET "/" to server.on("/", …).
// Fall back to the same JSON root response for empty or /index.html paths.

static void handleNotFound() {
    const HTTPMethod method = server.method();
    const String     uri    = server.uri();

    if (method == HTTP_GET || method == HTTP_HEAD) {
        const bool rootish =
            (uri == "/" || uri.isEmpty() || uri == "/index.html" || uri == "/setup");
        if (rootish) {
            if (method == HTTP_HEAD) {
                server.send(200, "application/json", "");
                return;
            }
            handleRoot();
            return;
        }
    }

    sendError(404, "not found");
}

// ── GET / ───────────────────────────────────────────────────────────

static void handleRoot() {
    if (server.method() != HTTP_GET) {
        sendError(405, "GET required");
        return;
    }
    server.send(200, "application/json",
                "{\"device\":\"led-poster\",\"hint\":\"POST JSON to endpoints; "
                "see protocol docs.\"}");
}

// ── Public API ──────────────────────────────────────────────────────

void httpServerBegin(AnimationEngine& engine) {
    _engine = &engine;
    connectWiFi();

    server.on("/",           HTTP_GET,  handleRoot);
    server.on("/setup",     HTTP_GET,  handleRoot);
    server.on("/animation/begin",  HTTP_POST, handleAnimBegin);
    server.on("/animation/frame",  HTTP_POST, handleAnimFrame);
    server.on("/animation/commit", HTTP_POST, handleAnimCommit);
    server.on("/animation/abort",  HTTP_POST, handleAnimAbort);
    server.on("/animation",  handleAnimation);
    server.on("/play",       handlePlay);
    server.on("/pause",      handlePause);
    server.on("/stop",       handleStop);
    server.on("/clear",      handleClear);
    server.on("/brightness", handleBrightness);
    server.on("/profile",    handleProfile);
    server.on("/status",     HTTP_GET,  handleStatus);
    server.on("/caps",       HTTP_GET,  handleCaps);
    server.on("/heap",       HTTP_GET,  handleHeap);
    server.onNotFound(handleNotFound);

    server.begin();

    Serial.printf("[http] server on port %u — http://%s\n",
                  HTTP_PORT, WiFi.localIP().toString().c_str());
    printEspBaseUrlBanner();
}

void httpServerLoop() {
    server.handleClient();
}
