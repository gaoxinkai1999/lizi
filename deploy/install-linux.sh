#!/usr/bin/env bash
set -euo pipefail
# Run from an extracted Lizi-Server archive or a repository with built web assets.
# This starts only the new central server. It never changes DNS, nginx or old FRP services.
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command -v docker >/dev/null || { echo 'Install Docker Engine and Compose first.' >&2; exit 1; }
docker compose version >/dev/null
[[ -f "$root/apps/web/dist/index.html" ]] || { echo 'Build the web app first: npm ci && npm run build' >&2; exit 1; }
docker compose -f "$root/deploy/compose.yaml" up -d --build --wait --wait-timeout 120
printf 'Central server started on loopback port %s. Configure an HTTPS reverse proxy separately.\n' "${LIZI_HTTP_PORT:-13211}"
echo 'Create the first admin using the one-time setup-token.txt inside the persistent /data volume.'
echo 'Existing sq.abocidee.com and FRP services have not been changed.'
