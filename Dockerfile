FROM rust:1.86-alpine AS cli-build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY libs/rom-scraper libs/rom-scraper
COPY libs/rom-manager libs/rom-manager
COPY apps/scraper-cli apps/scraper-cli
COPY apps/parse-cli apps/parse-cli
COPY apps/build-cli apps/build-cli
RUN cargo build --release -p scraper-cli -p parse-cli -p build-cli && \
    cp target/release/scraper-cli /scraper-cli && \
    cp target/release/parse-cli /parse-cli && \
    cp target/release/build-cli /build-cli

FROM node:26-alpine AS ui-build
WORKDIR /app
COPY apps/rom-manager-ui/package*.json ./
RUN npm ci
COPY apps/rom-manager-ui/ ./
RUN npx vite build

FROM node:26-alpine
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=cli-build /scraper-cli /usr/local/bin/scraper-cli
COPY --from=cli-build /parse-cli /usr/local/bin/parse-cli
COPY --from=cli-build /build-cli /usr/local/bin/build-cli
COPY --from=ui-build /app/node_modules ./node_modules
COPY --from=ui-build /app/server ./server
COPY --from=ui-build /app/dist ./dist
ENV NODE_ENV=production
ENV SCRAPER_CLI_BINARY=/usr/local/bin/scraper-cli
ENV PARSE_CLI_BINARY=/usr/local/bin/parse-cli
ENV BUILD_CLI_BINARY=/usr/local/bin/build-cli
EXPOSE 3001
CMD ["node", "server/index.js"]
