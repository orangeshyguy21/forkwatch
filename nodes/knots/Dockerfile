# Bitcoin Knots node image — pinned to v29.3.knots20260508 (the RDTS-enforcing side).
FROM debian:bookworm-slim AS fetch
ARG VERSION=29.3.knots20260508
ARG SHA256=70bd12fb56a2fe3908e0f44f7f142f77a55aabc8427bf00b61cfa4deedcf0899
ARG TARBALL=bitcoin-${VERSION}-x86_64-linux-gnu.tar.gz
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSLO "https://bitcoinknots.org/files/29.x/${VERSION}/${TARBALL}" \
 && echo "${SHA256}  ${TARBALL}" | sha256sum -c - \
 && tar -xzf "${TARBALL}" \
 && install -m0755 "bitcoin-${VERSION}/bin/bitcoind"    /usr/local/bin/bitcoind \
 && install -m0755 "bitcoin-${VERSION}/bin/bitcoin-cli" /usr/local/bin/bitcoin-cli \
 && rm -rf "${TARBALL}" "bitcoin-${VERSION}"

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 bitcoin && useradd -u 1000 -g 1000 -m -d /data bitcoin
COPY --from=fetch /usr/local/bin/bitcoind    /usr/local/bin/bitcoind
COPY --from=fetch /usr/local/bin/bitcoin-cli /usr/local/bin/bitcoin-cli
COPY entrypoint.sh /usr/local/bin/node-entrypoint.sh
RUN chmod +x /usr/local/bin/node-entrypoint.sh
USER bitcoin
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8332 8333 18443 18444 28332
ENTRYPOINT ["/usr/local/bin/node-entrypoint.sh"]
