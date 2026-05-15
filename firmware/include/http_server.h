#pragma once

#include "animation_engine.h"

// Connects to Wi-Fi (STA mode), starts the HTTP server, and prints the
// device IP to Serial.  Call once from setup().
void httpServerBegin(AnimationEngine& engine);

// Pumps the HTTP server.  Call every iteration from loop().
// Non-blocking — returns immediately if no pending client.
void httpServerLoop();
