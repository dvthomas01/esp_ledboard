# LED Poster — ESP32 firmware

This project is built with **PlatformIO** (Arduino framework), not the Arduino IDE sketch workflow. You run **build**, **upload**, and **serial monitor** from a **terminal**.

## Board target

Default board: **Seeed XIAO ESP32-S3** (`board = seeed_xiao_esp32s3` in `platformio.ini`). **D0 → GPIO 1** (left half / strip 0), **D1 → GPIO 2** (right half / strip 1); see `include/config.h` and `FASTLED_STRIP*_PIN`.

The default logical grid is **32×48** (1,536 LEDs), split across two WS2812-class strands (**768 LEDs each**) with firmware mapping in `src/led_mapping.cpp`.

If you change wiring or dimensions, update `config.h` (and remapping logic) as needed and recompile.

## Wi‑Fi credentials (local file only — not in Git)

Firmware expects **`include/wifi_config.h`**, which **must not be committed**. It is listed in the repo-root `.gitignore`.

1. Create **`firmware/include/wifi_config.h`** (same directory as other headers).

2. Use this template — replace placeholders with your network values. Keep **`YOUR_WIFI_SSID`** until both SSID and password are set correctly; firmware refuses to boot Wi‑Fi if the SSID is still the sentinel `YOUR_WIFI_SSID` (`http_server.cpp`).

```cpp
#pragma once

constexpr const char* WIFI_SSID     = "YOUR_WIFI_SSID";
constexpr const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

constexpr uint16_t HTTP_PORT = 80;

// Optional: dual-band routers — set true and paste the 2.4 GHz BSSID from your router UI.
constexpr bool WIFI_LOCK_BSSID = false;
constexpr uint8_t WIFI_STA_BSSID[6] = { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 };
```

3. After editing, build and flash. To change networks later, edit this file again and **reflash**.

**Security note:** Anyone on your LAN who can reach the ESP’s HTTP port can drive playback and uploads unless you isolate the device ( VLAN / firewall ). There is no API token in stock firmware.

## Where you run things

| Step              | Where    | Command |
|-------------------|---------|---------|
| Install PlatformIO| Terminal| `brew install platformio` (or see below) |
| Build + flash     | `firmware/`, USB cable | `pio run -t upload` |
| Serial log        | `firmware/` | `pio device monitor -b 115200` |

You do **not** need Sketch → Upload in the Arduino IDE for this repo.

## One-time: install PlatformIO Core

### macOS (recommended): Homebrew

```bash
brew install platformio
pio --version
```

Other options: `pipx install platformio` or a Python venv with `pip install platformio`.

## Flash and serial monitor

1. Connect the board over USB.

2. From the **`firmware`** directory:

```bash
pio run -t upload
pio device monitor -b 115200
```

You should see boot logs and, after Wi‑Fi connects, an **ESP BASE URL** banner (paste that into the app Settings).

Press `Ctrl+C` to exit the monitor.

Paths are relative — use `cd firmware` from your clone root instead of hardcoded machine paths.

## Helper scripts

```bash
cd firmware
chmod +x scripts/upload.sh scripts/monitor.sh   # once
./scripts/upload.sh
./scripts/monitor.sh
```

## If upload fails

- **Port:** `pio device list` then e.g. `pio run -t upload --upload-port /dev/cu.usbmodem*`
- **Board mismatch:** Confirm `platformio.ini` matches your chip (here: **ESP32-S3**).
- **Linux:** you may need `dialout` group membership.

## GPIO reminder

FastLED pins are **compile-time** constants in **`include/config.h`** (`FASTLED_STRIP0_PIN`, `FASTLED_STRIP1_PIN`). For a single physical strip profile-only paths may set `gpio_pin_secondary` to `255`; template code on the MCU still uses the pinned GPIO definitions unless you change them and remap.
