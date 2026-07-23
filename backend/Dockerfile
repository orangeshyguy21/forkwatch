# Backend-only image (serves STATIC_DIR if present). Build context = backend/.
FROM rust:1-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/forkwars-backend /usr/local/bin/forkwars-backend
ENV STATIC_DIR=/app/static
EXPOSE 8080
ENTRYPOINT ["forkwars-backend"]
