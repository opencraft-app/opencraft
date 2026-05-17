import test from "node:test";
import assert from "node:assert/strict";
import {
  isLegacySandboxPool,
  normalizeSandboxPool,
  normalizeSandboxPools,
} from "./sandbox-pool-shape.ts";

test("normalizeSandboxPool makes legacy binding fields explicit", () => {
  const pool = normalizeSandboxPool({
    id: "pool-1",
    name: "legacy",
    base_image: "img-1",
    desired_capacity: 1,
    instance_type: "SA5.MEDIUM4",
    status: "active",
    vpc_id: "vpc-1",
    subnet_id: "subnet-1",
    zone: "ap-shanghai-5",
    created_at: "2026-05-18T00:00:00Z",
  });

  assert.equal(pool.template_class_id, "");
  assert.equal(pool.sku_id, "");
  assert.equal(isLegacySandboxPool(pool), true);
});

test("normalizeSandboxPool trims binding fields", () => {
  const pool = normalizeSandboxPool({
    id: "pool-1",
    name: "bound",
    base_image: "img-1",
    desired_capacity: 1,
    instance_type: "SA5.MEDIUM4",
    status: "active",
    vpc_id: "vpc-1",
    subnet_id: "subnet-1",
    zone: "ap-shanghai-5",
    template_class_id: " hermes ",
    sku_id: " sku-hermes-2c4g ",
    created_at: "2026-05-18T00:00:00Z",
  });

  assert.equal(pool.template_class_id, "hermes");
  assert.equal(pool.sku_id, "sku-hermes-2c4g");
  assert.equal(isLegacySandboxPool(pool), false);
});

test("normalizeSandboxPools converts null to an empty list", () => {
  assert.deepEqual(normalizeSandboxPools(null), []);
});
