#!/bin/bash
set -euo pipefail

# Notarize and staple all DMGs in the release directory for the current version.
#
# Usage:
#   ./scripts/notarize-release.sh
#
# Prerequisites:
#   - Keychain profile "2code-notarize" must exist
#   - DMGs must already be built in release/
#
# Create the keychain profile with:
#   xcrun notarytool store-credentials "2code-notarize" \
#     --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
RELEASE_DIR="$ROOT_DIR/release"
KEYCHAIN_PROFILE="2code-notarize"

# Timeout for each notarization submission (45 minutes)
# Large DMGs (~270MB) take 5-10 min to upload + 5-15 min for Apple to process.
# 10 minutes was too short — timed out before Apple finished, leaving zombie
# "In Progress" submissions that never resolve.
TIMEOUT="45m"

echo "========================================"
echo "Notarizing 2Code v$VERSION"
echo "========================================"
echo ""

# Verify keychain profile exists
if ! xcrun notarytool history --keychain-profile "$KEYCHAIN_PROFILE" > /dev/null 2>&1; then
  echo "ERROR: Keychain profile '$KEYCHAIN_PROFILE' not found."
  echo ""
  echo "Create it with:"
  echo "  xcrun notarytool store-credentials \"$KEYCHAIN_PROFILE\" \\"
  echo "    --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID"
  exit 1
fi

# Track success/failure
FAILED=0

notarize_and_staple() {
  local dmg_path="$1"
  local dmg_name
  dmg_name="$(basename "$dmg_path")"

  if [ ! -f "$dmg_path" ]; then
    echo "WARNING: $dmg_name not found, skipping."
    return 0
  fi

  echo "Submitting $dmg_name for notarization..."
  echo "  (This may take 5-15 minutes per file)"
  echo ""

  # Submit and wait for result
  local output
  if ! output=$(xcrun notarytool submit "$dmg_path" \
    --keychain-profile "$KEYCHAIN_PROFILE" \
    --wait \
    --timeout "$TIMEOUT" 2>&1); then

    echo "ERROR: Notarization failed for $dmg_name"
    echo "$output"
    echo ""

    # Try to extract submission ID and fetch log
    local sub_id
    sub_id=$(echo "$output" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
    if [ -n "$sub_id" ]; then
      echo "Fetching notarization log for $sub_id..."
      xcrun notarytool log "$sub_id" --keychain-profile "$KEYCHAIN_PROFILE" 2>&1 || true
      echo ""
    fi

    FAILED=1
    return 1
  fi

  echo "$output"
  echo ""

  # Check if the result indicates success
  if echo "$output" | grep -q "status: Accepted"; then
    echo "Stapling notarization ticket to $dmg_name..."
    if xcrun stapler staple "$dmg_path"; then
      echo "  Done - $dmg_name is notarized and stapled."
    else
      echo "  WARNING: Stapling failed for $dmg_name (notarization succeeded)."
      echo "  Users can still run the app -- macOS will check online."
      FAILED=1
    fi
  else
    echo "ERROR: Notarization did not succeed for $dmg_name"
    echo "Status was not 'Accepted'. Check the output above."
    FAILED=1
    return 1
  fi

  echo ""
}

# Notarize both DMGs
echo "--- arm64 DMG ---"
notarize_and_staple "$RELEASE_DIR/2Code-$VERSION-arm64.dmg" || true

echo ""
echo "--- x64 DMG ---"
notarize_and_staple "$RELEASE_DIR/2Code-$VERSION.dmg" || true

echo ""
echo "========================================"
if [ "$FAILED" -eq 0 ]; then
  echo "All DMGs notarized and stapled successfully."
else
  echo "WARNING: One or more DMGs failed notarization."
  echo "Check the errors above and retry if needed."
  exit 1
fi
echo "========================================"
