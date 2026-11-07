#!/usr/bin/env bash
# Build a signed 3itter APK.
#   TOOLCHAIN   folder with rust (rustup), jdk and Android sdk  (default ~/.local/opt/android-build)
#   KEYSTORE    signing key, created on first run                (default $TOOLCHAIN/3itter-release.jks)
set -euo pipefail
cd "$(dirname "$0")"
T=${TOOLCHAIN:-$HOME/.local/opt/android-build}
export RUSTUP_HOME=$T/rustup CARGO_HOME=$T/cargo JAVA_HOME=$T/jdk ANDROID_HOME=$T/sdk
export NDK_HOME=$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)
export PATH="$CARGO_HOME/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
BT=$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)

[ -d node_modules ] || npm install --no-audit --no-fund
[ -f src-tauri/icons/icon.png ] || npx tauri icon ../public/icon-512.png
[ -d src-tauri/gen/android ] || npx tauri android init --ci

npx tauri android build --apk --target aarch64 --ci

UNSIGNED=$(find src-tauri/gen/android/app/build/outputs/apk -name '*release-unsigned.apk' | head -1)
KS=${KEYSTORE:-$T/3itter-release.jks}
PASSFILE=$KS.pass
if [ ! -f "$KS" ]; then
  head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > "$PASSFILE"; chmod 600 "$PASSFILE"
  keytool -genkeypair -keystore "$KS" -alias 3itter -keyalg RSA -keysize 4096 -validity 10000 \
    -storepass "$(cat "$PASSFILE")" -keypass "$(cat "$PASSFILE")" -dname "CN=3itter, O=3itter" >/dev/null
  chmod 600 "$KS"
  echo "Created signing key $KS (password in $PASSFILE). Keep both safe: updates must be signed with the same key."
fi
mkdir -p dist
"$BT/zipalign" -f -p 4 "$UNSIGNED" dist/3itter-aligned.apk
"$BT/apksigner" sign --ks "$KS" --ks-pass "file:$PASSFILE" --ks-key-alias 3itter --out dist/3itter.apk dist/3itter-aligned.apk
rm -f dist/3itter-aligned.apk dist/*.idsig
"$BT/apksigner" verify dist/3itter.apk && echo "APK: $(pwd)/dist/3itter.apk ($(du -h dist/3itter.apk | cut -f1))"
