#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${HYPERION_DEPLOY_HOST:-thejiwon2025}"
REMOTE_WEB_DIR="${HYPERION_WEB_DIR:-/var/www/skhynix}"
BASE_VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/.VERSION")"
GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
BUILD_STAMP="$(TZ=Asia/Seoul date +%Y%m%d%H%M%S)"
DEPLOYED_AT="$(TZ=Asia/Seoul date '+%Y-%m-%d %H:%M:%S KST')"
BUILD_VERSION="v${BASE_VERSION}+${GIT_SHA}.${BUILD_STAMP}"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

cp "$ROOT_DIR/index.html" "$STAGE_DIR/index.html"
python3 "$ROOT_DIR/scripts/stamp_deployment_metadata.py" \
  "$STAGE_DIR/index.html" "$BUILD_VERSION" "$DEPLOYED_AT"

FILES=("$STAGE_DIR/index.html")
for relative_path in "$@"; do
  if [[ "$relative_path" == "index.html" ]]; then
    continue
  fi
  if [[ "$relative_path" == */* || ! -f "$ROOT_DIR/$relative_path" ]]; then
    echo "Frontend asset must be an existing root-level file: $relative_path" >&2
    exit 2
  fi
  cp "$ROOT_DIR/$relative_path" "$STAGE_DIR/$relative_path"
  FILES+=("$STAGE_DIR/$relative_path")
done

echo "Inspecting production checkout and service..."
ssh "$REMOTE_HOST" "cd /home/ubuntu/skhynix && git status --short && systemctl is-active skhynix-daemon"

echo "Deploying $BUILD_VERSION ($DEPLOYED_AT)..."
scp "${FILES[@]}" "$REMOTE_HOST:/tmp/"
for staged_file in "${FILES[@]}"; do
  filename="$(basename "$staged_file")"
  ssh "$REMOTE_HOST" "sudo install -o root -g root -m 0644 '/tmp/$filename' '$REMOTE_WEB_DIR/$filename'"
done

headers="$(curl -fsSI https://control.jiwonova.com/skhynix/)"
grep -qi '^content-type: text/html' <<<"$headers"
curl -fsS "https://control.jiwonova.com/skhynix/?build=$BUILD_STAMP" -o "$STAGE_DIR/live-index.html"
grep -Fq "$BUILD_VERSION" "$STAGE_DIR/live-index.html"
echo "Verified HTTP 200 text/html and live build $BUILD_VERSION"
