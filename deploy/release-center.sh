#!/usr/bin/env bash
set -euo pipefail

version=${1:?Version is required}
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Invalid version\n' >&2; exit 1; }
archive="/tmp/Lizi-Server-${version}.tar.gz"
releases=/opt/lizi-center/releases
target="$releases/Lizi-Server-${version}"
[[ -f "$archive" && ! -e "$target" ]] || { printf 'Archive missing or version directory already exists\n' >&2; exit 1; }
old_image=$(docker inspect lizi-server-server-1 --format '{{.Config.Image}}')
old_version=${old_image#lizi-server:}
[[ "$old_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { printf 'Cannot identify current release\n' >&2; exit 1; }
old_root="$releases/Lizi-Server-${old_version}"
[[ -f "$old_root/deploy/compose.yaml" ]] || { printf 'Previous release unavailable\n' >&2; exit 1; }
volume=$(docker volume inspect lizi-server_reports --format '{{.Mountpoint}}')
[[ "$volume" == /var/lib/docker/volumes/lizi-server_reports/_data ]] || { printf 'Unexpected data volume\n' >&2; exit 1; }
needed=$(du -sb "$volume" | cut -f1)
available=$(df -PB1 "$releases" | awk 'NR==2 {print $4}')
(( available > needed + 1073741824 )) || { printf 'Insufficient backup space\n' >&2; exit 1; }
backup="/opt/lizi-center/backups/$(date -u +%Y%m%d-%H%M%S)-before-${version}"
install -d -m 700 "$backup"
tar -xzf "$archive" -C "$releases"
docker compose -f "$target/deploy/compose.yaml" build
tar -czf "$backup/release.tar.gz" -C "$releases" "Lizi-Server-${old_version}"

rollback() {
  printf 'Deployment failed; starting previous release. Backup: %s\n' "$backup" >&2
  docker compose -f "$old_root/deploy/compose.yaml" up -d --wait --wait-timeout 120 || true
}
trap rollback ERR
docker stop --time 30 lizi-server-server-1
tar -czf "$backup/data.tar.gz" -C "$volume" .
docker compose -f "$target/deploy/compose.yaml" up -d --no-build --wait --wait-timeout 120
trap - ERR
printf 'Center %s is healthy. Backup: %s\n' "$version" "$backup"
