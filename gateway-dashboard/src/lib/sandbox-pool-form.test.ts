import assert from "node:assert/strict";
import test from "node:test";

import {
  canSelectPoolSKU,
  defaultPoolFormValues,
  deriveTemplateClassID,
  poolCreatePayload,
  poolFormSchema,
  poolToFormValues,
  poolUpdatePayload,
} from "./queries/sandbox-pool-form.ts";
import type { SandboxPool } from "./queries/sandbox-pool-shape.ts";
import type { SandboxSKU } from "./queries/sandbox-sku-shape.ts";

const sku: SandboxSKU = {
  id: "sku-hermes-2c4g",
  name: "Hermes 2C4G",
  template_class_id: "hermes",
  base_image: "img-hermes",
  desired_image_id: "img-hermes",
  instance_type: "SA5.MEDIUM4",
  rollout_state: "stable",
  created_at: "2026-08-05T00:00:00Z",
  updated_at: "2026-08-05T00:00:00Z",
};

const legacyPool: SandboxPool = {
  id: "pool-legacy",
  name: "legacy",
  base_image: "img-hermes",
  desired_capacity: 3,
  instance_type: "SA2.MEDIUM4",
  status: "active",
  vpc_id: "vpc-1",
  subnet_id: "subnet-1",
  zone: "ap-singapore-4",
  security_groups: ["sg-1"],
  template_class_id: "",
  sku_id: "",
  created_at: "2026-08-05T00:00:00Z",
};

test("create defaults are paused with zero capacity", () => {
  const values = defaultPoolFormValues();
  assert.equal(values.status, "paused");
  assert.equal(values.desired_capacity, 0);
  assert.equal(values.sku_id, "");
});

test("form validation requires sku and concrete instance type", () => {
  const result = poolFormSchema.safeParse(defaultPoolFormValues());
  assert.equal(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    assert.ok(paths.includes("sku_id"));
    assert.ok(paths.includes("instance_type"));
  }
});

test("create payload includes sku and forces safe defaults", () => {
  const payload = poolCreatePayload({
    ...defaultPoolFormValues(),
    name: " pool-sg-sa2 ",
    base_image: " img-hermes ",
    instance_type: " SA2.MEDIUM4 ",
    sku_id: sku.id,
    vpc_id: " vpc-1 ",
    subnet_id: " subnet-1 ",
    zone: " ap-singapore-4 ",
    security_groups_text: "sg-1, sg-2",
    desired_capacity: 99,
    status: "active",
  });
  assert.equal(payload.sku_id, sku.id);
  assert.equal(payload.desired_capacity, 0);
  assert.equal(payload.status, "paused");
  assert.equal(payload.instance_type, "SA2.MEDIUM4");
  assert.deepEqual(payload.security_groups, ["sg-1", "sg-2"]);
});

test("template class is derived from selected sku", () => {
  assert.equal(deriveTemplateClassID([sku], sku.id), "hermes");
  assert.equal(deriveTemplateClassID([sku], "missing"), "");
});

test("legacy pool can select sku but bound pool cannot", () => {
  assert.equal(canSelectPoolSKU(legacyPool), true);
  const bound = { ...legacyPool, sku_id: sku.id, template_class_id: "hermes" };
  assert.equal(canSelectPoolSKU(bound), false);
  assert.equal(poolToFormValues(bound).sku_id, sku.id);
});

test("bound pool update preserves sku while allowing maintenance fields", () => {
  const bound = { ...legacyPool, sku_id: sku.id, template_class_id: "hermes" };
  const payload = poolUpdatePayload({
    ...poolToFormValues(bound),
    base_image: "img-maintained",
    instance_type: "S5.MEDIUM4",
    desired_capacity: 8,
  });
  assert.equal(payload.sku_id, sku.id);
  assert.equal(payload.base_image, "img-maintained");
  assert.equal(payload.instance_type, "S5.MEDIUM4");
  assert.equal(payload.desired_capacity, 8);
});
