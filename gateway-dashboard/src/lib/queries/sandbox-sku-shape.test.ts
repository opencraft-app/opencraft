import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveSandboxTemplateClassWarnings,
  normalizeSandboxTemplateClassResolve,
} from "./sandbox-sku-shape.ts";

test("normalizeSandboxTemplateClassResolve keeps the served handler response shape stable", () => {
  const result = normalizeSandboxTemplateClassResolve({
    template_class: {
      id: "hermes",
      name: "Hermes",
      resolution_mode: "sandbox_primary",
      status: "active",
      created_at: "2026-05-18T00:00:00Z",
      updated_at: "2026-05-18T00:00:00Z",
    },
    bindings: null,
    pools: [
      {
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
      },
    ],
  });

  assert.equal(result.template_class?.id, "hermes");
  assert.deepEqual(result.bindings, []);
  assert.equal(result.pools[0]?.template_class_id, "");
  assert.equal(result.pools[0]?.sku_id, "");
});

test("deriveSandboxTemplateClassWarnings explains empty resolve and blocked rollout", () => {
  const warnings = deriveSandboxTemplateClassWarnings({
    templateClass: {
      id: "hermes",
      name: "Hermes",
      resolution_mode: "sandbox_primary",
      status: "active",
      created_at: "2026-05-18T00:00:00Z",
      updated_at: "2026-05-18T00:00:00Z",
    },
    skuBindings: [
      {
        template_class_id: "hermes",
        sku_id: "sku-hermes-2c4g",
        priority: 1,
        weight: 100,
        admission_state: "active",
        rollout_eligibility: true,
        created_at: "2026-05-18T00:00:00Z",
        updated_at: "2026-05-18T00:00:00Z",
      },
    ],
    poolBindings: [],
    resolvedPools: [],
    skus: [
      {
        id: "sku-hermes-2c4g",
        name: "Hermes 2C4G",
        template_class_id: "hermes",
        base_image: "img-1",
        desired_image_id: "img-2",
        stable_image_id: "img-1",
        instance_type: "SA5.MEDIUM4",
        rollout_state: "blocked",
        created_at: "2026-05-18T00:00:00Z",
        updated_at: "2026-05-18T00:00:00Z",
      },
    ],
  });

  assert.match(warnings.join("\n"), /没有可解析的 pool/);
  assert.match(warnings.join("\n"), /rollout_state=blocked/);
});

test("deriveSandboxTemplateClassWarnings reports pool bindings absent from resolve result", () => {
  const warnings = deriveSandboxTemplateClassWarnings({
    templateClass: null,
    skuBindings: [],
    poolBindings: [
      {
        template_class_id: "hermes",
        pool_id: "pool-missing",
        priority: 1,
        weight: 100,
        role: "primary",
        admission_state: "draining",
        created_at: "2026-05-18T00:00:00Z",
        updated_at: "2026-05-18T00:00:00Z",
      },
    ],
    resolvedPools: [],
    skus: [],
  });

  assert.match(warnings.join("\n"), /admission_state=draining/);
  assert.match(warnings.join("\n"), /未出现在 resolve 结果/);
});
