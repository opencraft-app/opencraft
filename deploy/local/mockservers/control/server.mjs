import crypto from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

const REALNAME_CAPABILITY = "tencentcloud.faceid.id-card-verification";
const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECKSUM = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"];

function normalizeName(value) {
  return String(value || "").normalize("NFKC").trim();
}

function normalizeIDCard(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase();
}

export function identityAliasHash(name, idCard) {
  return crypto
    .createHash("sha256")
    .update(`${normalizeName(name)}\0${normalizeIDCard(idCard)}`, "utf8")
    .digest("hex");
}

function validIDCard(sequence) {
  const birthDate = new Date(Date.UTC(1980, 0, 1));
  birthDate.setUTCDate(
    birthDate.getUTCDate() + (Math.floor(sequence / 1000) % 7_305),
  );
  const datePart = birthDate.toISOString().slice(0, 10).replaceAll("-", "");
  const body = `110105${datePart}${String(sequence % 1000).padStart(3, "0")}`;
  const sum = [...body].reduce(
    (total, digit, index) => total + Number(digit) * ID_CARD_WEIGHTS[index],
    0,
  );
  return `${body}${ID_CARD_CHECKSUM[sum % 11]}`;
}

function userSummary(user) {
  return {
    mockUserId: user.mockUserId,
    displayName: user.displayName,
    scenarioId: user.scenarioId,
    createdAt: user.createdAt,
    lastSelectedAt: user.lastSelectedAt,
  };
}

function userDetail(user, developmentSMSCode) {
  return {
    ...userSummary(user),
    qqOpenId: user.qqOpenId,
    phone: user.phone,
    realname: {
      name: user.realnameName,
      idCard: user.realnameIDCard,
    },
    developmentSMSCode,
  };
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJSON(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) {
      throw new Error("request_too_large");
    }
  }
  if (!body) return {};
  return JSON.parse(body);
}

function pageParams(url) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get("page_size") || "20", 10) || 20),
  );
  return { page, pageSize };
}

function scenarioPreset(catalog, scenarioId, capabilityId) {
  const scenario = catalog.scenarios.get(scenarioId);
  const capability = catalog.capabilities.get(capabilityId);
  if (!scenario || !capability) return undefined;
  return (
    scenario.overrides?.[capabilityId]?.preset ||
    capability.defaultPreset
  );
}

export function createSyntheticUser(sequence, scenarioId) {
  const serial = String(sequence).padStart(6, "0");
  const realnameName = `本地用户${serial}`;
  const realnameIDCard = validIDCard(sequence);
  const now = new Date().toISOString();
  return {
    mockUserId: `local-user-${serial}`,
    displayName: `本地用户 ${serial}`,
    qqOpenId: `fake-qq-openid-local-user-${serial}`,
    phone: `139${String(sequence % 100_000_000).padStart(8, "0")}`,
    realnameName,
    realnameIDCard,
    identityAliasHash: identityAliasHash(realnameName, realnameIDCard),
    scenarioId,
    createdAt: now,
    lastSelectedAt: now,
  };
}

export class InMemoryMockStore {
  #users = [];
  #nextSequence = 1;

  async createBlankUser(scenarioId) {
    const user = createSyntheticUser(this.#nextSequence++, scenarioId);
    this.#users.unshift(user);
    return structuredClone(user);
  }

  async listUsers({ query = "", page = 1, pageSize = 20 } = {}) {
    const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();
    const matching = normalizedQuery
      ? this.#users.filter((user) =>
          `${user.mockUserId} ${user.displayName}`.toLowerCase().includes(normalizedQuery),
        )
      : this.#users;
    const start = (page - 1) * pageSize;
    return {
      items: matching
        .slice(start, start + pageSize)
        .map((user) => structuredClone(user)),
      total: matching.length,
    };
  }

  async getUser(mockUserId) {
    const user = this.#users.find((item) => item.mockUserId === mockUserId);
    return user ? structuredClone(user) : undefined;
  }

  async updateScenario(mockUserId, scenarioId) {
    const user = this.#users.find((item) => item.mockUserId === mockUserId);
    if (!user) return undefined;
    user.scenarioId = scenarioId;
    user.lastSelectedAt = new Date().toISOString();
    return structuredClone(user);
  }

  async findByIdentityAliasHash(aliasHash) {
    const user = this.#users.find((item) => item.identityAliasHash === aliasHash);
    return user ? structuredClone(user) : undefined;
  }
}

export function createMockControlServer({
  catalog,
  store,
  developmentSMSCode = "123456",
}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/scenarios") {
        const { page, pageSize } = pageParams(url);
        const query = (url.searchParams.get("q") || "").normalize("NFKC").trim().toLowerCase();
        const tag = (url.searchParams.get("tag") || "").trim();
        const matching = [...catalog.scenarios.values()].filter((scenario) => {
          const matchesQuery =
            !query ||
            `${scenario.id} ${scenario.name} ${scenario.description || ""}`
              .toLowerCase()
              .includes(query);
          const matchesTag = !tag || scenario.tags?.includes(tag);
          return matchesQuery && matchesTag;
        });
        const start = (page - 1) * pageSize;
        json(res, 200, {
          items: matching.slice(start, start + pageSize).map((scenario) => ({
            id: scenario.id,
            name: scenario.name,
            description: scenario.description || "",
            tags: scenario.tags || [],
          })),
          total: matching.length,
          page,
          pageSize,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/users") {
        const { page, pageSize } = pageParams(url);
        const result = await store.listUsers({
          query: url.searchParams.get("q") || "",
          page,
          pageSize,
        });
        json(res, 200, {
          items: result.items.map(userSummary),
          total: result.total,
          page,
          pageSize,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/users") {
        const input = await readJSON(req);
        const scenarioId = String(input.scenarioId || "full");
        if (!catalog.scenarios.has(scenarioId)) {
          json(res, 400, { error: "invalid_scenario" });
          return;
        }
        const user = await store.createBlankUser(scenarioId);
        json(res, 201, userDetail(user, developmentSMSCode));
        return;
      }

      const userMatch = url.pathname.match(/^\/v1\/users\/([^/]+)$/);
      if (req.method === "GET" && userMatch) {
        const user = await store.getUser(decodeURIComponent(userMatch[1]));
        if (!user) {
          json(res, 404, { error: "user_not_found" });
          return;
        }
        json(res, 200, userDetail(user, developmentSMSCode));
        return;
      }

      const scenarioMatch = url.pathname.match(
        /^\/v1\/users\/([^/]+)\/scenario$/,
      );
      if (req.method === "PUT" && scenarioMatch) {
        const input = await readJSON(req);
        const scenarioId = String(input.scenarioId || "");
        if (!catalog.scenarios.has(scenarioId)) {
          json(res, 400, { error: "invalid_scenario" });
          return;
        }
        const user = await store.updateScenario(
          decodeURIComponent(scenarioMatch[1]),
          scenarioId,
        );
        if (!user) {
          json(res, 404, { error: "user_not_found" });
          return;
        }
        json(res, 200, userSummary(user));
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/resolve") {
        const input = await readJSON(req);
        const capabilityId = String(input.capabilityId || "");
        const aliasHash = String(input.identityAliasHash || "");
        const capability = catalog.capabilities.get(capabilityId);
        if (!capability) {
          json(res, 400, { error: "unknown_capability" });
          return;
        }
        const user = await store.findByIdentityAliasHash(aliasHash);
        if (!user) {
          json(res, 404, { error: "identity_not_found" });
          return;
        }
        const preset = scenarioPreset(
          catalog,
          user.scenarioId || "full",
          capabilityId,
        );
        if (!preset || !capability.presets.has(preset)) {
          json(res, 500, { error: "invalid_scenario_preset" });
          return;
        }
        json(res, 200, {
          mockUserId: user.mockUserId,
          scenarioId: user.scenarioId || "full",
          preset,
        });
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (error) {
      const message =
        error instanceof SyntaxError ? "invalid_json" : "internal_error";
      json(res, message === "invalid_json" ? 400 : 500, { error: message });
    }
  });
}

async function main() {
  const [{ loadCatalog }, { MySQLMockStore }] = await Promise.all([
    import("./catalog.mjs"),
    import("./mysql-store.mjs"),
  ]);
  const catalog = await loadCatalog(
    process.env.MOCK_CONTROL_FIXTURES_DIR || "/app/fixtures",
  );
  const store = await MySQLMockStore.connect({
    host: process.env.MYSQL_HOST || "mysql",
    port: Number(process.env.MYSQL_PORT || "3306"),
    user: process.env.MYSQL_USER || "mock_control",
    password: process.env.MYSQL_PASSWORD || "local_mock_control",
    database: process.env.MYSQL_DATABASE || "mock_control",
  });
  const server = createMockControlServer({
    catalog,
    store,
    developmentSMSCode: process.env.MOCK_DEVELOPMENT_SMS_CODE || "123456",
  });
  const port = Number(process.env.MOCK_CONTROL_PORT || "19060");
  server.listen(port, "0.0.0.0", () => {
    console.log(`mock-control listening on :${port}`);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { REALNAME_CAPABILITY };
