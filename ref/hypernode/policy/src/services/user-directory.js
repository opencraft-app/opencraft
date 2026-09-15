import { Service } from "@deepseek-ai/cordis";
import { uuidV4 } from "./device-identity.ts";
import { startedTurnProjection, streamedAgentStartItem } from "./turn-lifecycle.ts";
import { threadStartedProjection } from "./thread-protocol.ts";

const FIRST_DYNAMIC_UID = 20000;

function normalizedUsername(value) {
  const username = String(value ?? "").trim();
  if (!username) throw new Error("SSH username is required");
  return username;
}

function userId(username) {
  // Preserve the bootstrap root identity and its existing durable threads.
  return username === "root" ? "node:root" : `user:${username}`;
}

function remoteHost(remoteAddr) {
  const value = String(remoteAddr ?? "").trim();
  if (!value) return null;
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const ipv4 = value.match(/^(.+):(\d+)$/);
  return ipv4 ? ipv4[1] : value;
}

function safeHomeSegment(username) {
  const readable = username.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "user";
  return `${readable}-${crypto.sha256(username).slice(0, 10)}`;
}

function agentStarted(record, item, startedAtMs) {
  return {
    threadId: record.threadId,
    turnId: record.turn.id,
    item: { ...item },
    startedAtMs,
  };
}

function agentCompleted(record, item, completedAtMs) {
  return {
    threadId: record.threadId,
    turnId: record.turn.id,
    item,
    completedAtMs,
  };
}

export function onboardingWelcomeText(identity, user, { debug = false } = {}) {
  const lines = [`你好 ${identity.username}，欢迎登录 Hypernode。`];
  if (debug) lines.push("当前为调试模式，允许 SSH 无密钥登录。");
  lines.push("");
  if (user?.codexBindingState === "bound") {
    lines.push("已检测到你的 Codex 凭据；你也可以继续使用平台公共模型。");
  } else {
    lines.push(
      "平台公共模型已经可用，可以直接开始聊天，无需先绑定 ChatGPT/Codex 账户。",
      "如需使用 Codex 订阅模型，可稍后打开「☁️ 管理员」并选择「添加 Codex 账户」；凭据只保存在你的私有 CODEX_HOME。",
    );
  }
  return lines.join("\n");
}

export class UserDirectoryService extends Service {
  constructor(ctx) {
    super(ctx, "userDirectory");
    this.fallback = new Map();
    this.authenticatedConnections = new Map();
    this.ensureSchema(ctx.storage);
    ctx.effect(() => ctx.appServer.onInitialize((connection) => this.login(connection)));
    ctx.effect(() => ctx.appServer.onClose((connection) => {
      this.completeWelcome(connection, false);
      if (connection.connectionId) this.authenticatedConnections.delete(connection.connectionId);
    }));
    ctx.effect(() => ctx.appServer.register("hypernode/users/read", () => ({ users: this.list() })));
  }

  ensureSchema(storage) {
    if (!storage.available) return;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        authentication TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        last_login_at_ms INTEGER NOT NULL,
        login_count INTEGER NOT NULL
      )
    `);
    const columns = new Set(storage.sql.exec("PRAGMA table_info(do_users)").toArray().map((row) => row.name));
    const hadOnboardingWelcome = columns.has("onboarding_welcomed_at_ms");
    for (const [name, definition] of [
      ["ssh_public_key", "TEXT"],
      ["ssh_key_fingerprint", "TEXT"],
      ["ssh_key_issued_at_ms", "INTEGER"],
      ["linux_uid", "INTEGER"],
      ["linux_gid", "INTEGER"],
      ["home_path", "TEXT"],
      ["codex_home", "TEXT"],
      ["installation_id", "TEXT"],
      ["codex_binding_state", "TEXT"],
      ["codex_auth_mode", "TEXT"],
      ["codex_account_email", "TEXT"],
      ["codex_plan_type", "TEXT"],
      ["codex_credential_ref", "TEXT"],
      ["codex_bound_at_ms", "INTEGER"],
      ["codex_last_verified_at_ms", "INTEGER"],
      ["onboarding_welcomed_at_ms", "INTEGER"],
    ]) {
      if (!columns.has(name)) storage.sql.exec(`ALTER TABLE do_users ADD COLUMN ${name} ${definition}`);
    }
    // Adding the marker to an existing deployment must not re-onboard every
    // historical user on their next reconnect. Only rows inserted after this
    // migration begin with a NULL marker.
    if (!hadOnboardingWelcome) {
      storage.sql.exec(`
        UPDATE do_users
        SET onboarding_welcomed_at_ms = created_at_ms
        WHERE onboarding_welcomed_at_ms IS NULL
      `);
    }
    storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS do_users_username_unique ON do_users(username)");
    storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS do_users_linux_uid_unique ON do_users(linux_uid) WHERE linux_uid IS NOT NULL");
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS do_user_login_origins (
        user_id TEXT NOT NULL,
        remote_host TEXT NOT NULL,
        first_login_at_ms INTEGER NOT NULL,
        last_login_at_ms INTEGER NOT NULL,
        login_count INTEGER NOT NULL,
        PRIMARY KEY(user_id, remote_host)
      )
    `);
  }

  allowNoneAuth(authContext) {
    if (this.debugAuthentication()) {
      this.rememberAuthenticatedConnection(authContext, "none");
      return true;
    }
    const enrolled = this.ctx.storage.available
      ? this.ctx.storage.sql.exec(
        "SELECT count(*) AS total FROM do_users WHERE ssh_public_key IS NOT NULL",
      ).one().total > 0
      : [...this.fallback.values()].some((user) => user.sshPublicKey);
    if (enrolled) return false;
    this.rememberAuthenticatedConnection(authContext, "none");
    return true;
  }

  debugAuthentication() {
    return globalThis.hypernodeConfig?.authenticationMode === "debug";
  }

  rememberAuthenticatedConnection(authContext, authentication) {
    const existing = this.authenticatedConnections.get(authContext.connectionId);
    if (existing) return existing;
    const username = normalizedUsername(authContext.username);
    const identity = {
      id: userId(username),
      username,
      authentication,
      fingerprint: authContext.fingerprint ?? null,
      remoteHost: remoteHost(authContext.remoteAddr),
    };
    Object.assign(identity, this.ensureUser(identity), { registered: true });
    this.authenticatedConnections.set(authContext.connectionId, identity);
    return identity;
  }

  authenticatePublicKey(authContext) {
    const authenticated = this.authenticatedConnections.get(authContext.connectionId);
    if (authenticated?.fingerprint === authContext.fingerprint) return true;
    const user = this.acceptsPublicKey(authContext);
    if (!user) return false;
    const identity = {
      id: user.id,
      username: user.username,
      authentication: "publickey",
      fingerprint: authContext.fingerprint,
      remoteHost: remoteHost(authContext.remoteAddr),
    };
    Object.assign(identity, this.ensureUser(identity), { registered: true });
    this.authenticatedConnections.set(authContext.connectionId, identity);
    return true;
  }

  acceptsPublicKey(authContext) {
    const user = this.ctx.storage.available
      ? this.ctx.storage.sql.exec(`
        SELECT id, username, ssh_key_fingerprint AS fingerprint
        FROM do_users
        WHERE username = ? AND ssh_key_fingerprint = ? AND ssh_public_key IS NOT NULL
      `, authContext.username, authContext.fingerprint).toArray()[0]
      : [...this.fallback.values()].find((candidate) =>
        candidate.username === authContext.username &&
        candidate.sshKeyFingerprint === authContext.fingerprint);
    return user ?? null;
  }

  identityForConnection(connectionId) {
    return this.authenticatedConnections.get(connectionId) ?? null;
  }

  identityForDirectWebSocket(authContext) {
    if (!this.debugAuthentication()) return null;
    return this.rememberAuthenticatedConnection(authContext, "direct-websocket");
  }

  login(connection) {
    const principal = this.ctx.principal.current();
    const identity = connection.identity ?? {
      id: principal.id,
      username: principal.username,
      authentication: principal.authentication,
      fingerprint: null,
    };
    const now = Date.now();
    const user = identity.registered ? this.find(identity.id) : this.ensureUser(identity, now);
    Object.assign(identity, user);
    if (connection.connectionId) this.authenticatedConnections.set(connection.connectionId, identity);

    let issuedKey = null;
    if (!this.debugAuthentication() && !user.sshPublicKey) {
      issuedKey = crypto.generateSSHKeyPair(`hypernode-${identity.username}`);
      if (this.ctx.storage.available) {
        this.ctx.storage.sql.exec(`
          UPDATE do_users
          SET ssh_public_key = ?, ssh_key_fingerprint = ?, ssh_key_issued_at_ms = ?
          WHERE id = ?
        `, issuedKey.publicKey.trim(), issuedKey.fingerprint, now, identity.id);
      } else {
        Object.assign(this.fallback.get(identity.id), {
          sshPublicKey: issuedKey.publicKey.trim(),
          sshKeyFingerprint: issuedKey.fingerprint,
          sshKeyIssuedAtMs: now,
        });
      }
    }

    const isNewUser = this.claimOnboardingWelcome(identity.id, now);
    if (!isNewUser && !issuedKey) return;

    const welcomeText = onboardingWelcomeText(identity, user, {
      debug: this.debugAuthentication(),
    });
    const persistedText = issuedKey
      ? `你好 ${identity.username}，欢迎登录 Hypernode。SSH 密钥 ${issuedKey.fingerprint} 已签发；私钥只在签发连接中交付一次。`
      : welcomeText;
    const deliveryText = issuedKey
      ? [
        welcomeText,
        "",
        "无密码引导现已关闭。请将下面的一次性私钥保存到本机并设置权限为 600：",
        "",
        "```",
        issuedKey.privateKey.trim(),
        "```",
        "",
        `公钥指纹：${issuedKey.fingerprint}`,
        `以后使用：ssh -i <保存路径> ${identity.username}@<Hypernode> -p 9988`,
      ].join("\n")
      : persistedText;
    this.deliverAgentMessage(connection, this.ctx.allThread.get().id, {
      deliveryText,
      persistedText,
      sensitive: issuedKey !== null,
    });
  }

  deliverAgentMessage(connection, threadId, { deliveryText, persistedText = deliveryText, sensitive = false }) {
    const thread = this.ctx.threadManager.get(threadId);
    const record = this.ctx.turnManager.startAgent(threadId);
    this.ctx.appServer.notifyAfter(connection, "thread/started", {
      thread: threadStartedProjection(thread),
    });
    this.ctx.appServer.notifyAfter(connection, "thread/status/changed", {
      threadId,
      status: { type: "active", activeFlags: [] },
    });
    this.ctx.appServer.notifyAfter(connection, "turn/started", {
      threadId,
      turn: startedTurnProjection(record.turn),
    });
    this.ctx.appServer.notifyAfter(
      connection,
      "item/started",
      agentStarted(record, streamedAgentStartItem(record.agentItem), Date.now()),
    );
    const completed = this.ctx.turnManager.complete(record, persistedText);
    const completedAtMs = Date.now();
    const deliveredItem = { ...completed.agentItem, text: deliveryText };
    this.ctx.appServer.notifyAfter(connection, "item/agentMessage/delta", {
      threadId: record.threadId,
      turnId: record.turn.id,
      itemId: completed.agentItem.id,
      delta: deliveryText,
    }, { sensitive });
    this.ctx.appServer.notifyAfter(
      connection,
      "item/completed",
      agentCompleted(record, deliveredItem, completedAtMs),
      { sensitive },
    );
    this.ctx.appServer.notifyAfter(connection, "turn/completed", {
      threadId: record.threadId,
      turn: { ...completed.turn, items: [deliveredItem] },
    }, { sensitive });
    this.ctx.appServer.notifyAfter(connection, "thread/status/changed", {
      threadId: record.threadId,
      status: { type: "idle" },
    });
  }

  completeWelcome(connection) {
    // Kept as a no-op compatibility hook for connections created by older bundles.
    delete connection.pendingWelcome;
  }

  claimOnboardingWelcome(userId, now = Date.now()) {
    if (!this.ctx.storage.available) {
      const user = this.fallback.get(userId);
      if (!user || user.onboardingWelcomedAtMs != null) return false;
      user.onboardingWelcomedAtMs = now;
      return true;
    }
    const result = this.ctx.storage.sql.exec(`
      UPDATE do_users
      SET onboarding_welcomed_at_ms = ?
      WHERE id = ? AND onboarding_welcomed_at_ms IS NULL
    `, now, userId);
    return Number(result.rowsWritten ?? 0) > 0;
  }

  list() {
    if (!this.ctx.storage.available) return [...this.fallback.values()];
    const users = this.ctx.storage.sql.exec(`
      SELECT
        id,
        username,
        role,
        authentication,
        created_at_ms AS createdAtMs,
        last_login_at_ms AS lastLoginAtMs,
        login_count AS loginCount
        ,ssh_public_key AS sshPublicKey
        ,ssh_key_fingerprint AS sshKeyFingerprint
        ,ssh_key_issued_at_ms AS sshKeyIssuedAtMs
        ,linux_uid AS linuxUid
        ,linux_gid AS linuxGid
        ,home_path AS homePath
        ,codex_home AS codexHome
        ,installation_id AS installationId
        ,codex_binding_state AS codexBindingState
        ,codex_auth_mode AS codexAuthMode
        ,codex_account_email AS codexAccountEmail
        ,codex_plan_type AS codexPlanType
        ,codex_credential_ref AS codexCredentialRef
        ,codex_bound_at_ms AS codexBoundAtMs
        ,codex_last_verified_at_ms AS codexLastVerifiedAtMs
        ,onboarding_welcomed_at_ms AS onboardingWelcomedAtMs
      FROM do_users
      ORDER BY created_at_ms, id
    `).toArray();
    for (const user of users) {
      user.loginOrigins = this.ctx.storage.sql.exec(`
        SELECT remote_host AS remoteHost, first_login_at_ms AS firstLoginAtMs,
          last_login_at_ms AS lastLoginAtMs, login_count AS loginCount
        FROM do_user_login_origins WHERE user_id = ? ORDER BY last_login_at_ms DESC
      `, user.id).toArray();
    }
    return users;
  }

  find(userId) {
    if (!this.ctx.storage.available) return this.fallback.get(userId) ?? null;
    return this.list().find((user) => user.id === userId) ?? null;
  }

  setCodexBindingState(userId, state) {
    if (!this.ctx.storage.available) {
      const user = this.fallback.get(userId);
      if (user) user.codexBindingState = state;
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE do_users SET codex_binding_state = ? WHERE id = ?",
      state,
      userId,
    );
  }

  setInstallationId(userId, installationId) {
    if (typeof installationId !== "string" || !installationId.trim()) {
      throw new Error("installation id is required");
    }
    if (!this.ctx.storage.available) {
      const user = this.fallback.get(userId);
      if (user) user.installationId = installationId.trim();
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE do_users SET installation_id = ? WHERE id = ?",
      installationId.trim(),
      userId,
    );
  }

  setCodexAccount(userId, account = null, metadata = {}) {
    const now = Date.now();
    const bound = account != null || metadata.authMode != null;
    const state = metadata.state ?? (bound ? "bound" : "unbound");
    const authMode = account?.type ?? metadata.authMode ?? null;
    const email = account?.email ?? metadata.email ?? null;
    const planType = account?.planType ?? metadata.planType ?? null;
    const user = this.find(userId);
    const credentialRef = state === "bound" && user?.codexHome ? `${user.codexHome}/auth.json` : null;
    if (!this.ctx.storage.available) {
      if (!user) return;
      Object.assign(user, {
        codexBindingState: state,
        codexAuthMode: authMode,
        codexAccountEmail: email,
        codexPlanType: planType,
        codexCredentialRef: credentialRef,
        codexBoundAtMs: state === "bound" ? (user.codexBoundAtMs ?? now) : null,
        codexLastVerifiedAtMs: metadata.verified === false ? user.codexLastVerifiedAtMs : now,
      });
      return;
    }
    this.ctx.storage.sql.exec(`
      UPDATE do_users SET
        codex_binding_state = ?, codex_auth_mode = ?, codex_account_email = ?,
        codex_plan_type = ?, codex_credential_ref = ?,
        codex_bound_at_ms = CASE WHEN ? = 'bound' THEN coalesce(codex_bound_at_ms, ?) ELSE NULL END,
        codex_last_verified_at_ms = CASE WHEN ? THEN codex_last_verified_at_ms ELSE ? END
      WHERE id = ?
    `, state, authMode, email, planType, credentialRef, state, now,
    metadata.verified === false, now, userId);
  }

  ensureUser(identity, now = Date.now()) {
    const username = normalizedUsername(identity.username);
    const id = userId(username);
    const origin = identity.remoteHost ?? null;
    if (!this.ctx.storage.available) {
      const existing = this.fallback.get(id);
      const linuxUid = existing?.linuxUid ?? FIRST_DYNAMIC_UID + this.fallback.size;
      const usersRoot = globalThis.hypernodeConfig?.usersRoot || ".runtime/users";
      const homePath = existing?.homePath ?? `${usersRoot}/${safeHomeSegment(username)}`;
      const origins = existing?.loginOrigins ?? [];
      if (origin) {
        const record = origins.find((item) => item.remoteHost === origin);
        if (record) {
          record.lastLoginAtMs = now;
          record.loginCount += 1;
        } else origins.push({ remoteHost: origin, firstLoginAtMs: now, lastLoginAtMs: now, loginCount: 1 });
      }
      const user = {
        id,
        username,
        role: existing?.role ?? (this.fallback.size === 0 ? "administrator" : "member"),
        authentication: identity.authentication,
        createdAtMs: existing?.createdAtMs ?? now,
        lastLoginAtMs: now,
        loginCount: (existing?.loginCount ?? 0) + 1,
        linuxUid,
        linuxGid: linuxUid,
        homePath,
        codexHome: `${homePath}/.codex`,
        installationId: existing?.installationId ?? uuidV4(),
        codexBindingState: existing?.codexBindingState ?? "unbound",
        onboardingWelcomedAtMs: existing?.onboardingWelcomedAtMs ?? null,
        loginOrigins: origins,
      };
      const paths = hostIdentity.ensureUser(username, linuxUid, linuxUid, user.installationId);
      user.homePath = paths.homePath;
      user.codexHome = paths.codexHome;
      user.codexBindingState = paths.codexBound ? "bound" : "unbound";
      this.fallback.set(id, { ...existing, ...user });
      return user;
    }

    let user = this.ctx.storage.sql.exec("SELECT * FROM do_users WHERE username = ?", username).toArray()[0];
    if (!user) {
      const stats = this.ctx.storage.sql.exec(`
        SELECT count(*) AS total, max(linux_uid) AS max_uid FROM do_users
      `).one();
      const linuxUid = Math.max(FIRST_DYNAMIC_UID - 1, Number(stats.max_uid ?? 0)) + 1;
      const usersRoot = globalThis.hypernodeConfig?.usersRoot || ".runtime/users";
      const homePath = `${usersRoot}/${safeHomeSegment(username)}`;
      this.ctx.storage.sql.exec(`
        INSERT INTO do_users(
          id, username, role, authentication, created_at_ms, last_login_at_ms, login_count,
          linux_uid, linux_gid, home_path, codex_home, installation_id, codex_binding_state
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `, id, username, Number(stats.total) === 0 ? "administrator" : "member", identity.authentication,
      now, now, linuxUid, linuxUid, homePath, `${homePath}/.codex`, uuidV4(), "unbound");
    } else {
      const usersRoot = globalThis.hypernodeConfig?.usersRoot || ".runtime/users";
      const linuxUid = user.linux_uid ?? Math.max(
        FIRST_DYNAMIC_UID - 1,
        Number(this.ctx.storage.sql.exec("SELECT max(linux_uid) AS max_uid FROM do_users").one().max_uid ?? 0),
      ) + 1;
      const homePath = user.home_path ?? `${usersRoot}/${safeHomeSegment(username)}`;
      this.ctx.storage.sql.exec(`
        UPDATE do_users SET authentication = ?, last_login_at_ms = ?, login_count = login_count + 1,
          linux_uid = ?, linux_gid = ?, home_path = ?, codex_home = ?,
          installation_id = coalesce(installation_id, ?),
          codex_binding_state = coalesce(codex_binding_state, 'unbound')
        WHERE id = ?
      `, identity.authentication, now, linuxUid, user.linux_gid ?? linuxUid, homePath,
      user.codex_home ?? `${homePath}/.codex`, uuidV4(), user.id);
    }
    if (origin) this.ctx.storage.sql.exec(`
      INSERT INTO do_user_login_origins(user_id, remote_host, first_login_at_ms, last_login_at_ms, login_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(user_id, remote_host) DO UPDATE SET
        last_login_at_ms = excluded.last_login_at_ms,
        login_count = do_user_login_origins.login_count + 1
    `, id, origin, now, now);
    user = this.find(id);
    const paths = hostIdentity.ensureUser(
      username,
      user.linuxUid,
      user.linuxGid,
      user.installationId,
    );
    const codexBindingState = paths.codexBound ? "bound" : "unbound";
    if (user.homePath !== paths.homePath || user.codexHome !== paths.codexHome ||
        user.codexBindingState !== codexBindingState) {
      this.ctx.storage.sql.exec(
        "UPDATE do_users SET home_path = ?, codex_home = ?, codex_binding_state = ? WHERE id = ?",
        paths.homePath,
        paths.codexHome,
        codexBindingState,
        id,
      );
      user.homePath = paths.homePath;
      user.codexHome = paths.codexHome;
      user.codexBindingState = codexBindingState;
    }
    return user;
  }
}

UserDirectoryService.inject = ["allThread", "appServer", "principal", "storage", "threadManager", "turnManager"];
