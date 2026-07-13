#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
ls src/models/BoardingEvent.* >/dev/null 2>&1
ls src/utils/qrToken.* >/dev/null 2>&1
grep -Rq 'boarding/scan' src/routes
grep -Eq 'QR_JWT_SECRET' .env.example
grep -Eq '"expo-server-sdk"' package.json
grep -Eqi 'boarding|attendance|qr' docs/TESTING_GUIDE.md
npm run test:integration
echo "COMPLETION OK: todo-001 (backend qr foundation)"
