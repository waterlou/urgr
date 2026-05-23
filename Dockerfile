FROM rust:1.86-alpine AS cli-build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY libs/rom-scraper libs/rom-scraper
COPY libs/rom-manager libs/rom-manager
COPY apps/rom-scraper-cli apps/rom-scraper-cli
RUN cargo build --release -p rom-scraper-cli && \
    cp target/release/rom-scraper-cli /rom-scraper-cli

FROM node:26-alpine AS ui-build
WORKDIR /app
COPY apps/rom-manager-ui/package*.json ./
RUN npm ci
COPY apps/rom-manager-ui/ ./
RUN npx vite build

FROM node:26-alpine
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=cli-build /rom-scraper-cli /usr/local/bin/rom-scraper-cli
COPY --from=ui-build /app/node_modules ./node_modules
COPY --from=ui-build /app/server ./server
COPY --from=ui-build /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
