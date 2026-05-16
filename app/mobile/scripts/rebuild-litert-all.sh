#!/usr/bin/env bash
# rebuild-litert-all.sh
#
# Combined iOS + Android rebuild of the vendored LiteRT-LM artifacts at a
# chosen LiteRT-LM git tag. Replaces rebuild-litert-xcframework.sh — does
# the iOS XCFramework AND the Android JNI .so + AAR splice in one trip.
#
# Why: the published litertlm-android@0.11.0-rc1 AAR can't load the current
# gemma-4-E2B-it.litertlm file (engine falls back to TF_LITE_PREFILL_DECODE
# which the model lacks). The fix landed on LiteRT-LM main on 2026-05-01:
# the loader was taught to read prefer_activation_type from model metadata.
# Building from main pulls that fix in for both platforms.
#
# Usage:
#   bash scripts/rebuild-litert-all.sh             # uses main
#   bash scripts/rebuild-litert-all.sh v0.11.0     # specific tag once it ships
#
# Cold Bazel build is roughly 60–90 minutes. Subsequent runs hit cache.
#
# Outputs:
#   vendor/litert-ios/LiteRTLM.xcframework/        # iOS framework
#   vendor/litert-ios/EngineInit/<slice>/          # iOS force-load shim
#   vendor/litert-android/litertlm-android.aar     # Android AAR (splice)
#
# Followed automatically by install-litert-frameworks.sh which copies the
# vendored bits into node_modules/react-native-litert-lm/.

set -euo pipefail

LITERT_TAG="${1:-main}"

if [ "$(uname)" != "Darwin" ]; then
  echo "[rebuild-litert] non-macOS host — bail."
  exit 1
fi

# ── Tooling preflight ─────────────────────────────────────────────────────
for cmd in node npm bazelisk unzip; do
  if ! command -v "$cmd" &>/dev/null; then
    if [ "$cmd" = "bazelisk" ] && command -v bazel &>/dev/null; then
      continue   # plain bazel is acceptable; bazelisk is just preferred
    fi
    echo "[rebuild-litert] Missing required command: $cmd"
    [ "$cmd" = "bazelisk" ] && echo "  Install with: brew install bazelisk"
    exit 1
  fi
done

# Android NDK — needed by Bazel's android_arm64 config.
if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  # Try the default Android Studio install path.
  for NDK_CANDIDATE in "$HOME"/Library/Android/sdk/ndk/*; do
    if [ -d "$NDK_CANDIDATE" ]; then
      export ANDROID_NDK_HOME="$NDK_CANDIDATE"
      break
    fi
  done
fi
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "$ANDROID_NDK_HOME" ]; then
  echo "[rebuild-litert] Android NDK not found. Install via Android Studio →"
  echo "                 SDK Manager → SDK Tools → NDK, or set ANDROID_NDK_HOME."
  exit 1
fi
echo "[rebuild-litert] Using Android NDK: $ANDROID_NDK_HOME"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$PROJECT_ROOT/node_modules/react-native-litert-lm"
VENDOR_IOS="$PROJECT_ROOT/vendor/litert-ios"
VENDOR_ANDROID="$PROJECT_ROOT/vendor/litert-android"
PKG_JSON="$PKG_DIR/package.json"

if [ ! -d "$PKG_DIR" ]; then
  echo "[rebuild-litert] react-native-litert-lm not in node_modules — run npm install first."
  exit 1
fi

# ── 1. Pin the package's tags so build scripts see the right version ───────
echo "[rebuild-litert] Pinning iosGitTag → $LITERT_TAG in node_modules package.json"
node -e "
  const fs = require('fs');
  const path = '$PKG_JSON';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.litertLm = pkg.litertLm || {};
  pkg.litertLm.iosGitTag = '$LITERT_TAG';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

# ── 2. Wipe the previous LiteRT-LM clone for a clean checkout ──────────────
# Skip the wipe when KEEP_CLONE=1 — useful for re-running the script after
# fixing a target name or other config issue without redoing the iOS Bazel
# work (which can save 30+ minutes on cold cache).
BUILD_DIR="$PKG_DIR/.litert-lm-build"
if [ -d "$BUILD_DIR/LiteRT-LM" ] && [ "${KEEP_CLONE:-0}" != "1" ]; then
  echo "[rebuild-litert] Wiping previous LiteRT-LM clone (set KEEP_CLONE=1 to skip)."
  rm -rf "$BUILD_DIR/LiteRT-LM"
elif [ "${KEEP_CLONE:-0}" = "1" ]; then
  echo "[rebuild-litert] KEEP_CLONE=1 — reusing existing LiteRT-LM clone."
fi

# ── 3. Run the upstream iOS build (existing path) ──────────────────────────
NEW_FW="$PKG_DIR/ios/Frameworks/LiteRTLM.xcframework"
if [ "${SKIP_IOS:-0}" = "1" ] && [ -d "$NEW_FW" ]; then
  echo "[rebuild-litert] SKIP_IOS=1 — reusing existing iOS XCFramework."
else
  echo "[rebuild-litert] === iOS build (Bazel, ~30–45 min cold) ==="
  ( cd "$PKG_DIR" && bash scripts/build-ios-engine.sh )
fi

if [ ! -d "$NEW_FW" ]; then
  echo "[rebuild-litert] ✗ iOS build did not produce $NEW_FW — bailing."
  exit 1
fi

# ── 4. Vendor the iOS XCFramework ──────────────────────────────────────────
echo "[rebuild-litert] Copying fresh XCFramework into vendor/litert-ios/"
mkdir -p "$VENDOR_IOS"
rm -rf "$VENDOR_IOS/LiteRTLM.xcframework"
cp -R "$NEW_FW" "$VENDOR_IOS/LiteRTLM.xcframework"

# ── 5. Re-extract iOS engine_init.a per slice ──────────────────────────────
#         The static initializer in engine_impl.o registers the engine type
#         with EngineFactory at startup. Apple's linker would strip it if we
#         don't force-load. See vendor/litert-podspec/react-native-litert-lm.podspec.
echo "[rebuild-litert] Re-extracting iOS engine_init.a per-slice…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ENGINE_INIT_DIR="$VENDOR_IOS/EngineInit"
for SLICE in ios-arm64 ios-arm64-simulator; do
  SRC_LIB="$VENDOR_IOS/LiteRTLM.xcframework/$SLICE/LiteRTLM.framework/LiteRTLM"
  if [ ! -f "$SRC_LIB" ]; then
    echo "[rebuild-litert] ✗ Missing iOS slice binary at $SRC_LIB"
    exit 1
  fi

  WORK="$TMP/$SLICE"
  mkdir -p "$WORK"
  ( cd "$WORK" && ar x "$SRC_LIB" engine_impl.o )
  if [ ! -f "$WORK/engine_impl.o" ]; then
    echo "[rebuild-litert] ✗ engine_impl.o not found in $SRC_LIB."
    exit 1
  fi

  DEST_DIR="$ENGINE_INIT_DIR/$SLICE"
  mkdir -p "$DEST_DIR"
  ( cd "$WORK" && ar rcs "$DEST_DIR/libengine_init.a" engine_impl.o )
  echo "   ✓ ios/$SLICE/libengine_init.a ($(du -h "$DEST_DIR/libengine_init.a" | cut -f1))"
done

# ── 6. Run the upstream Android JNI build ──────────────────────────────────
#         Builds the .so files containing the C++ engine (with the May 1
#         loader fix). We splice these into the existing 0.11.0-rc1 AAR
#         instead of trying to produce an AAR from Bazel — Kotlin classes
#         in the published AAR are still compatible since prefer_activation_type
#         is read from model metadata, not from the EngineConfig API.
echo ""
echo "[rebuild-litert] === Android JNI build (Bazel, ~30–45 min cold) ==="
LITERT_SRC="$BUILD_DIR/LiteRT-LM"
if [ ! -d "$LITERT_SRC" ]; then
  echo "[rebuild-litert] ✗ LiteRT-LM source missing at $LITERT_SRC after iOS build — bailing."
  exit 1
fi

# ── 6a. Pull LFS binaries that Android needs ───────────────────────────────
# The iOS build script clones with GIT_LFS_SKIP_SMUDGE=1 because iOS uses
# C++ stubs (scripts/stubs/) instead of the prebuilt accelerators in
# prebuilt/android_*/. Android genuinely needs them — without them the
# JNI link fails with "ld.lld: error: unknown directive: version" because
# the .so files are still LFS pointer text.
if ! command -v git-lfs &>/dev/null; then
  echo "[rebuild-litert] ✗ git-lfs not installed. Install with: brew install git-lfs"
  echo "                 Then run: git lfs install"
  exit 1
fi
PREBUILT_SO="$LITERT_SRC/prebuilt/android_arm64/libGemmaModelConstraintProvider.so"
if [ ! -f "$PREBUILT_SO" ] || [ "$(wc -c < "$PREBUILT_SO" | tr -d ' ')" -lt 1000 ]; then
  echo "[rebuild-litert] Pulling LFS binaries (Android prebuilt accelerators)…"
  ( cd "$LITERT_SRC" && git lfs pull )
  if [ ! -f "$PREBUILT_SO" ] || [ "$(wc -c < "$PREBUILT_SO" | tr -d ' ')" -lt 1000 ]; then
    echo "[rebuild-litert] ✗ git lfs pull didn't produce real binaries. Check 'git lfs install' was run."
    exit 1
  fi
  echo "[rebuild-litert] ✓ LFS binaries fetched ($(du -sh "$LITERT_SRC/prebuilt" | cut -f1))."
fi

BAZEL="bazelisk"
command -v bazelisk &>/dev/null || BAZEL="bazel"

(
  cd "$LITERT_SRC"
  echo "[rebuild-litert] bazel build --config=android_arm64 //kotlin/java/com/google/ai/edge/litertlm/jni:litertlm_jni …"
  # The JNI cc_binary already pulls engine_factory + engine_impl transitively,
  # which include the vision/audio executor registrations. We add the vision
  # and audio executor cc_libraries explicitly anyway so their static
  # initializers (LITERT_LM_REGISTER_*) are guaranteed to land in the .so.
  $BAZEL build \
    --config=android_arm64 \
    --verbose_failures \
    //kotlin/java/com/google/ai/edge/litertlm/jni:litertlm_jni \
    //runtime/executor:vision_litert_compiled_model_executor \
    //runtime/executor:audio_litert_compiled_model_executor
)

# Locate the built .so. cc_binary with linkshared=1 produces liblitertlm_jni.so
# under bazel-bin/kotlin/java/com/google/ai/edge/litertlm/jni/. bazel-bin is
# a symlink into /private/var/tmp, so use find -L to traverse.
BUILT_SO="$(find -L "$LITERT_SRC/bazel-bin/kotlin" -name "liblitertlm_jni.so" -not -path "*/runfiles/*" 2>/dev/null | head -1)"
if [ -z "$BUILT_SO" ] || [ ! -f "$BUILT_SO" ]; then
  echo "[rebuild-litert] ✗ Could not locate built liblitertlm_jni.so under $LITERT_SRC/bazel-bin/"
  echo "                 Expected something under bazel-bin/kotlin/java/com/google/ai/edge/litertlm/jni/."
  find -L "$LITERT_SRC/bazel-bin" -name "*.so" 2>/dev/null | head -10
  exit 1
fi
echo "[rebuild-litert] ✓ Built JNI: $BUILT_SO"

# ── 7. Splice the new .so into a copy of the published AAR ─────────────────
#         The Kotlin/Java surface of 0.11.0-rc1 stays the same. Only the
#         native engine code needs swapping for the prefer_activation_type
#         loader fix. Cleaner than rebuilding the whole AAR from Bazel.
echo "[rebuild-litert] Splicing fresh .so into vendored AAR…"
mkdir -p "$VENDOR_ANDROID"

# Pull a clean copy of the published AAR (pinned to 0.11.0-rc1; the Kotlin
# classes are stable and our Hybrid wrapper expects this version).
PUBLISHED_AAR_URL="https://dl.google.com/dl/android/maven2/com/google/ai/edge/litertlm/litertlm-android/0.11.0-rc1/litertlm-android-0.11.0-rc1.aar"
PUBLISHED_AAR_CACHE="$TMP/litertlm-android-0.11.0-rc1.aar"
echo "   Downloading reference AAR ($PUBLISHED_AAR_URL)…"
curl -sSL -o "$PUBLISHED_AAR_CACHE" "$PUBLISHED_AAR_URL"

AAR_WORK="$TMP/aar-splice"
rm -rf "$AAR_WORK" && mkdir -p "$AAR_WORK"
( cd "$AAR_WORK" && unzip -q "$PUBLISHED_AAR_CACHE" )

if [ ! -f "$AAR_WORK/jni/arm64-v8a/liblitertlm_jni.so" ]; then
  echo "[rebuild-litert] ✗ Reference AAR missing jni/arm64-v8a/liblitertlm_jni.so — Maven layout changed."
  exit 1
fi

cp "$BUILT_SO" "$AAR_WORK/jni/arm64-v8a/liblitertlm_jni.so"
echo "   ✓ Replaced jni/arm64-v8a/liblitertlm_jni.so"

# Our newer liblitertlm_jni.so dynamically links against
# libGemmaModelConstraintProvider.so (LFS-pulled from prebuilt/android_arm64/).
# Without it, Android's linker fails to load the JNI lib at System.loadLibrary
# time — surfaces as UnsatisfiedLinkError. Splice all the prebuilt accelerators
# into the AAR alongside our JNI lib so they ship in the APK together.
PREBUILT_ANDROID="$LITERT_SRC/prebuilt/android_arm64"
if [ -d "$PREBUILT_ANDROID" ]; then
  for SO_FILE in "$PREBUILT_ANDROID"/*.so; do
    [ -f "$SO_FILE" ] || continue
    BASE_NAME="$(basename "$SO_FILE")"
    # Sanity check: skip LFS pointer files (rebuild-litert-all.sh is supposed
    # to have already pulled them, but a missed pull would silently bundle
    # text content as a shared library).
    if [ "$(wc -c < "$SO_FILE" | tr -d ' ')" -lt 1000 ]; then
      echo "   ✗ $BASE_NAME looks like an LFS pointer file (< 1KB) — skipping. Run git lfs pull."
      continue
    fi
    cp "$SO_FILE" "$AAR_WORK/jni/arm64-v8a/$BASE_NAME"
    echo "   ✓ Bundled prebuilt $BASE_NAME ($(du -h "$SO_FILE" | cut -f1))"
  done
fi

# Repack as AAR (zip with .aar extension, no compression on .so).
VENDOR_AAR="$VENDOR_ANDROID/litertlm-android.aar"
rm -f "$VENDOR_AAR"
( cd "$AAR_WORK" && zip -qr "$VENDOR_AAR" . )
echo "[rebuild-litert] ✓ Vendored AAR: $VENDOR_AAR ($(du -h "$VENDOR_AAR" | cut -f1))"

# ── 8. Push everything into node_modules via the install hook ──────────────
echo ""
echo "[rebuild-litert] Running install-litert-frameworks.sh to copy into node_modules…"
INSTALL_SCRIPT="$SCRIPT_DIR/install-litert-frameworks.sh"
if [ ! -f "$INSTALL_SCRIPT" ]; then
  # Fall back to the older name during transition.
  INSTALL_SCRIPT="$SCRIPT_DIR/install-litert-ios-framework.sh"
fi
bash "$INSTALL_SCRIPT"

echo ""
echo "[rebuild-litert] ✅ Done."
echo "                 Pinned tag: $LITERT_TAG"
echo "                 iOS  → $VENDOR_IOS/LiteRTLM.xcframework"
echo "                 Android → $VENDOR_AAR"
echo ""
echo "                 Next:"
echo "                   cd $PROJECT_ROOT"
echo "                   npx pod-install ios"
echo "                   npx expo run:ios --device --configuration Release"
echo "                   npx expo run:android --variant release"
