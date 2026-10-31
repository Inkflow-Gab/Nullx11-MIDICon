# MIDICon Android companion

This repository now includes a native Android companion app and a GitHub Actions workflow that builds an installable APK.

## What the APK is — and is not

The APK is a **server-connected companion**, not an offline transcription engine. MIDICon's current engines are Python/ONNX server workloads (Kong piano transcription, Basic Pitch, FFmpeg, yt-dlp, SQLite jobs). They are not bundled into the APK. The Android app loads your deployed MIDICon server over HTTPS so the existing web studio, private session cookie, uploads, YouTube imports, live progress, editing, and downloads keep working with the same-origin security model.

The debug APK built by Actions is signed with the runner's Android debug key. It is ready to sideload for testing, but it is **not** a Play Store release and should not be treated as a stable production signing identity.

## Download the APK from GitHub Actions

1. Open the repository's **Actions** tab.
2. Select the latest successful **Android APK** run on your branch.
3. Download the artifact named `MIDICon-debug-apk-<run number>`.
4. Extract `MIDICon-debug.apk` and install it on an Android 8.0+ device. Android may ask you to allow installs from that source.

The artifact also includes:

- `SHA256SUMS.txt` — checksum for the APK
- `BUILD_INFO.txt` — commit, run URL, version, and server-default note
- `apk-badging.txt` — package/SDK metadata from `aapt`

The workflow runs unit tests, Android lint, `assembleDebug`, and `apksigner verify` before uploading. It fails if the APK is missing.

## First launch

1. Deploy the web studio somewhere the phone can reach, with valid HTTPS. See [`README_WEB.md`](README_WEB.md) and `Dockerfile.web`.
2. Open MIDICon on Android.
3. Enter the server root URL, for example `https://midi.example.com`.
4. Tap **Connect to server**. The app checks `/api/health` before opening the studio.
5. Use the studio normally. File uploads use Android's file picker; MIDI/ZIP/JSON/CSV downloads go to `Downloads/MIDICon`.

HTTP is disabled in the APK. Use HTTPS even for local testing (for example through a reverse proxy or tunnel). The app does not bypass certificate errors.

### Optional preconfigured server

By default the APK asks for the server on first launch. To prefill a server URL in CI, set this GitHub repository variable:

- **Settings → Secrets and variables → Actions → Variables**
- Name: `MIDICON_ANDROID_SERVER`
- Value: `https://your-midicon-server.example.com`

Then re-run **Android APK**. The value is not a secret; do not put credentials in it. User/password URLs are rejected.

## Build locally

Requirements: JDK 17 and Android SDK 35 / build-tools 35.0.0. Android Studio can install these.

```bash
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

APK output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Optional build properties:

```bash
./gradlew :app:assembleDebug \
  -PmidiconDefaultServer=https://midi.example.com \
  -PmidiconVersionCode=2 \
  -PmidiconVersionName=1.0.0
```

On Windows use `gradlew.bat` instead of `./gradlew`.

## Production release signing

The workflow intentionally builds a debug APK so it works without storing signing secrets. For a production release, create a private upload/release keystore, store it outside Git, add GitHub Actions secrets for keystore/password/key alias, configure a signed `release` build type, and build `assembleRelease` or an AAB. Never commit `*.jks`, `*.keystore`, or signing passwords.

## Security and privacy notes

- The app requires HTTPS and rejects non-HTTP(S) navigation, user-info URLs, and cross-origin cookie/download forwarding.
- WebView file/content access is disabled; JavaScript and DOM storage are enabled because the studio needs them.
- Downloads reuse the WebView session cookie only for the configured server origin and are handled by Android DownloadManager.
- `allowBackup=false` avoids backing up the app's private WebView/session state through Android backup.
- The server still enforces its own session ownership, CSRF/origin checks, upload limits, and retention. The APK does not weaken them.

## Project layout

```text
.github/workflows/android.yml   GitHub Actions APK build, verification, and artifact upload
android/                        Native Java Android app, Gradle wrapper, unit tests, resources
android/app/src/main/java/      WebView companion, server URL validation, download-name safety
android/app/src/test/java/      JVM unit tests for URL and download safety rules
```
