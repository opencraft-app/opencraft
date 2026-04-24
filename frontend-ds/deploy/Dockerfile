FROM node:22-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY index.html ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY src ./src

ARG VITE_AUTH_API_BASE_URL
ENV VITE_AUTH_API_BASE_URL="${VITE_AUTH_API_BASE_URL}"

RUN pnpm build

FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
