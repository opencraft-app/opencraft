# vela-runtime/tests/fixtures/scenarios

Runtime scenario fixtures live here.

Each fixture describes user command steps, per-turn scripted agent outputs, expected prompt order, and expected canonical event type order. These scenarios must stay backend-agnostic: use `BackendOutput` event names, not Pi-specific or CloudAgents-specific raw protocol as the assertion surface.

Scenario tests must assert:

- user input prompt order;
- ack status for every step;
- full canonical event type order;
- persisted backend output `event_type`, `payload`, and `raw` equality.
