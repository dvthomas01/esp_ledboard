# LED Poster (Expo)

Phase 1: connect to the ESP32 HTTP API on your LAN (same Wi‑Fi as the phone).

## Run

```bash
cd app
npm install
npm start
```

### iPhone: do **not** use the system Camera app

The QR code is for **Expo Go**, not Apple’s Camera. Scanning with the Camera app often shows **“No usable data”** — that’s expected.

1. Install **[Expo Go](https://apps.apple.com/app/expo-go/id982107779)** from the App Store.
2. Open **Expo Go** (not Camera).
3. Tap **Scan QR code** inside Expo Go and point at the terminal’s QR code.

**Or** copy the URL from the terminal (looks like `exp://192.168.x.x:8081`) → in Expo Go, choose **Enter URL manually** and paste it (same Wi‑Fi as your Mac).

### Same Wi‑Fi / tunnel

Your phone must reach Metro on your development machine:

- Typical: phone and PC on the **same Wi‑Fi** as each other.

If the QR / LAN URL fails:

```bash
npx expo start --tunnel
```

(Tunnel routes through Expo; slower but avoids strict LAN quirks; you may need an Expo account.)

### Expo Go ≠ laptop tether for poster control

- **Metro (laptop / dev PC)** is only for **opening or reloading** the JavaScript bundle in Expo Go.

- After the bundle has loaded once, controlling the ESP uses **Wi‑Fi on your LAN** (`http://<poster-ip>`). Neither Mac wired power nor USB to the microcontroller is involved in HTTP.

- Practical setup: poster on mains or battery; phone on mains or portable battery bank; phone and ESP on **the same SSID/router** — no laptop nearby.

- Caveat: if you force-quit Expo Go or tap **Reload**, Expo Go asks Metro again. Keep the session open until you plug in the dev PC.

## Configure

### ESP32 Wi‑Fi (firmware — not Git tracked)

Wi‑Fi is **compile-time STA only**: create **`firmware/include/wifi_config.h`** locally (ignored by `.gitignore`), using the **`firmware/README.md`** template (`WIFI_SSID`, `WIFI_PASSWORD`, optional BSSID lock, `HTTP_PORT`). Build and **`pio run -t upload`** over USB whenever you move networks—there is **no** soft‑AP / in-app onboarding in current firmware.

### Phone ↔ poster

1. Boot the firmware and read the ESP’s DHCP address from **`pio device monitor`** (**ESP BASE URL**) or from your router UI.
2. In the app, enter **ESP base URL**: e.g. `http://192.168.x.x` (no trailing slash; include port if firmware uses non‑80 **`HTTP_PORT`**).
3. Tap **Save URL**, then **Status** to verify.

### Before you make the repo public

- **Never commit** `firmware/include/wifi_config.h` (`git status` — it should appear untracked/ignored).
- Firmware HTTP is **unauthenticated** LAN control: isolate untrusted Wi‑Fi guests; treat the board like any IoT appliance on your broadcast domain.

## HTTP API

Matches **`firmware/src/http_server.cpp`**: includes **`GET /status`**, **`GET /caps`**, chunked **`/animation/begin`** / **`/animation/frame`** / **`/animation/commit`**, **`/play`**, **`/pause`**, **`/stop`**, **`/clear`**, **`/brightness`**, **`/profile`** (and **`/animation`** for small payloads, if enabled in firmware).

## Local HTTP on device

- **iOS**: `NSAllowsLocalNetworking` is set in `app.json` so `http://` to LAN IPs works.
- **Android**: `usesCleartextTraffic` is enabled for the same reason.
