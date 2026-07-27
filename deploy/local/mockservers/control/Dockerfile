FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.mjs catalog.mjs mysql-store.mjs ./
COPY fixtures ./fixtures

USER node

EXPOSE 19060

CMD ["node", "server.mjs"]
