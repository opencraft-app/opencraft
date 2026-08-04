FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY deploy/devcloud/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/client/dist/ /usr/share/nginx/html/

EXPOSE 8080
