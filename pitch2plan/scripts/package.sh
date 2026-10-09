#!/bin/sh
# Usage: scripts/package.sh <zip-name>   — zips the repo (no node_modules/build output/secrets) into /mnt/user-data/outputs
set -e
cd "$(dirname "$0")/.."
OUT="/mnt/user-data/outputs/$1"
rm -f "$OUT"
zip -qr "$OUT" . -x 'node_modules/*' '*/node_modules/*' '.next/*' '*/.next/*' 'packages/db/src/generated/*' '.env' '*.tsbuildinfo' '*/next-env.d.ts' 'test-results/*' 'playwright-report/*'
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
