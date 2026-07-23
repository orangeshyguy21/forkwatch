# Backend-only image (serves STATIC_DIR if present). Build context = backend/.
FROM rust:1-slim-bookworm AS build
WORKDIR /app
# Dependency layer first; Cargo.lock copied and --locked enforced so builds are reproducible.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin forkwars
COPY --from=build /app/target/release/forkwars-backend /usr/local/bin/forkwars-backend
# See the root Dockerfile: an EXISTING root-owned volume needs a one-time chown to uid 10001.
RUN mkdir -p /data && chown forkwars:forkwars /data
ENV STATIC_DIR=/app/static
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=4 \
  CMD curl -fsS http://127.0.0.1:8080/health/ready >/dev/null || exit 1
USER forkwars
ENTRYPOINT ["forkwars-backend"]
