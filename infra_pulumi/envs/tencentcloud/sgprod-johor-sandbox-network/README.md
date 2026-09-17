# Johor Sandbox Network

This stack creates only the dedicated Johor network fabric used by Singapore
production Sandbox pools. It deliberately does not create TKE, databases,
Redis, TCR, storage, monitoring, an internal model load balancer, or a
jumpserver.

Planned topology:

- VPC: `10.80.0.0/12`
- `pool-a`: `10.80.0.0/16`, `ap-johorbahru-1`
- `pool-b`: `10.81.0.0/16`, `ap-johorbahru-2`
- `support`: `10.95.192.0/18`, `ap-johorbahru-1`
- one managed NAT gateway with five traffic-billed EIPs
- one default route and one subnet SNAT rule per subnet
- multicast/broadcast disabled on every subnet
- one TAT-only Sandbox security group with no ingress rules

Preview is non-mutating:

```bash
cd infra_pulumi
GOWORK=off go run ./cmd/infractl preview --stack sgprod-johor-sandbox-network
```

`up` creates paid cloud resources and requires a separate explicit approval.
