import type { KeyMaterial, SecretStore } from "./contract.js";

/** Runtime-neutral cases; the caller supplies fresh, empty stores per case. */
export interface SecretConformanceCase {
  readonly name: string;
  run(stores: { secrets: SecretStore; keys: KeyMaterial }): Promise<void>;
}

class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConformanceFailure";
  }
}
const equal = (actual: unknown, expected: unknown, what: string) => {
  const a = JSON.stringify(actual),
    e = JSON.stringify(expected);
  if (a !== e) throw new ConformanceFailure(`${what}: expected ${e}, received ${a}`);
};
async function rejects(action: () => Promise<unknown>, what: string) {
  try {
    await action();
  } catch (error) {
    if (error instanceof TypeError) return;
    throw new ConformanceFailure(`${what}: unexpected ${String(error)}`);
  }
  throw new ConformanceFailure(`${what}: expected a TypeError`);
}

export const SECRET_CONFORMANCE_CASES: readonly SecretConformanceCase[] = [
  {
    name: "secrets are set, replaced, resolved by name and deleted",
    async run({ secrets }) {
      equal(await secrets.get("API_KEY"), undefined, "absent");
      await secrets.set("API_KEY", "one");
      await secrets.set("OTHER", "two");
      await secrets.set("API_KEY", "three");
      equal([await secrets.get("API_KEY"), await secrets.get("OTHER")], ["three", "two"], "resolved");
      await secrets.delete("API_KEY");
      await secrets.delete("API_KEY");
      equal([await secrets.get("API_KEY"), await secrets.get("OTHER")], [undefined, "two"], "after delete");
    },
  },
  {
    name: "the stamp changes with every change and only then",
    async run({ secrets }) {
      const empty = await secrets.stamp();
      equal(await secrets.stamp(), empty, "stable while empty");
      await secrets.set("A", "1");
      const one = await secrets.stamp();
      if (one === empty) throw new ConformanceFailure("set did not change the stamp");
      equal(await secrets.stamp(), one, "stable after set");
      await secrets.set("A", "2");
      if ((await secrets.stamp()) === one) throw new ConformanceFailure("replace did not change the stamp");
    },
  },
  {
    name: "concurrent writes to different names are all retained",
    async run({ secrets }) {
      await Promise.all(Array.from({ length: 12 }, (_, i) => secrets.set(`K${i}`, `v${i}`)));
      equal(
        await Promise.all(Array.from({ length: 12 }, (_, i) => secrets.get(`K${i}`))),
        Array.from({ length: 12 }, (_, i) => `v${i}`),
        "all",
      );
    },
  },
  {
    name: "invalid names and values are rejected",
    async run({ secrets }) {
      for (const name of ["", "1A", "A-B", "a/b"])
        await rejects(() => secrets.get(name), `name ${JSON.stringify(name)}`);
      for (const value of ["", "a\nb", "a\0b"])
        await rejects(() => secrets.set("A", value), `value ${JSON.stringify(value)}`);
    },
  },
  {
    name: "key material is created once and concurrent creators converge",
    async run({ keys }) {
      equal(await keys.read("vault.key"), undefined, "absent");
      let created = 0;
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => keys.ensure("vault.key", () => (created++, new Uint8Array([i + 1, 7, 7])))),
      );
      const first = [...results[0]!];
      for (const result of results) equal([...result], first, "converged");
      equal([...(await keys.read("vault.key"))!], first, "stored");
      equal([...(await keys.ensure("vault.key", () => new Uint8Array([9])))], first, "never replaced");
      if (created < 1) throw new ConformanceFailure("creator never ran");
      await rejects(() => keys.read("../x"), "path-like key");
    },
  },
];
