FROM node:22-bookworm-slim AS engine
WORKDIR /engine
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && node -e 'const fs=require("fs"); const a=process.arch==="x64"?"64":process.arch; fs.copyFileSync(require.resolve("@cloudflare/workerd-linux-"+a+"/bin/workerd"),"/engine/workerd")' \
 && chmod 0555 /engine/workerd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libatomic1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=engine /engine/workerd /usr/local/bin/workerd
USER 65532:65532
WORKDIR /bundle
ENTRYPOINT ["/usr/local/bin/workerd"]
