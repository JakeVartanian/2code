#!/bin/bash
# Build the raise-fd-limit native addon for the current Electron version.
#
# Usage: ./build.sh
#
# Requires: node-gyp, python3
# Installs the built .node file to resources/native/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/resources/native"

# Get Electron version from package.json
ELECTRON_VERSION=$(node -e "console.log(require('$PROJECT_ROOT/package.json').devDependencies.electron.replace('^','').replace('~',''))")
echo "Building for Electron $ELECTRON_VERSION"

cd "$SCRIPT_DIR"

# Build for current architecture
npx node-gyp rebuild \
  --target="$ELECTRON_VERSION" \
  --arch="$(uname -m)" \
  --dist-url=https://electronjs.org/headers

# Copy built addon to resources
mkdir -p "$OUTPUT_DIR"
cp "$SCRIPT_DIR/build/Release/raise_fd_limit.node" "$OUTPUT_DIR/raise-fd-limit.node"

echo "Built: $OUTPUT_DIR/raise-fd-limit.node"
