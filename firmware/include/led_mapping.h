#pragma once

#include <stdint.h>
#include "hardware_profile.h"

// Converts a logical pixel index (row-major, top-left origin)
// into a physical LED strip index, applying the active profile's
// origin, rotation, and serpentine wiring (single-strip builds only).
uint32_t logicalToPhysical(uint32_t logicalIndex, const HardwareProfile& profile);

/** True when profile uses two LED strips (gpio_pin_secondary set). */
bool profileUsesDualStrip(const HardwareProfile& profile);

/**
 * Dual-strip layout: left GPIO = x ∈ [0, width/2), right GPIO = rest.
 * Physical origin bottom-left within the matrix; strips use vertical-serpentine
 * per half-column (even y bottom→up left-to-right, odd y mirrored horizontally).
 */
struct PhysicalLedTarget {
    uint8_t strip;     // 0 = gpio_pin, 1 = gpio_pin_secondary
    uint16_t index;    // 0 .. (width/2)*height - 1
};
PhysicalLedTarget logicalToDualStrip(uint32_t logicalIndex, const HardwareProfile& profile);
