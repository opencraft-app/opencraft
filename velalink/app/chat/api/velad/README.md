# app/chat/api/velad

Proxy namespace for local `velad`.

The catch-all route forwards same-origin browser requests to the real daemon configured by `VELAD_BASE_URL` or `http://127.0.0.1:3857`.
