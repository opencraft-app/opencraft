FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY deploy/static/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/client/dist/ /usr/share/nginx/html/

EXPOSE 8080

