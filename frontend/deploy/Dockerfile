FROM node:22-alpine AS build

WORKDIR /frontend

COPY package.json pnpm-lock.yaml .npmrc ./

COPY index.html ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY vendor ./vendor

ARG VITE_AUTH_API_BASE_URL
ENV VITE_AUTH_API_BASE_URL="${VITE_AUTH_API_BASE_URL}"
ARG VITE_AEGIS_ENABLED=true
ARG VITE_AEGIS_ID=4e66EF5XoPEXx3y8lw
ARG VITE_AEGIS_HOST_URL=https://rumt-zh.com
ENV VITE_AEGIS_ENABLED="${VITE_AEGIS_ENABLED}"
ENV VITE_AEGIS_ID="${VITE_AEGIS_ID}"
ENV VITE_AEGIS_HOST_URL="${VITE_AEGIS_HOST_URL}"

RUN corepack enable && corepack prepare pnpm@10.23.0 --activate && cd /frontend && pnpm install --frozen-lockfile && pnpm build

FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /frontend/dist /usr/share/nginx/html

EXPOSE 8080
