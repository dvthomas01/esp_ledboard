#pragma once

#include <cstdlib>
#include <stdint.h>

enum class PlaybackState : uint8_t {
    IDLE,
    PLAYING,
    PAUSED,
    STOPPED
};

struct AnimationMeta {
    char name[64]       = "";
    char createdAt[32]  = "";
    char author[64]     = "";
};

struct AnimationConfig {
    uint16_t width      = 0;
    uint16_t height     = 0;
    uint8_t  fps        = 10;
    bool     loop       = true;
    float    brightness  = 1.0f;
};

struct Animation {
    AnimationMeta   meta;
    AnimationConfig config;

    // Frame storage: one heap-allocated buffer per frame.
    // framePtrs[i] points to (pixelsPerFrame * 3) bytes — R, G, B per pixel.
    // Using per-frame allocations instead of one giant contiguous block lets the
    // allocator satisfy requests from scattered heap gaps, eliminating OOM
    // failures caused by fragmentation after WiFi/HTTP activity.
    uint8_t** framePtrs    = nullptr;  // malloc'd array of frameCount pointers
    uint16_t  frameCount   = 0;
    uint32_t  pixelsPerFrame = 0;

    uint32_t frameSizeBytes() const { return pixelsPerFrame * 3; }

    void freeFrames() {
        if (framePtrs) {
            for (uint16_t i = 0; i < frameCount; ++i) {
                if (framePtrs[i]) { free(framePtrs[i]); framePtrs[i] = nullptr; }
            }
            free(framePtrs);
            framePtrs = nullptr;
        }
        frameCount = 0;
    }
};
