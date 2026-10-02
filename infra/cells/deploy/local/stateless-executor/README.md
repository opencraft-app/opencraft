# Local stateless execution plane

`up.sh` renders the production stateless executor image and wrapper ABI into the deterministic
three-k3d topology. Each runtime Cell receives its own executor, workerd, and Object Router
capability. The Hub receives only the four capabilities needed by Workers API.

The local topology deliberately uses one executor replica per Cell and static Docker-network
serving origins. Production continues to use three replicas, independent stateless node pools,
private CLBs, and UID-bound `CellServingRoute` records.

```sh
bash infra/cells/deploy/local/stateless-executor/up.sh
```
