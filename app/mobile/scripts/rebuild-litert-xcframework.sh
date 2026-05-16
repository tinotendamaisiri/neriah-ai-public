#!/usr/bin/env bash
# rebuild-litert-xcframework.sh
#
# One-shot pipeline to rebuild the vendored LiteRT-LM iOS XCFramework
# at a chosen LiteRT-LM git tag, then re-extract the engine_init.a
# force-load shim for the new build.
#
# Why this exists: the Gemma 4 .litertlm files on HuggingFace are
# compiled against a specific revision of the TFLite ops included in
# LiteRT-LM. Our previous vendored framework (built at v0.10.1) shipped
# a different ops revision, so model invoke failed with
#   Node N (DYNAMIC_UPDATE_SLICE) failed to prepare:
#   SizeOfDimension(update, i) <= SizeOfDimension(operand, i) was not true
# at runtime. Rebuilding against a matching tag (or HEAD of main, the
# usual safe pick when the model was published recently) realigns the
# ops and lets Gemma 4 invoke successfully.
#
# Usage:
#   bash scripts/rebuild-litert-xcframework.sh                # uses main
#   bash scripts/rebuild-litert-xcframework.sh v0.11.0        # specific tag
#
# Roughly 30–60 minutes of Bazel build time on a cold machine.
# Subsequent runs are faster because Bazel caches.

set -euo pipefail

LITERT_TAG="${1:-main}"

if [ "$(uname)" != "Darwin" ]; then
  echo "[rebuild-litert] non-macOS host — bail."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$PROJECT_ROOT/node_modules/react-native-litert-lm"
VENDOR_FW="$PROJECT_ROOT/vendor/litert-ios/LiteRTLM.xcframework"
ENGINE_INIT_DIR="$PROJECT_ROOT/vendor/litert-ios/EngineInit"
PKG_JSON="$PKG_DIR/package.json"

if [ ! -d "$PKG_DIR" ]; then
  echo "[rebuild-litert] react-native-litert-lm not in node_modules — run npm install first."
  exit 1
fi

# ---- 1. Pin the package's iosGitTag to the tag we want -------------------
echo "[rebuild-litert] Pinning iosGitTag → $LITERT_TAG in node_modules package.json"
node -e "
  const fs = require('fs');
  const path = '$PKG_JSON';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  pkg.litertLm = pkg.litertLm || {};
  pkg.litertLm.iosGitTag = '$LITERT_TAG';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

# ---- 2. Wipe the previous LiteRT-LM clone so the build script re-clones --
#         at the new tag. (The build script does a `git checkout` if the
#         dir already exists, but switching from a v0.10.1 shallow clone
#         to a different rev with --depth 1 has surprised us before. A
#         clean clone is safer.)
BUILD_DIR="$PKG_DIR/.litert-lm-build"
if [ -d "$BUILD_DIR/LiteRT-LM" ]; then
  echo "[rebuild-litert] Wiping previous LiteRT-LM clone."
  rm -rf "$BUILD_DIR/LiteRT-LM"
fi

# ---- 3. Run the upstream build script ------------------------------------
echo "[rebuild-litert] Running build-ios-engine.sh — this is the long part."
echo "                 Bazel cold build is ~30–60 minutes."
( cd "$PKG_DIR" && bash scripts/build-ios-engine.sh )

NEW_FW="$PKG_DIR/ios/Frameworks/LiteRTLM.xcframework"
if [ ! -d "$NEW_FW" ]; then
  echo "[rebuild-litert] ✗ Build script did not produce $NEW_FW — bailing."
  exit 1
fi

# ---- 4. Replace the vendored XCFramework ---------------------------------
echo "[rebuild-litert] Copying fresh XCFramework into vendor/litert-ios/"
rm -rf "$VENDOR_FW"
cp -R "$NEW_FW" "$VENDOR_FW"

# ---- 5. Re-extract engine_init.a per slice -------------------------------
#         The static initializer in engine_impl.o registers the engine type
#         with EngineFactory at startup. We force-load just that one .o so
#         Apple's linker doesn't strip it (force-loading the whole framework
#         double-links and produces duplicate-symbol errors). See
#         vendor/litert-podspec/react-native-litert-lm.podspec for context.
echo "[rebuild-litert] Re-extracting engine_init.a per-slice…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for SLICE in ios-arm64 ios-arm64-simulator; do
  SRC_LIB="$VENDOR_FW/$SLICE/LiteRTLM.framework/LiteRTLM"
  if [ ! -f "$SRC_LIB" ]; then
    echo "[rebuild-litert] ✗ Missing slice binary at $SRC_LIB"
    exit 1
  fi

  WORK="$TMP/$SLICE"
  mkdir -p "$WORK"
  ( cd "$WORK" && ar x "$SRC_LIB" engine_impl.o )
  if [ ! -f "$WORK/engine_impl.o" ]; then
    echo "[rebuild-litert] ✗ engine_impl.o not found inside $SRC_LIB — engine_impl.cc may have been renamed upstream."
    exit 1
  fi

  DEST_DIR="$ENGINE_INIT_DIR/$SLICE"
  mkdir -p "$DEST_DIR"
  ( cd "$WORK" && ar rcs "$DEST_DIR/libengine_init.a" engine_impl.o )
  echo "   ✓ $SLICE/libengine_init.a ($(du -h "$DEST_DIR/libengine_init.a" | cut -f1))"
done

# ---- 6. Push everything into node_modules via the existing install hook --
echo "[rebuild-litert] Running install-litert-ios-framework.sh to copy assets into node_modules…"
bash "$SCRIPT_DIR/install-litert-ios-framework.sh"

echo ""
echo "[rebuild-litert] ✅ Done."
echo "                 Pinned tag: $LITERT_TAG"
echo "                 Next:"
echo "                   cd $PROJECT_ROOT"
echo "                   npx pod-install ios"
echo "                   npx expo run:ios --device --configuration Release"
