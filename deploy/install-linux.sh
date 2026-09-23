#!/usr/bin/env bash
set -euo pipefail
umask 077

# Usage: sudo bash deploy/install-linux.sh --domain reports.example.com --cert /path/fullchain.pem --key /path/privkey.pem [--token-file /secure/token] [--bind-port 17443] [--remote-port 13210]
# This owns only lizi-frps.service and /etc/nginx/conf.d/lizi.conf; it never edits another FRP service.
domain=''
cert=''
key=''
token_file=''
bind_port=17443
remote_port=13210
while (($#)); do
  case "$1" in
    --domain) domain="${2:?Missing domain}"; shift 2 ;;
    --cert) cert="${2:?Missing certificate path}"; shift 2 ;;
    --key) key="${2:?Missing key path}"; shift 2 ;;
    --token-file) token_file="${2:?Missing token path}"; shift 2 ;;
    --bind-port) bind_port="${2:?Missing bind port}"; shift 2 ;;
    --remote-port) remote_port="${2:?Missing remote port}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ $domain =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && $domain == *.* ]] || { echo 'A DNS domain is required.' >&2; exit 2; }
for port in "$bind_port" "$remote_port"; do
  [[ $port =~ ^[1-9][0-9]{3,4}$ ]] && ((port >= 1024 && port <= 65535)) || { echo 'Ports must be 1024-65535.' >&2; exit 2; }
done
[[ $bind_port != "$remote_port" ]] || { echo 'The FRP control and application ports must differ.' >&2; exit 2; }
[[ -f $cert && -f $key ]] || { echo 'Supply an existing valid public-CA certificate and private key.' >&2; exit 2; }
for command in curl tar sha256sum openssl nginx systemctl install useradd getent; do command -v "$command" >/dev/null || { printf 'Missing prerequisite: %s\n' "$command" >&2; exit 1; }; done
openssl x509 -in "$cert" -noout -checkhost "$domain" >/dev/null
openssl x509 -in "$cert" -noout -checkend 86400 >/dev/null
cert_public=$(openssl x509 -in "$cert" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
key_public=$(openssl pkey -in "$key" -pubout -outform DER | sha256sum)
[[ $cert_public == "$key_public" ]] || { echo 'Certificate and key do not match.' >&2; exit 2; }
version=0.68.0
case "$(uname -m)" in
  x86_64) arch=amd64; checksum=3cf934477f4fb1ee9e19e49c31fb33f5ffe3283300076f59afad8b8ccf1e1621 ;;
  aarch64|arm64) arch=arm64; checksum=8855bd3537adf6f456b4073a1fb6f119885060f3c8b714fd56a842db42b4c097 ;;
  *) echo 'Supported architectures: x86_64, aarch64.' >&2; exit 2 ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "https://github.com/fatedier/frp/releases/download/v${version}/frp_${version}_linux_${arch}.tar.gz" -o "$work/frp.tar.gz"
printf '%s  %s\n' "$checksum" "$work/frp.tar.gz" | sha256sum --check --status
tar -xzf "$work/frp.tar.gz" -C "$work"
getent passwd lizi-frp >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin lizi-frp
install -d -m 0755 /opt/lizi-frp
install -d -m 0750 -o root -g lizi-frp /etc/lizi-frp
install -m 0755 "$work/frp_${version}_linux_${arch}/frps" "/opt/lizi-frp/frps-${version}"
ln -sfn "frps-${version}" /opt/lizi-frp/frps
install -m 0644 "$work/frp_${version}_linux_${arch}/LICENSE" /opt/lizi-frp/LICENSE
install -m 0640 -o root -g lizi-frp "$cert" /etc/lizi-frp/server.crt
install -m 0640 -o root -g lizi-frp "$key" /etc/lizi-frp/server.key
if [[ -n $token_file ]]; then
  [[ -f $token_file ]] || { echo 'Token file not found.' >&2; exit 2; }
  token=$(tr -d '\r\n' < "$token_file")
elif [[ -f /etc/lizi-frp/token ]]; then
  token=$(cat /etc/lizi-frp/token)
else
  token=$(openssl rand -hex 32)
fi
[[ $token =~ ^[A-Za-z0-9_+=/.-]{24,4096}$ ]] || { echo 'Token must contain 24-4096 safe printable characters.' >&2; exit 2; }
printf '%s' "$token" > /etc/lizi-frp/token
unset token
chown root:lizi-frp /etc/lizi-frp/token
chmod 0640 /etc/lizi-frp/token
cat > /etc/lizi-frp/frps.toml <<EOF
bindAddr = "0.0.0.0"
bindPort = $bind_port
proxyBindAddr = "127.0.0.1"
allowPorts = [{ single = $remote_port }]
maxPortsPerClient = 1
auth.method = "token"
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/etc/lizi-frp/token"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
transport.tls.force = true
transport.tls.certFile = "/etc/lizi-frp/server.crt"
transport.tls.keyFile = "/etc/lizi-frp/server.key"
transport.maxPoolCount = 5
log.to = "console"
log.level = "info"
log.disablePrintColor = true
detailedErrorsToClient = false
EOF
chown root:lizi-frp /etc/lizi-frp/frps.toml
chmod 0640 /etc/lizi-frp/frps.toml
/opt/lizi-frp/frps verify -c /etc/lizi-frp/frps.toml
cat > /etc/systemd/system/lizi-frps.service <<'EOF'
[Unit]
Description=Lizi dedicated encrypted reverse proxy
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=lizi-frp
Group=lizi-frp
ExecStart=/opt/lizi-frp/frps -c /etc/lizi-frp/frps.toml
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
install -d -m 0755 /etc/nginx/conf.d
cat > "$work/lizi.conf" <<EOF
server {
    listen 80;
    server_name $domain;
    return 301 https://$domain\$request_uri;
}
server {
    listen 443 ssl;
    server_name $domain;
    ssl_certificate /etc/lizi-frp/server.crt;
    ssl_certificate_key /etc/lizi-frp/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:LiziTLS:10m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:$remote_port;
        proxy_http_version 1.1;
        proxy_set_header Host $domain;
        proxy_set_header X-Forwarded-Host $domain;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 120s;
    }
}
EOF
if [[ -f /etc/nginx/conf.d/lizi.conf ]]; then cp /etc/nginx/conf.d/lizi.conf "$work/lizi.previous"; fi
install -m 0644 "$work/lizi.conf" /etc/nginx/conf.d/lizi.conf
if ! nginx -t; then
  if [[ -f $work/lizi.previous ]]; then cp "$work/lizi.previous" /etc/nginx/conf.d/lizi.conf; else rm /etc/nginx/conf.d/lizi.conf; fi
  exit 1
fi
systemctl daemon-reload
systemctl enable lizi-frps.service
systemctl restart lizi-frps.service
systemctl reload nginx
systemctl is-active --quiet lizi-frps.service
printf 'Installed dedicated Lizi tunnel. Domain: https://%s; control: %s; loopback proxy: %s\n' "$domain" "$bind_port" "$remote_port"
printf 'Permit TCP 80,443,%s in the firewall. Do NOT expose %s. Token is root-protected at /etc/lizi-frp/token.\n' "$bind_port" "$remote_port"
