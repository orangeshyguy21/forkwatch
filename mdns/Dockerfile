# Forkwatch mDNS publisher. Advertises `forkwatch.local` on the LAN via the HOST's avahi daemon
# (reached over the host D-Bus socket). Runs with network_mode: host so it can detect the host's
# current LAN IP and so the advertised address is the host's. No root/sudo on the host required.
FROM alpine:3.20
RUN apk add --no-cache avahi-tools iproute2
COPY publish.sh /publish.sh
RUN chmod +x /publish.sh
ENV DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket
ENTRYPOINT ["/publish.sh"]
