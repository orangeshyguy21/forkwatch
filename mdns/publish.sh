#!/bin/sh
# Publish an mDNS A-record for the given name pointing at the host's current LAN IP, then block
# (avahi-publish holds the record for as long as it runs; restart:unless-stopped re-detects the IP
# on restart, so a DHCP change is picked up automatically).
set -e
NAME="${MDNS_NAME:-forkwatch.local}"

# Host's primary LAN IP (network_mode: host lets us read the host's routes/interfaces).
IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
[ -z "$IP" ] && IP="$(hostname -i 2>/dev/null | awk '{print $1}')"

if [ -z "$IP" ]; then
  echo "[mdns] could not determine host IP; retrying in 5s" >&2
  sleep 5
  exit 1
fi

echo "[mdns] publishing $NAME -> $IP"
exec avahi-publish -a -R "$NAME" "$IP"
