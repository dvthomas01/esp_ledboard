#pragma once

#include "animation.h"
#include "hardware_profile.h"
#include "config.h"
#include <FastLED.h>

class AnimationEngine {
public:
    void begin(const HardwareProfile& profile);

    bool loadAnimation(const Animation& anim);
    void play();
    void pause();
    void stop();
    void clearDisplay();
    void setBrightness(float value);
    void setProfile(const HardwareProfile& profile);

    void tick();

    // Status
    PlaybackState   getState() const       { return _state; }
    uint16_t        getCurrentFrame() const { return _currentFrame; }
    const char*     getAnimationName() const;
    const char*     getProfileName() const;

private:
    void renderFrame(uint16_t frameIndex);
    void reinitStrip();

    HardwareProfile _profile;
    Animation       _animation;
    PlaybackState   _state         = PlaybackState::IDLE;
    uint16_t        _currentFrame  = 0;
    unsigned long   _lastFrameTime = 0;
    float           _runtimeBrightness = 1.0f;

    // FastLED LED buffers — sized for the maximum possible pixels per strip.
    // Both arrays are always allocated; only _leds1 is used when dual-strip is active.
    CRGB _leds0[MAX_LEDS_PER_STRIP];
    CRGB _leds1[MAX_LEDS_PER_STRIP];

    // Tracks whether FastLED.addLeds() has been called (it must only be called once).
    bool     _fastLedInitialized = false;
    bool     _dual               = false;
    uint32_t _pixelsPerStrip0    = 0;
    uint32_t _pixelsPerStrip1    = 0;
};
