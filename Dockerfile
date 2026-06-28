FROM rust:1-slim-bookworm AS cli-builder
RUN apt-get update && apt-get install -y \
  pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY libs/ ./libs/
COPY apps/ ./apps/
RUN cargo build --release \
  -p build-cli -p parse-cli -p nps-cli -p scraper-cli -p ia-cli

FROM node:22-slim AS frontend-builder
WORKDIR /app
COPY apps/rom-manager-ui/package.json apps/rom-manager-ui/package-lock.json ./
RUN npm ci
COPY apps/rom-manager-ui/ ./
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=cli-builder \
  /app/target/release/build-cli \
  /app/target/release/parse-cli \
  /app/target/release/nps-cli \
  /app/target/release/scraper-cli \
  /app/target/release/ia-cli \
  /usr/local/bin/

COPY apps/rom-manager-ui/package.json apps/rom-manager-ui/package-lock.json ./
COPY apps/rom-manager-ui/server/ ./server/
COPY --from=frontend-builder /app/dist/ ./dist/

RUN npm install --omit=dev --ignore-scripts

COPY icons/ /icons/

VOLUME /data
EXPOSE 3001
ENV NODE_ENV=production

CMD ["node", "server/index.js"]
