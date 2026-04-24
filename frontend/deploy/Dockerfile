FROM node:22-alpine AS build

WORKDIR /frontend

COPY package.json pnpm-lock.yaml .npmrc ./

COPY index.html ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY vendor ./vendor

ARG VITE_AUTH_API_BASE_URL
ENV VITE_AUTH_API_BASE_URL="${VITE_AUTH_API_BASE_URL}"

RUN corepack enable && cd /frontend && pnpm install && pnpm build

FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /frontend/dist /usr/share/nginx/html

EXPOSE 8080
