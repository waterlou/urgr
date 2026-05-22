# syntax=docker/dockerfile:1
FROM rust:1.86-alpine AS build

RUN apk add --no-cache musl-dev

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY libs/rom-scraper libs/rom-scraper
COPY apps/rom-scraper-cli apps/rom-scraper-cli

RUN cargo build --release -p rom-scraper-cli && \
    cp target/release/rom-scraper-cli /rom-scraper-cli

FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

COPY --from=build /rom-scraper-cli /usr/local/bin/rom-scraper-cli

VOLUME ["/roms", "/config"]
WORKDIR /roms

ENTRYPOINT ["rom-scraper-cli"]
