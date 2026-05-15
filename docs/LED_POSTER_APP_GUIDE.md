# LED Poster — Mobile App Design & Implementation Guide

This document explains how the **LED Poster** mobile app was designed and built to control an ESP32-driven addressable LED grid over Wi‑Fi. It is written so someone with basic React Native experience could reproduce the app given the same firmware contract.

**Scope:** Core app features only (control, preview, gallery, image/GIF import, settings). **LLM / voice generation** is noted at the end as an optional stretch goal—not required for the main product.

---

## 1. System context

### 1.1 Development order

The project follows **firmware first, then app**:

1. The ESP32 runs a stable firmware that parses **animation JSON**, maps logical pixels to physical strip order, and plays frames with **non-blocking** timing (`millis()`-based), not `delay()` for animation.
2. The phone app is a **thin client**: it creates or loads animation data, previews it, and sends HTTP requests to the ESP.

Without a working firmware API, the app cannot be validated on real hardware.

### 1.2 Transport and contract

- **v1 transport:** Wi‑Fi in **station (STA)** mode only. There is **no** in-repo soft‑AP captive portal or runtime `POST /wifi` provisioning—you set SSID/password in **`firmware/include/wifi_config.h`**, compile, and flash (see **`firmware/README.md`** template).  
- The ESP joins the same LAN as the phone when both use that network. The app talks to `http://<esp-ip>` (default port **80**, or whatever `HTTP_PORT` you set—the Settings base URL must include a non-default port when applicable).
- **Wire format:** JSON animations and REST-style endpoints match **`firmware/src/http_server.cpp`**. Large uploads use **chunked** `POST /animation/begin`, `/animation/frame`, `/animation/commit`. The canonical TS shape lives in **`app/lib/types.ts`**. JSON Schemas in a private **`schemas/`** folder (if you maintain them locally) mirror the contract but are optional for publication.

The app does **not** implement serpentine or rotation in its preview grid: it uses the same **logical row-major** frame layout as the firmware expects. Physical mapping is **only** on the ESP.

### 1.3 Display timing and LED protocol (firmware)

The LED grid’s **animation** timing and the **WS2812 wire protocol** are two different things; both matter for a complete picture.

#### Animation frame rate (what sets how fast frames change)

- **Not** a dedicated hardware “display frame clock.” Playback is **software-scheduled** in `AnimationEngine::tick()` (`firmware/src/animation_engine.cpp`).
- The firmware uses Arduino **`millis()`** (milliseconds since boot). For each pass through `loop()`, if state is **PLAYING**, it compares `millis()` to **`_lastFrameTime`**.
- **Target interval:** `interval = 1000 / fps` milliseconds (**integer** division). When `now - _lastFrameTime >= interval`, it advances the frame index, calls `renderFrame()`, updates `_lastFrameTime`, and pushes pixels with `show()`.
- **`fps`** comes from the loaded animation JSON **`config.fps`**, validated to **`MIN_FPS`–`MAX_FPS`** (1–60) in `firmware/include/config.h`.
- **`loop()`** also runs Wi‑Fi / HTTP handling; there is **no** guarantee `tick()` runs on a rigid schedule. In practice you get **“at least every interval ms”** between frames, with possible **jitter** if the CPU is busy. Animation does **not** use `delay()` in this path.

**Summary:** The **time domain** for frame changes is **discrete frames** on a **1 ms `millis()` grid**, with nominal period **`1000 / fps` ms** (e.g. 2 fps → 500 ms; 10 fps → 100 ms; 60 fps → 16 ms, not exactly 16.67 ms because of integer math).

#### LED strip bit timing (how colors are clocked out)

- NeoPixels are configured with **`NEO_KHZ800`** (800 kHz class timing) in the Adafruit NeoPixel constructor—this is the **one-wire serial protocol** for WS2812-class LEDs (per-bit timing on the data line), **not** the animation FPS.
- Each **`show()`** sends the full chain once. Transfer time scales with **pixel count** and is typically **well under a millisecond** for small grids, so **frame rate is almost always limited by `fps` + `tick()`**, not by `show()`.

#### App alignment

- The mobile **preview** (`LedGrid`) uses **`setInterval(1000 / fps)`** to approximate the same nominal frame period so preview and device behavior stay comparable (both follow the same **`config.fps`** and **`loop`** flag).

---

## 2. Why React Native (Expo)

| Decision | Rationale |
| -------- | --------- |
| **Expo (React Native)** | One codebase for **iOS and Android**; fast iteration with **Expo Go** during development. |
| **No native Swift/Kotlin app** | Keeps the project maintainable for a small team; networking is sufficient for v1. |
| **`fetch` for HTTP** | Matches the firmware’s simple REST API; no WebSocket in v1. |

---

## 3. Canonical animation format (app + ESP)

Every animation the app sends must match this mental model:

- **`version`:** `1`
- **`type`:** `"animation"`
- **`meta`:** `name`, `created_at` (ISO string), optional `author`
- **`config`:** `width`, `height`, `fps` (1–60), `loop`, `brightness` (0.0–1.0)
- **`frames`:** Array of frames. Each frame is a **flat** list of **`[R, G, B]`** triples (0–255), **row-major**: index 0 = top-left, advancing across rows then down.

Pixel count per frame = `width * height` triples.

The app’s **preview**, **gallery storage**, and **HTTP POST body** all use this structure so “what you see” matches “what the ESP plays” for layout and timing (FPS, loop).

---

## 4. Firmware HTTP API surface (what the app calls)

Firmware HTTP API (**`firmware/src/http_server.cpp`**). Animations upload **chunk‑wise** (`/animation/begin` → `/animation/frame` × N → `/animation/commit`) so the MCU never buffers a monster JSON body. A **`POST /animation`** path may still exist for tiny payloads depending on firmware.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/status` | Device / playback status |
| `GET` | `/caps` | Heap/PSRAM → safe `max_frames` (Import uses this) |
| `POST` | `/animation/begin` | Begin chunked animation upload |
| `POST` | `/animation/frame` | Upload one compact JSON frame |
| `POST` | `/animation/commit` | Finalize and load animation |
| `POST` | `/animation/abort` | Cancel in-progress chunked upload |
| `POST` | `/animation` | Full animation JSON body (small only) |
| `POST` | `/play` | Start / resume playback |
| `POST` | `/pause` | Pause |
| `POST` | `/stop` | Stop |
| `POST` | `/clear` | Clear LEDs |
| `POST` | `/brightness` | Body: `{ "value": 0.5 }` |
| `POST` | `/profile` | Body: hardware profile JSON (optional) |

The mobile client wraps URLs as: **`normalizeBaseUrl(storedUrl) + path`**, e.g. `http://192.168.0.240/status`.

---

## 5. Repository layout (`app/`)

```
app/
├── App.tsx                 # Root: SafeAreaView, header, tab state, Settings form
├── index.tsx               # Expo entry: registerRootComponent(App)
├── app.json                # Expo config (local HTTP permissions — see §10)
├── package.json
├── components/
│   └── LedGrid.tsx         # Pixel grid preview + interval-based frame advance
├── screens/
│   ├── ControlScreen.tsx   # Device control + JSON editor + samples + send
│   ├── PreviewScreen.tsx   # JSON → live preview + sample buttons
│   ├── GalleryScreen.tsx   # Saved animations list + send + delete
│   └── ImportScreen.tsx    # Photo library → frames → preview → send/save
└── lib/
    ├── api.ts              # HTTP helpers + URL normalize + fetch timeout
    ├── types.ts            # AnimationData, GalleryItem, parseAnimationData()
    ├── gallery.ts          # AsyncStorage CRUD for saved items
    ├── sampleAnimations.ts # Built-in demo animations (TypeScript objects → JSON)
    ├── sampleAnimation.ts  # Legacy string sample (heart)
    └── processorHtml.ts    # Inline HTML/JS for WebView pixel extraction (import)
```

**Design choice:** No React Navigation package in v1—**tab state** is a simple string union in `App.tsx` (`'control' | 'preview' | 'import' | 'gallery' | 'settings'`). Fewer dependencies and enough for five panes.

---

## 6. Core features and how they are implemented

### 6.1 Settings — ESP base URL

**Goal:** Persist the ESP’s LAN address between launches.

**Implementation:**

- **Storage key:** e.g. `esp_base_url` in **AsyncStorage** (`@react-native-async-storage/async-storage`).
- On launch, `App.tsx` reads AsyncStorage into `baseUrl` (used for network calls) and `urlDraft` (the `TextInput` value).
- **Save** writes `urlDraft` back to AsyncStorage and updates `baseUrl`.

**`lib/api.ts` — `normalizeBaseUrl`:**

- Trims whitespace, strips trailing slashes.
- If the user omits a scheme, prepend `http://` so `192.168.0.240` becomes `http://192.168.0.240`.

**Important UX detail:** Requests use **`baseUrl`**, not the draft field. If the user edits the text box but forgets **Save**, the app still uses the old URL.

**Robustness:** All `fetch` calls go through **`fetchWithTimeout`** (e.g. 12 seconds). React Native’s default `fetch` can hang a long time on unreachable LAN IPs; the timeout turns that into a clear error instead of an infinite spinner.

---

### 6.2 Control screen — device commands and sending animations

**Goal:** One place to drive the poster: status, transport controls, brightness, paste or load JSON, send to ESP, optionally save to gallery.

**Implementation (`ControlScreen.tsx`):**

- **State:** `animationJson` (string), `brightness`, `log`, `busy`.
- **`run(title, fn)` pattern:**  
  - If `normalizeBaseUrl(baseUrl)` is empty → log “set URL in Settings” and return.  
  - Set `busy = true`, `await fn()` where `fn` is one of the API helpers, append to `log`, `busy = false` in `finally`.
- **Buttons** call `getStatus`, `postEmpty` (`/play`, `/pause`, `/stop`, `/clear`), `postJson` (`/brightness`), `postAnimationJson` (`/animation` with **raw JSON string body**).
- **Sample animations:** `lib/sampleAnimations.ts` exports structured `AnimationData` objects; **`animationToJson()`** stringifies them into the text area. **Send** posts that string verbatim.

**Design choice:** **Send** and **Save to gallery** sit **above** the large JSON `TextInput` so users don’t scroll past controls to reach them.

**Gallery hook:** “Save to gallery” calls `addToGallery(animationJson)` which validates JSON via `parseAnimationData` before persisting.

---

### 6.3 Preview screen — match device behavior on the phone

**Goal:** Visual check of animation JSON before or without hardware.

**Implementation (`LedGrid.tsx` + `PreviewScreen.tsx`):**

- **`LedGrid`** takes `AnimationData | null`, optional `playing`, `pixelSize`, `gap`.
- Renders a **2D grid** of `View` “pixels” with background colors from each `[R,G,B]`.
- Frame index advances with **`setInterval(1000 / fps)`** when `playing` and `frames.length > 1`. Respects **`config.loop`**: at end of frames, reset to 0 or hold last frame.
- **Row-major indexing:** `idx = row * width + col`, same as firmware logical order.

**`PreviewScreen`:** Text area + “Load preview” parses JSON with `parseAnimationData`; on success updates local `animation` for `LedGrid`. Sample buttons load predefined animations.

---

### 6.4 Gallery — local library of named animations

**Goal:** Store multiple animations on the phone; recall and push to the ESP without re-pasting JSON.

**Data model (`lib/types.ts` — `GalleryItem`):**

- `id` (unique string), `name`, `createdAt`, full `json` string, plus cached `width`, `height`, `frameCount` for list UI.

**Storage (`lib/gallery.ts`):**

- Single AsyncStorage key holding a **JSON array** of `GalleryItem`.
- `addToGallery` validates animation JSON, prepends new item, saves.
- `removeFromGallery` filters by `id`.

**UI (`GalleryScreen.tsx`):**

- `FlatList` of cards; tap selects item and parses JSON for inline **`LedGrid`** preview.
- **Send:** `postAnimationJson` + `postEmpty(..., '/play')` so the board starts after load.
- **Delete:** confirm dialog, remove from storage, refresh list.

---

### 6.5 Import — photos and animated GIFs → animation JSON

**Goal:** Turn user media into the same frame format the ESP accepts, with on-device processing.

**Why a WebView:** React Native has no built-in “read pixel array from image” API. A **hidden `WebView`** loads self-contained HTML/JS that uses the browser **Canvas** (`drawImage`, `getImageData`) and, for GIFs, an **inline LZW/frame compositing** decoder (see `lib/processorHtml.ts`).

**Static images (`ImportScreen.tsx`):**

1. **`expo-image-picker`** — user picks from library; get `uri`, `mimeType`, dimensions.
2. If **not** GIF: **`expo-image-manipulator`** — **center crop** to match grid aspect ratio, then **resize** to exact `width × height` (defaults 32×48). Produces a tiny PNG so base64 is small.
3. **`expo-file-system/legacy`** — `readAsStringAsync(..., { encoding: Base64 })`.
4. Inject into WebView: **`processImage(base64, mime, w, h)`** → returns one frame of `[[r,g,b], ...]`.

**Animated GIFs:**

1. Read **full file** as base64 (GIF preserved).
2. WebView decodes all frames, composites per GIF disposal rules, scales each full frame to grid size, returns **`frames`** array + derived **fps** from average frame delay (capped sensibly).

**Output:** Build `AnimationData` (`version`, `type`, `meta`, `config`, `frames`), show in **`LedGrid`**, allow **Send to device** and **Save to gallery**.

**Design choices:**

- **Cover-style crop** for stills: fills the grid; edges of photo may be cropped.
- **Bilinear smoothing** on canvas when downscaling (photos); could be toggled later for pixel art.
- **Permissions:** `expo-image-picker` requests media library access when needed.

---

## 7. Shared parsing and types (`lib/types.ts`)

- **`AnimationData`**, **`RGBTriple`**, **`Frame`**, **`GalleryItem`** mirror the protocol.
- **`parseAnimationData(jsonString)`:** `JSON.parse` + sanity checks (`version === 1`, `type === 'animation'`, dimensions, non-empty `frames`). Returns `null` on failure—used before gallery save and preview load.

---

## 8. Dependencies (npm)

| Package | Role |
| ------- | ---- |
| `expo` | Toolchain, dev client, EAS |
| `expo-constants` | Detect Expo Go vs standalone for in-app copy |
| `eas-cli` | (devDependency) Standalone cloud builds |
| `react`, `react-native` | UI |
| `@react-native-async-storage/async-storage` | URL + gallery persistence |
| `expo-image-picker` | Pick image/GIF |
| `expo-image-manipulator` | Crop/resize stills before pixel read |
| `expo-file-system` (legacy read API) | Base64 read of picked/manipulated files |
| `react-native-webview` | Canvas + GIF decode for import |
| `@expo/ngrok` | Optional: `expo start --tunnel` when LAN to dev machine is awkward |

---

## 9. How to run the app (developer)

```bash
cd app
npm install
npx expo start
```

Open **Expo Go** on the phone (same machine LAN as dev server, or use tunnel). **Important:** The phone must be on the **same Wi‑Fi as the ESP** to use `http://<esp-ip>` for `/status` and `/animation`. Tunnel only helps load the JS bundle, not reach a private LAN IP.

**iOS:** If local HTTP fails, enable **Local Network** for **Expo Go** in system Settings.

---

## 10. Platform configuration (`app.json`)

Local HTTP to a private IP is non-default on mobile OSes:

- **iOS:** `NSAppTransportSecurity` → `NSAllowsLocalNetworking: true` so `http://192.168.x.x` is allowed.
- **Android:** `usesCleartextTraffic: true` for the same reason.

Without these, `fetch` to the ESP can fail even on the correct Wi‑Fi.

---

## 11. Stretch goal: LLM (not part of core v1)

Once send, preview, gallery, and import are solid, a natural extension is **text (or voice → text) → animation JSON** using a cloud API (e.g. Google Gemini), with prompts constrained to the same JSON shape as `AnimationData` in the app. That would speed up creation but requires API keys, network, and guardrails. It is **not** required for the LED poster to function; the core loop is **JSON + HTTP + firmware**.

---

## 12. Standalone builds (no Expo Go, no laptop to run the app)

Expo Go loads your JavaScript from **Metro on a development machine**. A **standalone** (EAS or `expo prebuild` + store) build **bundles the same React Native code inside the `.ipa` / `.apk`**. After install, opening the app does **not** require `expo start` or the same Wi‑Fi as your laptop.

### What still needs a network

| Action | Phone | Poster / notes |
|--------|--------|----------------|
| **Expo Go (dev)** | Reach Metro — same LAN as dev PC or **`expo start --tunnel`** | — |
| **Program STA Wi‑Fi on the MCU** | — | Create **`firmware/include/wifi_config.h`** locally (**gitignored**). Full template + fields: **`firmware/README.md`**. Set **`WIFI_SSID`**, **`WIFI_PASSWORD`**, **`HTTP_PORT`**; optional **`WIFI_LOCK_BSSID`**. Flash over **USB** (`pio run -t upload`). There is **no** soft‑AP onboarding in current firmware — network changes require editing that file and reflashing. |
| **Poster control / uploads** | Same **Wi‑Fi or routed LAN** as the ESP | **ESP Base URL** — `http://<poster-ip>`; if **`HTTP_PORT` ≠ 80**, append `:port`. **Trust:** HTTP API has **no token** — use only on a network segment you trust, or VLAN-isolate IoT traffic. |

A **standalone** installable build does **not** need Metro to open the app shell, but the ESP must remain reachable per the rows above whenever you push animations or taps.

### One-time developer setup (EAS)

From the **`app/`** directory:

Use **`npx eas-cli …`** or **`npm run …`** so the CLI is found (`eas` alone fails unless installed globally). Example: `npx eas-cli build --profile preview --platform android` or `npm run build:preview:android`.

```bash
npm install
npx eas-cli login
npx eas-cli init
```

`eas init` links this folder to your Expo account and adds `extra.eas.projectId` to `app.json`. Run it **alone** (do not paste the explanatory text on the same line as the command).

Build installable binaries (internal / TestFlight-style flow uses **preview**; store submission uses **production**):

```bash
npm run build:preview:ios
npm run build:preview:android
```

Use **one** of the two lines above (iOS or Android). Do not paste both on one line with `# or` comments — some shells pass those words to `eas` as extra arguments and the build fails.

**First Android cloud build:** run `npm run build:preview:android` in a normal terminal (not `--non-interactive`). When EAS asks about the Android keystore, choose **Generate a new keystore** (or let Expo manage credentials). After that succeeds once, later builds can use automation if you want.

If EAS **installs `expo-updates` during** `eas build` and prints **"Command must be re-run to pick up new updates configuration"**, that is normal: run the **same** `eas build` / `npm run build:preview:*` command **again** once.

Follow the EAS build page to download the **IPA** or **APK**. Install on the phone (Finder/Xcode, Android “Install unknown app”, or TestFlight/Play after `eas submit`).

**iOS (EAS cloud build):** Apple’s servers require an **Apple Developer Program** membership (~\$99/year) and a **Team** on that account. A personal Apple ID **without** that program has **no team**, so EAS fails with *“You have no team associated with your Apple account”*. Fix: enroll at [developer.apple.com](https://developer.apple.com/programs/), accept the invite in Apple Developer, then run the iOS build again — or use **Android** preview APK (`npm run build:preview:android`) which needs no Apple account. For **iOS Simulator-only** builds, use the `development` profile in `eas.json` (`simulator: true`) or run **`npx expo run:ios`** on a Mac with Xcode.

**Android:** APK preview builds are simplest for sideloading and do not use Apple credentials.

### iOS sideload with Xcode only (free Personal Team)

Use this when you **do not** have a paid Apple Developer Program account but you **do** have a Mac with **Xcode** (from the Mac App Store) and a USB cable. You build and install **on your own iPhone**; the app binary is produced locally (no EAS iOS cloud signing required for this path).

**Limits of the free Personal Team:** signing expires about **every 7 days** (reconnect the phone and **Run** again in Xcode), and Apple caps how many apps you can refresh per week. For a long-lived install without that hassle, use a paid Developer account + TestFlight or EAS.

**Steps:**

1. **Apple ID in Xcode:** Xcode → **Settings** → **Accounts** → add your Apple ID. You should see a **Personal Team** under that account.

2. **Generate the native iOS project** (the `ios/` folder is gitignored; create it on your Mac):
   ```bash
   cd app
   npm install
   npm run prebuild:ios
   ```
   If you previously generated `ios/` and things look wrong, run `npx expo prebuild --platform ios --clean` (overwrites `ios/`).

3. **Install CocoaPods dependencies** (once per machine / after native dependency changes):
   ```bash
   cd ios && pod install && cd ..
   ```

4. **Open the workspace** (not the bare `.xcodeproj` when CocoaPods is in use):
   ```bash
   npm run ios:xcode
   ```
   Or in Finder: open `app/ios/` and double-click the **`.xcworkspace`** file.

5. **In Xcode:**  
   - Top bar: select your **iPhone** (plug it in, unlock it, tap **Trust** if asked).  
   - Left sidebar: click the **blue project icon** → under **TARGETS** select the app target → **Signing & Capabilities**.  
   - Check **Automatically manage signing**.  
   - **Team:** choose your **Personal Team**.  
   - If Xcode says the **bundle identifier** is unavailable, change it to something unique (e.g. `com.yourname.ledposter`) in that same screen. If you change it, update `ios.bundleIdentifier` in `app.json` too so future prebuilds stay consistent.

6. **Build and run:** click the **Run** (▶) button. Xcode builds, installs, and launches the app on the phone.

**Development builds (`expo-dev-client`, Debug configuration):** The JavaScript bundle is loaded from **Metro** on your Mac, not baked into the app. If Xcode says the app finished but it **does not stay open** or shows a connection error, start the dev server **before** (or right after) installing:

```bash
cd app
npm run start:devclient
```

Use the **same Wi‑Fi** for the phone and Mac (or USB is enough for the initial load on some setups). In the Metro terminal, press **`i`** or scan the QR / open the dev menu on the phone to connect. After you change **native** npm packages (e.g. `expo-clipboard`), run **`cd ios && pod install`** again, then rebuild in Xcode.

A **Release** build (see below) embeds the JS and does **not** require Metro for launch.

7. **First launch on iPhone:** **Settings → General → VPN & Device Management** (or **Profiles & Device Management**) → tap your Apple ID under **Developer App** → **Trust**.

**Optional one-shot from the terminal** (still uses Xcode toolchains; may start a dev server for Debug builds):

```bash
cd app
npm run ios:device
```

For a **Release** build on device (fewer dev-only behaviors), use:

```bash
npx expo run:ios --device --configuration Release
```

### Repo files involved

- **`app/app.json`** — bundle IDs; **`NSAllowsLocalNetworking`** and **`usesCleartextTraffic`** so `fetch` may use **`http://`** to the ESP on the LAN.
- **`app/package.json`** / **`package-lock.json`** — dependencies and reproducible installs.
- **`app/eas.json`** — optional; add with **`eas init`** when using EAS. No Wi‑Fi secrets belong here—Expo manages signing separately.

Firmware side: **`platformio.ini`**, **`firmware/README.md`** (includes **`wifi_config.h` template**, not checked in).

---

## 13. Checklist to rebuild this app from scratch

1. Implement or obtain firmware with the REST endpoints above and correct LED mapping.
2. Create an Expo app; add AsyncStorage, configure `app.json` for local HTTP.
3. Implement `normalizeBaseUrl`, `fetchWithTimeout`, and thin wrappers for each endpoint.
4. Define `AnimationData` and `parseAnimationData` (see **`app/lib/types.ts`**; optional private JSON Schemas elsewhere).
5. Build **Settings** (persist URL), **Control** (commands + JSON + send), **Preview** (`LedGrid` + interval timing), **Gallery** (AsyncStorage list + send), **Import** (picker → manipulator → WebView pixels → JSON).
6. Test: Safari/Chrome on phone to `http://<esp-ip>/status`, then same URL in the app.

---

*This guide reflects the repository layout and design as of the documented implementation. Firmware details live under `firmware/`.*
