#include "animation_engine.h"
#include "led_mapping.h"
#include "config.h"
#include <FastLED.h>
#include <Arduino.h>
#include <math.h>

// ---------------------------------------------------------------------------
// Gamma LUT — sRGB → linear (Fix A)
// ---------------------------------------------------------------------------
// Converts each sRGB byte value (as sent by the app) to the linear equivalent
// that the LED must emit to produce the same perceived brightness as the screen.
// Formula: linear = round(255 * (srgb / 255) ^ 2.2)
// Built once at startup in begin(); 256 bytes of SRAM, zero runtime cost.
static uint8_t sGammaLut[256];

static void buildGammaLut() {
    // Gamma 2.0 (vs. pure sRGB 2.2): preserves mid-range and dark-channel values
    // better, preventing G/B from being crushed in earth tones and mixed colours.
    // Pure 2.2 caused brown to appear orange and skin tones to appear purple because
    // the lower G and B channels collapsed disproportionately.
    sGammaLut[0] = 0;
    for (int i = 1; i < 255; i++) {
        sGammaLut[i] = static_cast<uint8_t>(roundf(255.0f * powf(i / 255.0f, 2.0f)));
    }
    sGammaLut[255] = 255;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

void AnimationEngine::begin(const HardwareProfile& profile) {
    buildGammaLut();
    _profile = profile;
    reinitStrip();
    Serial.println("[engine] initialized");
}

void AnimationEngine::reinitStrip() {
    _dual = (_profile.gpioPinSecondary != static_cast<uint8_t>(255));

    const uint32_t totalPx  = (uint32_t)_profile.width * _profile.height;
    const uint32_t perStrip = _dual ? totalPx / 2 : totalPx;

    if (!_fastLedInitialized) {
        // FastLED pin numbers are compile-time template parameters.
        // FASTLED_STRIP0_PIN / FASTLED_STRIP1_PIN are defined in config.h and
        // must match FASTLED_STRIP0_PIN=25, FASTLED_STRIP1_PIN=26.
        FastLED.addLeds<WS2812B, FASTLED_STRIP0_PIN, GRB>(_leds0, perStrip);
        if (_dual) {
            FastLED.addLeds<WS2812B, FASTLED_STRIP1_PIN, GRB>(_leds1, perStrip);
        }
        // No per-channel colour correction: TypicalLEDStrip (G×69%, B×94%) was
        // over-attenuating green and causing purple casts in skin tones and warm
        // colours. The gamma LUT alone corrects the sRGB→linear mismatch; these
        // BTF WS2812B LEDs do not need the additional G attenuation.
        FastLED.setCorrection(UncorrectedColor);

        _fastLedInitialized = true;
        Serial.printf("[engine] FastLED registered: %u LEDs on pin %u",
                      perStrip, FASTLED_STRIP0_PIN);
        if (_dual) {
            Serial.printf(" + %u LEDs on pin %u", perStrip, FASTLED_STRIP1_PIN);
        }
        Serial.println();
    } else {
        // Profile changed after initial setup — update the LED counts in the
        // already-registered controllers without re-adding them.
        FastLED[0].setLeds(_leds0, perStrip);
        if (_dual && FastLED.count() >= 2) {
            FastLED[1].setLeds(_leds1, perStrip);
        }
    }

    _pixelsPerStrip0 = perStrip;
    _pixelsPerStrip1 = _dual ? perStrip : 0;

    float effective = _runtimeBrightness * _profile.maxBrightness;
    FastLED.setBrightness(static_cast<uint8_t>(effective * 255.0f));
    FastLED.clearData();
    FastLED.show();
}

// ---------------------------------------------------------------------------
// Firmware API
// ---------------------------------------------------------------------------

bool AnimationEngine::loadAnimation(const Animation& anim) {
    if (anim.config.width == 0 || anim.config.height == 0) {
        Serial.println("[engine] error: invalid dimensions");
        return false;
    }
    if (anim.config.width != _profile.width || anim.config.height != _profile.height) {
        Serial.printf("[engine] error: animation size %ux%u does not match profile %ux%u\n",
                      anim.config.width, anim.config.height,
                      _profile.width,   _profile.height);
        return false;
    }
    if (anim.frameCount == 0 || anim.framePtrs == nullptr) {
        Serial.println("[engine] error: no frames");
        return false;
    }
    uint32_t expectedPixels = (uint32_t)anim.config.width * anim.config.height;
    if (anim.pixelsPerFrame != expectedPixels) {
        Serial.printf("[engine] error: pixel count mismatch (got %u, expected %u)\n",
                      anim.pixelsPerFrame, expectedPixels);
        return false;
    }
    if (anim.config.fps < MIN_FPS || anim.config.fps > MAX_FPS) {
        Serial.printf("[engine] error: fps %u out of range [%u\u2013%u]\n",
                      anim.config.fps, MIN_FPS, MAX_FPS);
        return false;
    }

    _animation.freeFrames();
    _animation = anim;
    _state = PlaybackState::STOPPED;
    _currentFrame = 0;
    Serial.printf("[engine] loaded \"%s\" (%u frames, %ux%u, %u fps)\n",
                  _animation.meta.name,
                  _animation.frameCount,
                  _animation.config.width,
                  _animation.config.height,
                  _animation.config.fps);
    return true;
}

void AnimationEngine::play() {
    if (_animation.frameCount == 0) return;
    _state = PlaybackState::PLAYING;
    _lastFrameTime = millis();
    Serial.println("[engine] play");
}

void AnimationEngine::pause() {
    if (_state == PlaybackState::PLAYING) {
        _state = PlaybackState::PAUSED;
        Serial.println("[engine] paused");
    }
}

void AnimationEngine::stop() {
    _state = PlaybackState::STOPPED;
    _currentFrame = 0;
    clearDisplay();
    Serial.println("[engine] stopped");
}

void AnimationEngine::clearDisplay() {
    if (!_fastLedInitialized) return;
    fill_solid(_leds0, _pixelsPerStrip0, CRGB::Black);
    if (_dual) fill_solid(_leds1, _pixelsPerStrip1, CRGB::Black);
    FastLED.show();
}

void AnimationEngine::setBrightness(float value) {
    _runtimeBrightness = constrain(value, 0.0f, 1.0f);
    float effective = _runtimeBrightness * _profile.maxBrightness;
    FastLED.setBrightness(static_cast<uint8_t>(effective * 255.0f));
    if (_state == PlaybackState::PAUSED || _state == PlaybackState::PLAYING) {
        renderFrame(_currentFrame);
    }
    Serial.printf("[engine] brightness %.2f\n", _runtimeBrightness);
}

void AnimationEngine::setProfile(const HardwareProfile& profile) {
    bool needsReinit =
        (profile.gpioPin           != _profile.gpioPin           ||
         profile.gpioPinSecondary  != _profile.gpioPinSecondary  ||
         profile.ledType           != _profile.ledType           ||
         profile.pixelCount()      != _profile.pixelCount()      ||
         profile.maxBrightness     != _profile.maxBrightness);
    _profile = profile;
    if (needsReinit) {
        reinitStrip();
        Serial.println("[engine] strip reinitialized for new profile");
    }
    Serial.printf("[engine] profile set: \"%s\" (%ux%u)\n",
                  _profile.profileName, _profile.width, _profile.height);
}

// ---------------------------------------------------------------------------
// Non-blocking tick
// ---------------------------------------------------------------------------

void AnimationEngine::tick() {
    if (_state != PlaybackState::PLAYING) return;
    if (_animation.frameCount == 0) return;

    unsigned long now      = millis();
    unsigned long interval = 1000UL / _animation.config.fps;
    if (now - _lastFrameTime < interval) return;

    _lastFrameTime = now;
    renderFrame(_currentFrame);

    _currentFrame++;
    if (_currentFrame >= _animation.frameCount) {
        if (_animation.config.loop) {
            _currentFrame = 0;
        } else {
            _state = PlaybackState::STOPPED;
            Serial.println("[engine] playback finished");
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

void AnimationEngine::renderFrame(uint16_t frameIndex) {
    if (!_fastLedInitialized || !_animation.framePtrs) return;
    if (frameIndex >= _animation.frameCount) return;

    const uint8_t* frame     = _animation.framePtrs[frameIndex];
    const float    animBright = _animation.config.brightness;

    for (uint32_t i = 0; i < _animation.pixelsPerFrame; i++) {
        // Apply per-animation brightness first (linear multiply), then gamma-encode
        // so the LED's linear light output matches the sRGB screen preview (Fix A).
        uint8_t r = sGammaLut[static_cast<uint8_t>(frame[i * 3]     * animBright)];
        uint8_t g = sGammaLut[static_cast<uint8_t>(frame[i * 3 + 1] * animBright)];
        uint8_t b = sGammaLut[static_cast<uint8_t>(frame[i * 3 + 2] * animBright)];

        if (_dual) {
            PhysicalLedTarget t = logicalToDualStrip(i, _profile);
            if (t.strip == 0) {
                _leds0[t.index] = CRGB(r, g, b);
            } else {
                _leds1[t.index] = CRGB(r, g, b);
            }
        } else {
            _leds0[logicalToPhysical(i, _profile)] = CRGB(r, g, b);
        }
    }

    FastLED.show();
}

// ---------------------------------------------------------------------------
// Status accessors
// ---------------------------------------------------------------------------

const char* AnimationEngine::getAnimationName() const {
    return (_animation.frameCount > 0) ? _animation.meta.name : nullptr;
}

const char* AnimationEngine::getProfileName() const {
    return _profile.profileName;
}
