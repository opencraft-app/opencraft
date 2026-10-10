// Use only after capability.data.enabled === true and contract === "rivet-sql-v1".
// The platform authenticates owner writes and grants share GET/HEAD a read-only
// SQL capability. Never infer those privileges from browser-supplied headers.
// No browser storage, module-global array, instance filesystem, or external DB.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/todos") return new Response("Not found", { status: 404 });
    const sql = env.RIVET_STORAGE.sql;
    if (request.method === "GET" || request.method === "HEAD") {
      // Reads must work on an empty or legacy database without DDL/migration.
      const tables = await sql.exec(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?)",
        ["todos", "todo_tombstones"],
      );
      let todos = [];
      if (tables.rows.some((table) => table.name === "todos")) {
        const hasTombstones = tables.rows.some((table) => table.name === "todo_tombstones");
        const query = hasTombstones
          ? "SELECT id, title, done, created_at FROM todos WHERE NOT EXISTS (SELECT 1 FROM todo_tombstones WHERE todo_tombstones.id = todos.id) ORDER BY created_at, id LIMIT 1000"
          : "SELECT id, title, done, created_at FROM todos ORDER BY created_at, id LIMIT 1000";
        todos = (await sql.exec(query)).rows;
      }
      return Response.json({ todos });
    }
    if (!["POST", "PATCH", "DELETE"].includes(request.method)) {
      return new Response("Method not allowed", { status: 405 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (!body || typeof body.id !== "string" || body.id.length !== 36 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.id)) {
      return Response.json({ error: "canonical UUID v4 required" }, { status: 400 });
    }
    if (request.method === "POST" &&
        (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200)) {
      return Response.json({ error: "title required, max 200 characters" }, { status: 400 });
    }
    if (request.method === "PATCH" && typeof body.done !== "boolean") {
      return Response.json({ error: "done must be boolean" }, { status: 400 });
    }
    // Keep the legacy todos schema and its rows intact. The companion table
    // permanently reserves deleted IDs, including DELETE-before-POST intents.
    await sql.exec("CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL CHECK(done IN (0, 1)), created_at INTEGER NOT NULL)");
    await sql.exec("CREATE TABLE IF NOT EXISTS todo_tombstones (id TEXT PRIMARY KEY)");
    if (request.method === "POST") {
      const title = body.title.trim();
      // One SQLite statement owns both capacity admission and insertion. No
      // request serialization or separate COUNT/read-check is required.
      await sql.exec(
        `INSERT INTO todos (id, title, done, created_at)
         SELECT ?, ?, 0, ?
         WHERE NOT EXISTS (SELECT 1 FROM todo_tombstones WHERE id = ?)
           AND (SELECT COUNT(*) FROM todos AS live
                WHERE NOT EXISTS (SELECT 1 FROM todo_tombstones AS deleted WHERE deleted.id = live.id)) < 1000
         ON CONFLICT(id) DO NOTHING`,
        [body.id, title, Date.now(), body.id],
      );
      // Always inspect the winner after the atomic INSERT, including conflicts
      // and deletes that completed while this request was in flight.
      const saved = await sql.exec(
        `SELECT todo.id, todo.title, todo.done, todo.created_at, deleted.id AS deleted_id
         FROM (SELECT ? AS id) AS wanted
         LEFT JOIN todos AS todo ON todo.id = wanted.id
         LEFT JOIN todo_tombstones AS deleted ON deleted.id = wanted.id`,
        [body.id],
      );
      const row = saved.rows[0];
      if (row?.deleted_id) return Response.json({ error: "todo was deleted" }, { status: 409 });
      if (!row?.id) return Response.json({ error: "todo limit reached" }, { status: 409 });
      if (row.title !== title) {
        return Response.json({ error: "id already belongs to another intent" }, { status: 409 });
      }
      const { id, done, created_at } = row;
      return Response.json({ todo: { id, title: row.title, done, created_at } }, { status: 201 });
    }
    if (request.method === "PATCH") {
      await sql.exec(
        "UPDATE todos SET done = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM todo_tombstones WHERE todo_tombstones.id = todos.id)",
        [body.done ? 1 : 0, body.id],
      );
    }
    if (request.method === "DELETE") {
      // Retain the creation intent behind a tombstone instead of erasing the
      // idempotency record and allowing a delayed POST to recreate the item.
      await sql.exec("INSERT INTO todo_tombstones (id) VALUES (?) ON CONFLICT(id) DO NOTHING", [body.id]);
    }
    return Response.json({ ok: true });
  },
};
