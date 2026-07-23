# Forkwars combined app image: build the React frontend + Rust backend, runtime serves both
# on one port (the backend serves the built SPA from STATIC_DIR). Build context = repo root.

FROM node:20-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build            # -> /fe/dist

FROM rust:1-slim-bookworm AS backend
WORKDIR /app
# Dependency layer first: a source-only edit must not rebuild the whole dependency graph.
# Cargo.lock is copied and --locked enforced, so the image is reproducible and a broken or
# compromised semver-compatible release cannot land without a lockfile change.
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src
COPY backend/src ./src
# Touch so cargo rebuilds the bin after the stub above (mtime, not content, drives it).
RUN touch src/main.rs && cargo build --release --locked   # -> /app/target/release/forkwars-backend

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin forkwars
COPY --from=backend  /app/target/release/forkwars-backend /usr/local/bin/forkwars-backend
COPY --from=frontend /fe/dist /app/static
# DB_PATH's directory, pre-owned so a FRESH named volume inherits the right ownership.
# An EXISTING root-owned volume does not: chown it once before first start with
#   docker run --rm -v <volume>:/data alpine chown -R 10001:10001 /data
RUN mkdir -p /data && chown forkwars:forkwars /data
ENV STATIC_DIR=/app/static
EXPOSE 8080
# Readiness, not liveness: a container whose ingest has stalled serves stale data and should be
# reported unhealthy even though the process is fine.
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=4 \
  CMD curl -fsS http://127.0.0.1:8080/health/ready >/dev/null || exit 1
USER forkwars
ENTRYPOINT ["forkwars-backend"]
