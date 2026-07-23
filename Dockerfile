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
COPY backend/Cargo.toml ./
COPY backend/src ./src
RUN cargo build --release    # -> /app/target/release/forkwars-backend

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=backend  /app/target/release/forkwars-backend /usr/local/bin/forkwars-backend
COPY --from=frontend /fe/dist /app/static
ENV STATIC_DIR=/app/static
EXPOSE 8080
ENTRYPOINT ["forkwars-backend"]
