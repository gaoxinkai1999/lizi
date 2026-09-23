#!/usr/bin/env bash
set -euo pipefail
umask 077
# Certbot deploy hook example: bash /path/to/deploy/refresh-certificates.sh "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem"
[[ $EUID -eq 0 && $# -eq 2 ]] || { echo 'Usage (as root): refresh-certificates.sh fullchain.pem privkey.pem' >&2; exit 2; }
certificate=$1
private_key=$2
openssl x509 -in "$certificate" -noout -checkend 86400 >/dev/null
cert_public=$(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
key_public=$(openssl pkey -in "$private_key" -pubout -outform DER | sha256sum)
[[ $cert_public == "$key_public" ]] || { echo 'Certificate and key do not match.' >&2; exit 2; }
install -m 0640 -o root -g lizi-frp "$certificate" /etc/lizi-frp/server.crt.new
install -m 0640 -o root -g lizi-frp "$private_key" /etc/lizi-frp/server.key.new
cp -p /etc/lizi-frp/server.crt /etc/lizi-frp/server.crt.previous
cp -p /etc/lizi-frp/server.key /etc/lizi-frp/server.key.previous
mv /etc/lizi-frp/server.crt.new /etc/lizi-frp/server.crt
mv /etc/lizi-frp/server.key.new /etc/lizi-frp/server.key
if ! nginx -t; then
  mv /etc/lizi-frp/server.crt.previous /etc/lizi-frp/server.crt
  mv /etc/lizi-frp/server.key.previous /etc/lizi-frp/server.key
  exit 1
fi
systemctl reload nginx
systemctl restart lizi-frps.service
rm /etc/lizi-frp/server.crt.previous /etc/lizi-frp/server.key.previous
systemctl is-active --quiet lizi-frps.service
