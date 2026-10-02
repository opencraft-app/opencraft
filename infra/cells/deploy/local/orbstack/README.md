# Rivet on OrbStack

This runs the smallest complete local Rivet data plane:

- Rivet Engine 2.3.10 on ports 6420 and 6421
- the upstream test Envoy/Runner on port 5050
- persistent file-system storage in the `rivet-orbstack-data` Docker volume

The Runner Dockerfile is kept here because the generated upstream
`self-host/compose/prod-file-system` template references a removed Dockerfile,
and the current replacement omits the `rivetkit-rust` Cargo workspace member.

Start or update:

```sh
docker volume create rivet-orbstack-data
docker compose -f deploy/local/orbstack/compose.yaml up -d --build
```

Check:

```sh
docker compose -f deploy/local/orbstack/compose.yaml ps
curl http://127.0.0.1:6421/health
```

Stop without deleting persisted state:

```sh
docker compose -f deploy/local/orbstack/compose.yaml down
```
