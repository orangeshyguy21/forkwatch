# Bitcoin Core node image — pinned to v31.1 (the non-RDTS-enforcing side).
FROM debian:bookworm-slim AS fetch
ARG VERSION=31.1
ARG SHA256=b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e
ARG TARBALL=bitcoin-${VERSION}-x86_64-linux-gnu.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSLO "https://bitcoincore.org/bin/bitcoin-core-${VERSION}/${TARBALL}" \
 && echo "${SHA256}  ${TARBALL}" | sha256sum -c - \
 && tar -xzf "${TARBALL}" \
 && install -m0755 "bitcoin-${VERSION}/bin/bitcoind"    /usr/local/bin/bitcoind \
 && install -m0755 "bitcoin-${VERSION}/bin/bitcoin-cli" /usr/local/bin/bitcoin-cli \
 && rm -rf "${TARBALL}" "bitcoin-${VERSION}"

FROM debian:bookworm-slim
# openssl is used by the entrypoint to derive the rpcauth salted hash, so the RPC password never
# reaches a command line (where host `ps aux` would expose it).
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 bitcoin && useradd -u 1000 -g 1000 -m -d /data bitcoin
COPY --from=fetch /usr/local/bin/bitcoind    /usr/local/bin/bitcoind
COPY --from=fetch /usr/local/bin/bitcoin-cli /usr/local/bin/bitcoin-cli
COPY entrypoint.sh /usr/local/bin/node-entrypoint.sh
RUN chmod +x /usr/local/bin/node-entrypoint.sh
USER bitcoin
WORKDIR /data
VOLUME ["/data"]
# regtest 18443/18444 · mainnet 8332/8333 · ZMQ 28332. bitcoin.conf is bind-mounted into /data.
EXPOSE 8332 8333 18443 18444 28332
ENTRYPOINT ["/usr/local/bin/node-entrypoint.sh"]
