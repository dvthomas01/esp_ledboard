#include "hardware_profile.h"
#include <string.h>

Origin parseOrigin(const char* str) {
    if (strcmp(str, "top_right") == 0)    return Origin::TOP_RIGHT;
    if (strcmp(str, "bottom_left") == 0)  return Origin::BOTTOM_LEFT;
    if (strcmp(str, "bottom_right") == 0) return Origin::BOTTOM_RIGHT;
    return Origin::TOP_LEFT;
}

ColorOrder parseColorOrder(const char* str) {
    if (strcmp(str, "RGB") == 0) return ColorOrder::RGB;
    if (strcmp(str, "BRG") == 0) return ColorOrder::BRG;
    if (strcmp(str, "RBG") == 0) return ColorOrder::RBG;
    return ColorOrder::GRB;
}

LedType parseLedType(const char* str) {
    if (strcmp(str, "SK6812") == 0) return LedType::SK6812;
    return LedType::WS2812B;
}
