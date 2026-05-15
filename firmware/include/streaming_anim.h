#pragma once
#include "animation_engine.h"

/**
 * Streaming animation upload server (port 8081).
 *
 * The ESP32 WebServer (port 80) buffers the entire POST body into a String
 * before calling any handler.  For a 4-frame 32×48 animation the pretty-
 * printed JSON is ~300 KB — far beyond the ~220 KB of free heap with Wi-Fi
 * active.  This secondary server reads and parses the animation JSON directly
 * from the TCP socket in a single pass, keeping peak extra memory < 20 KB
 * regardless of animation size.
 *
 * Usage (main.cpp):
 *   setup()  → streamingAnimServerBegin(engine);
 *   loop()   → streamingAnimServerLoop();
 *
 * App (api.ts) must POST animations to  http://<IP>:8081/animation
 * (all other commands stay on port 80).
 */
void streamingAnimServerBegin(AnimationEngine& engine);
void streamingAnimServerLoop();
