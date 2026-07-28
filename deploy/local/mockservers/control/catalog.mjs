import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

async function yamlFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function readYAML(file) {
  return parse(await fs.readFile(file, "utf8"));
}

export async function loadCatalog(root) {
  const capabilities = new Map();
  for (const file of await yamlFiles(path.join(root, "capabilities"))) {
    const document = await readYAML(file);
    for (const item of document.capabilities || []) {
      if (!item.id || capabilities.has(item.id)) {
        throw new Error(`invalid or duplicate capability in ${file}`);
      }
      const presets = new Set(item.presets || []);
      if (!presets.has(item.defaultPreset)) {
        throw new Error(
          `default preset ${item.defaultPreset} is not declared for ${item.id}`,
        );
      }
      capabilities.set(item.id, {
        id: item.id,
        provider: item.provider,
        defaultPreset: item.defaultPreset,
        presets,
        sourcePath: file,
      });
    }
  }

  const scenarios = new Map();
  for (const file of await yamlFiles(path.join(root, "scenarios"))) {
    const item = await readYAML(file);
    if (!item.id || scenarios.has(item.id)) {
      throw new Error(`invalid or duplicate scenario in ${file}`);
    }
    const overrides = item.overrides || {};
    for (const [capabilityId, override] of Object.entries(overrides)) {
      const capability = capabilities.get(capabilityId);
      if (!capability) {
        throw new Error(
          `unknown capability ${capabilityId} in scenario ${item.id}`,
        );
      }
      if (!capability.presets.has(override.preset)) {
        throw new Error(
          `unknown preset ${override.preset} for ${capabilityId} in scenario ${item.id}`,
        );
      }
    }
    scenarios.set(item.id, {
      id: item.id,
      name: item.name || item.id,
      description: item.description || "",
      tags: item.tags || [],
      overrides,
      sourcePath: file,
    });
  }

  if (!scenarios.has("full")) {
    throw new Error("scenario catalog must define full");
  }

  return { capabilities, scenarios };
}
