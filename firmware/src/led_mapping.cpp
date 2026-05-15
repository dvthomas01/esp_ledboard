#include "led_mapping.h"

bool profileUsesDualStrip(const HardwareProfile& profile) {
    return profile.gpioPinSecondary != static_cast<uint8_t>(255);
}

PhysicalLedTarget logicalToDualStrip(uint32_t logicalIndex, const HardwareProfile& profile) {
    // ── Physical wiring (calibrated against hardware, 2026-04-28) ──────────
    //
    // Layout: 2 columns × 3 rows of 16×16 BTF WS2812B panels.
    //   Strip 0 (GPIO2) = left column  (logical x = 0..15)
    //   Strip 1 (GPIO3) = right column (logical x = 16..31)
    //
    // Panel order IN THE STRIP: bottom panel first.
    //   Strip indices 0..255   → physical bottom panel (display y = 32..47)
    //   Strip indices 256..511 → physical middle panel (display y = 16..31)
    //   Strip indices 512..767 → physical top panel    (display y =  0..15)
    //
    // Within each 16×16 panel: COLUMN-MAJOR vertical serpentine.
    //   Column 0 (c=0) = RIGHTMOST physical column (local x=15).
    //   Even column index c → traversed BOTTOM-TO-TOP   (pos 0 = panel bottom)
    //   Odd  column index c → traversed TOP-TO-BOTTOM   (pos 0 = panel top)
    //
    // Logical coordinate system (animation JSON / app): row-major, y=0 at top.
    // ────────────────────────────────────────────────────────────────────────

    PhysicalLedTarget t{};
    const uint16_t w = profile.width;
    const uint16_t h = profile.height;
    if (w < 2 || h == 0 || (w & 1) != 0) return t;

    const uint16_t PANEL = 16;                          // 16×16 panel
    const uint16_t half  = static_cast<uint16_t>(w / 2);   // columns per strip = 16
    const uint16_t panelsPerStrip = h / PANEL;          // = 3

    const uint16_t lx_raw = logicalIndex % w;
    const uint16_t ly     = logicalIndex / w;
    // Mirror horizontally: D0 is wired to the physically-right column,
    // D1 to the physically-left column, so flip x to compensate.
    const uint16_t lx = static_cast<uint16_t>((w - 1) - lx_raw);

    // ── Strip selection ───────────────────────────────────────────────────
    uint16_t x_local;
    if (lx < half) {
        t.strip = 0;
        x_local = lx;
    } else {
        t.strip = 1;
        x_local = static_cast<uint16_t>(lx - half);
    }

    // ── Panel identification ──────────────────────────────────────────────
    const uint16_t panel_from_top    = ly / PANEL;     // 0=top, 2=bottom in display
    const uint16_t y_within_panel    = ly % PANEL;     // 0=top of panel, 15=bottom
    const uint16_t panel_from_bottom = static_cast<uint16_t>(panelsPerStrip - 1) - panel_from_top;
    const uint32_t strip_panel_start = static_cast<uint32_t>(panel_from_bottom) * PANEL * half;

    // ── Column-major index within the panel ──────────────────────────────
    // c = 0 → leftmost column (outer edge, x_local=0); c increases going right.
    const uint16_t c = x_local;

    uint16_t pos_in_col;
    if ((c & 1) == 0) {
        // Even column: bottom-to-top; pos 0 = physical bottom of panel (y_within=15)
        pos_in_col = static_cast<uint16_t>((PANEL - 1) - y_within_panel);
    } else {
        // Odd column: top-to-bottom; pos 0 = physical top of panel (y_within=0)
        pos_in_col = y_within_panel;
    }

    const uint32_t within_panel = static_cast<uint32_t>(c) * PANEL + pos_in_col;
    t.index = static_cast<uint16_t>(strip_panel_start + within_panel);
    return t;
}

// Transforms a logical pixel index (row-major, top-left origin from the
// animation frame buffer) into the physical LED strip index according to
// the hardware profile's origin, rotation, serpentine, and wiring direction.
//
// Pipeline:
//   1. Logical index → (lx, ly) in row-major top-left space
//   2. Apply rotation (0/90/180/270)
//   3. Apply origin flip
//   4. Apply serpentine (direction depends on column-major vs row-major wiring)
//   5. Compute physical strip index (column-major or row-major)

uint32_t logicalToPhysical(uint32_t logicalIndex, const HardwareProfile& profile) {
    const uint16_t w = profile.width;
    const uint16_t h = profile.height;
    if (w == 0 || h == 0) return 0;

    // Step 1: decompose logical index → (lx, ly), row-major top-left
    uint16_t lx = logicalIndex % w;
    uint16_t ly = logicalIndex / w;

    // Step 2: rotate
    uint16_t rx, ry;
    uint16_t pw, ph; // physical grid dimensions after rotation
    switch (profile.rotation) {
        case 90:
            rx = (h - 1) - ly;
            ry = lx;
            pw = h; ph = w;
            break;
        case 180:
            rx = (w - 1) - lx;
            ry = (h - 1) - ly;
            pw = w; ph = h;
            break;
        case 270:
            rx = ly;
            ry = (w - 1) - lx;
            pw = h; ph = w;
            break;
        default: // 0
            rx = lx;
            ry = ly;
            pw = w; ph = h;
            break;
    }

    // Step 3: origin flip
    uint16_t ox, oy;
    switch (profile.origin) {
        case Origin::TOP_RIGHT:
            ox = (pw - 1) - rx;
            oy = ry;
            break;
        case Origin::BOTTOM_LEFT:
            ox = rx;
            oy = (ph - 1) - ry;
            break;
        case Origin::BOTTOM_RIGHT:
            ox = (pw - 1) - rx;
            oy = (ph - 1) - ry;
            break;
        default: // TOP_LEFT
            ox = rx;
            oy = ry;
            break;
    }

    // Steps 4+5: serpentine + final index (depends on wiring direction)
    if (profile.columnMajor) {
        // Strips run vertically — each column is one continuous strip segment.
        // Physical index = column * column_height + row_within_column.
        // Serpentine: odd columns are wired bottom→top (reverse row).
        uint16_t row = oy;
        if (profile.serpentine && (ox % 2 != 0)) {
            row = (ph - 1) - oy;
        }
        return (uint32_t)ox * ph + row;
    } else {
        // Strips run horizontally — each row is one continuous strip segment.
        // Physical index = row * row_width + column_within_row.
        // Serpentine: odd rows are wired right→left (reverse column).
        uint16_t col = ox;
        if (profile.serpentine && (oy % 2 != 0)) {
            col = (pw - 1) - ox;
        }
        return (uint32_t)oy * pw + col;
    }
}
