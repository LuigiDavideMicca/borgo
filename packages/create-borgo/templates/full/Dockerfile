# multi-stage build: go + bun in the builder, a small bun runtime image.
# the front server renders pages from source, so the runtime keeps pages/
# and production node_modules; go ships as one static binary in dist/.
FROM golang:1.25 AS build
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
ENV CGO_ENABLED=0
RUN bun run build

RUN mkdir /out \
 && cp -r package.json bun.lock index.html public pages .borgo dist /out/ \
 && for d in islands components lib; do [ -d "$d" ] && cp -r "$d" /out/; done; \
    cd /out && bun install --production

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production
# bun's outbound fetch pool defaults to 256 requests, and the front server
# holds one for the life of every proxied request - an event stream included.
# it must be set in the environment: bun reads it when the process starts
ENV BUN_CONFIG_MAX_HTTP_REQUESTS=16384
RUN mkdir /data && chown bun:bun /data
USER bun
COPY --from=build --chown=bun:bun /out /app
EXPOSE 3000
# borgo start supervises both processes: the go api and the bun front server
CMD ["bun", "run", "start"]
