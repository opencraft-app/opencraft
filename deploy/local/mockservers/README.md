# Local Mock Servers

Mock servers in this directory are development-only external dependencies for
the local Compose and Kubernetes stacks.

They emulate third-party services that are required to exercise full local
browser flows without real cloud or production credentials. Business services
such as Trade, Shadow, and CloudLadder Gateway remain real local processes.

`control` is the localstack-only mock control plane. Capability and scenario
definitions remain versioned YAML files; MySQL stores only generated local
users and each user's current scenario. The default `full` scenario delegates
unspecified behavior to each capability's success preset. Scenario changes
affect future calls and never rewrite state that has already occurred.

`qq-oauth` uses `control` only when `MOCK_CONTROL_BASE_URL` is set. In that
mode its authorization page can create a blank user or select an existing user,
choose a scenario, and display the synthetic identity fixture before OAuth
continues. Without that variable it retains the legacy Compose immediate
redirect.

`tencentcloud` resolves supported provider behavior through `control` when the
same variable is present. The first declared capability is
`tencentcloud.faceid.id-card-verification`, with `success` and
`identity-mismatch` presets. Without `control`, its legacy successful response
remains unchanged.

`wechat-pay-bridge` models only the external scan/OpenID return hop. It never
contacts WeChat or a real cashier and does not replace CTL, Trade, or Jifei.

`jifei` persists generated deal context and fulfillment status in SQLite. The
Kubernetes localstack mounts that database from the `fake-jifei-data` PVC and
uses a single-replica `Recreate` deployment, so payment and callback state
survives Pod rollouts without introducing another shared database dependency.

`envd` implements the gRPC-Web process lifecycle CTL needs while onboarding a
local fake sandbox. It stores only sandbox IDs, executable names, argument
counts, command hashes, and terminal status in MySQL; command bodies and API
keys are never persisted.
