#pragma once

#include "animation.h"
#include "hardware_profile.h"

// Parse animation JSON string into an Animation struct.
// Allocates framePtrs (one buffer per frame) on the heap — caller (or engine) owns the memory.
// Returns true on success; logs errors to Serial on failure.
bool parseAnimationJson(const char* json, Animation& out);

// Parse hardware profile JSON string into a HardwareProfile struct.
bool parseProfileJson(const char* json, HardwareProfile& out);

// Parse a single animation frame's pixel array from compact JSON.
// frameJson must be the raw pixel array: [[R,G,B],[R,G,B],...] (no outer wrapper).
// dest must point to a pre-allocated buffer of pixelsPerFrame * 3 bytes.
bool parseAnimationFrameJson(const char* frameJson, uint8_t* dest, uint32_t pixelsPerFrame);
