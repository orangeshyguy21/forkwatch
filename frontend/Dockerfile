# Build stage for the Forkwars React bundle.
# The Rust backend serves the resulting /app/dist at the same origin.
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# The output is /app/dist. Backend images copy it via a multi-stage build, e.g.:
#   COPY --from=frontend /app/dist /srv/www
# This stage can also be consumed directly for artifact extraction.
FROM scratch AS dist
COPY --from=build /app/dist /dist
