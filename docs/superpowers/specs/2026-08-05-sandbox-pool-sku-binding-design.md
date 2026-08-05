# Sandbox Pool SKU Binding Design

## Goal

Allow operators to create allocatable Sandbox pools from Gateway Dashboard without creating an intermediate legacy pool that refills capacity but cannot receive Hermes traffic.

## Decisions

- New pools must select an existing SKU.
- The API derives `template_class_id` from the selected SKU; clients do not choose or author this relationship.
- A SKU is the logical product shape. A pool's `instance_type` is its concrete supply implementation, so `SA2.MEDIUM4`, `S5.MEDIUM4`, and `SA5.MEDIUM4` pools may all serve `sku-hermes-2c4g` when operators have verified that they satisfy the same 2C4G contract.
- New pools are always created as `paused` with `desired_capacity=0`. Operators explicitly set capacity and activate them after checking image, network, and quota.
- Existing unbound pools may be bound once through the edit flow. An existing non-empty `sku_id` and its derived `template_class_id` are immutable; changing that logical assignment requires creating a new pool.
- Existing bound and legacy pools remain readable and otherwise editable.
- Binding immutability does not freeze infrastructure maintenance fields. Operators may continue changing `instance_type`, image, network, security groups, status, and capacity through the existing edit flow.

## API Contract

### Create pool

Both pool administration surfaces, `POST /internal/pools` and the legacy `POST /pools`, add a required `sku_id` field and use the same service contract.

The API:

1. Rejects a missing or unknown SKU.
2. Loads the SKU and its Template Class from Sandbox storage.
3. Requires an active Template-Class-to-SKU binding that is rollout eligible.
4. Creates the pool with the requested infrastructure fields and `instance_type`.
5. Inserts the initial pool row with the requested infrastructure fields, `instance_type`, `pool.sku_id`, the SKU's `template_class_id`, and the forced-safe defaults in one store call. The implementation must not use create-then-patch.
6. Overrides requested status and capacity with `paused` and `0`.

### Update pool

Both `PATCH /internal/pools/{pool_id}` and `PATCH /pools/{pool_id}` accept an optional `sku_id` and use the same binding validation.

- An unbound pool may set a valid SKU and receives the derived Template Class.
- A bound pool may repeat its current SKU idempotently.
- Clearing or changing a non-empty SKU is rejected.
- Other existing pool update behavior remains unchanged.

Errors use HTTP 400 on both administration surfaces with these canonical `error` values:

- missing `sku_id`: `invalid pool sku binding: sku_id is required`;
- unknown `sku_id`: `invalid pool sku binding: sku_id not found`;
- absent or inactive binding: `invalid pool sku binding: sku binding is not active`;
- rollout-ineligible binding: `invalid pool sku binding: sku binding is not rollout eligible`;
- clearing or changing a bound pool: `invalid pool sku binding: existing sku_id cannot be cleared or changed`.

## Dashboard

- The create dialog loads Sandbox SKUs and requires a SKU selection.
- Selecting a SKU displays its Template Class as read-only derived data.
- Create mode fixes status to `paused` and desired capacity to `0`; those controls are not presented as editable creation inputs.
- Edit mode offers SKU selection only for an unbound legacy pool. Bound pools show their SKU and Template Class as read-only.
- The dashboard sends `sku_id`; it does not send `template_class_id`.

## Allocation Behavior

The existing worker and allocator require no changes. Once persisted:

- the worker refills the pool only after an operator activates it and raises desired capacity;
- `resolvePoolsForTemplateSKUs` includes the pool because its `sku_id` matches the requested SKU;
- CTL requests for `hermes + sku-hermes-2c4g` can allocate from the new pool.

## Compatibility

- No schema migration is required; both binding columns already exist on `pools`.
- Existing pools are not modified automatically.
- Existing API clients creating pools without `sku_id` will receive HTTP 400. The operator dashboard is the supported creation client and is released together with Sandbox API.
- Sandbox workers do not need a new release for this feature.

## Verification

Backend tests cover:

- missing, unknown, and inactive SKU rejection;
- valid SKU deriving Template Class;
- forced `paused` and zero capacity on create;
- no pool row after a rejected create, proving validation happens before insertion;
- one-time binding of a legacy pool;
- idempotent same-SKU updates and rejection of clearing or changing a binding.
- successful image, `instance_type`, network, security-group, status, and capacity maintenance on an already bound pool;
- contract parity between `/internal/pools` and `/pools`.

Dashboard tests cover:

- create payload includes `sku_id` and safe defaults;
- Template Class is derived from the selected SKU;
- create validation requires a SKU;
- create mode omits editable status and capacity controls;
- unbound edit offers one-time selection while bound edit renders SKU and Template Class read-only;
- bound edit payloads preserve SKU while allowing infrastructure maintenance fields to change.

Release verification checks that a newly created paused pool contains the expected `template_class_id` and `sku_id`, then confirms it becomes a Hermes candidate only after explicit activation and capacity configuration.
