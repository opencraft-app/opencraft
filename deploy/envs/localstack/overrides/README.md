# Local Secret Overrides

Files in this directory are optional, developer-local replacements for the
checked-in `secrets.defaults.env` files under `deploy/localstack`.

Use the component name as the filename, for example:

```text
infrastructure.env
auth.env
payment.env
subscription.env
ai-gateway.env
sandbox.env
service-gateway.env
```

An override file must contain the complete Secret payload for that component.
All `*.env` files in this directory are ignored by Git.
