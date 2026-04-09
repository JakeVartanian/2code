#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
BUCKET="2code-releases"
RELEASE_DIR="$ROOT_DIR/release"

echo "========================================"
echo "Uploading 2Code v$VERSION to R2"
echo "Bucket: $BUCKET"
echo "========================================"
echo ""

# Helper: upload a file if it exists
upload() {
  local file="$1"
  local key="$2"
  if [ -f "$file" ]; then
    echo "⬆️  Uploading $(basename "$file")..."
    wrangler r2 object put "$BUCKET/$key" --file "$file"
    echo "   ✅ Done"
  else
    echo "   ⚠️  Skipping $(basename "$file") — not found"
  fi
}

# Upload ZIPs (update payloads) and DMGs (manual downloads)
upload "$RELEASE_DIR/2Code-$VERSION-arm64-mac.zip"  "2Code-$VERSION-arm64-mac.zip"
upload "$RELEASE_DIR/2Code-$VERSION-arm64-mac.zip.blockmap" "2Code-$VERSION-arm64-mac.zip.blockmap"
upload "$RELEASE_DIR/2Code-$VERSION-mac.zip"         "2Code-$VERSION-mac.zip"
upload "$RELEASE_DIR/2Code-$VERSION-mac.zip.blockmap" "2Code-$VERSION-mac.zip.blockmap"
upload "$RELEASE_DIR/2Code-$VERSION-arm64.dmg"       "2Code-$VERSION-arm64.dmg"
upload "$RELEASE_DIR/2Code-$VERSION-arm64.dmg.blockmap" "2Code-$VERSION-arm64.dmg.blockmap"
upload "$RELEASE_DIR/2Code-$VERSION.dmg"             "2Code-$VERSION.dmg"
upload "$RELEASE_DIR/2Code-$VERSION.dmg.blockmap"    "2Code-$VERSION.dmg.blockmap"

echo ""
echo "========================================"
echo "Uploading manifests (triggers auto-updates)"
echo "========================================"
echo ""

# Upload manifests LAST — uploading these is what tells existing users to update.
# ZIPs must be uploaded first or the download will fail.
upload "$RELEASE_DIR/latest-mac.yml"      "latest-mac.yml"
upload "$RELEASE_DIR/latest-mac-x64.yml"  "latest-mac-x64.yml"

echo ""
echo "========================================"
echo "✅ Upload complete — v$VERSION is live"
echo "   Users on older versions will see an update prompt within 1 minute."
echo "========================================"
