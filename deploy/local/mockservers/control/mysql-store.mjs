import mysql from "mysql2/promise";

import { createSyntheticUser } from "./server.mjs";

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS mock_users (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  mock_user_id VARCHAR(64) NULL,
  display_name VARCHAR(128) NULL,
  qq_openid VARCHAR(128) NULL,
  phone VARCHAR(32) NULL,
  realname_name VARCHAR(128) NULL,
  realname_id_card VARCHAR(32) NULL,
  identity_alias_hash CHAR(64) NULL,
  active_scenario_id VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_selected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sequence_id),
  UNIQUE KEY uk_mock_users_mock_user_id (mock_user_id),
  UNIQUE KEY uk_mock_users_qq_openid (qq_openid),
  UNIQUE KEY uk_mock_users_phone (phone),
  UNIQUE KEY uk_mock_users_identity_alias_hash (identity_alias_hash),
  KEY idx_mock_users_last_selected (last_selected_at, sequence_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
`;

function rowToUser(row) {
  if (!row) return undefined;
  return {
    mockUserId: row.mock_user_id,
    displayName: row.display_name,
    qqOpenId: row.qq_openid,
    phone: row.phone,
    realnameName: row.realname_name,
    realnameIDCard: row.realname_id_card,
    identityAliasHash: row.identity_alias_hash,
    scenarioId: row.active_scenario_id,
    createdAt: new Date(row.created_at).toISOString(),
    lastSelectedAt: new Date(row.last_selected_at).toISOString(),
  };
}

function isDuplicate(error) {
  return error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
}

export class MySQLMockStore {
  constructor(pool) {
    this.pool = pool;
  }

  static async connect(config) {
    const pool = mysql.createPool({
      ...config,
      charset: "utf8mb4",
      timezone: "Z",
      connectionLimit: 5,
      enableKeepAlive: true,
    });
    await pool.query("SELECT 1");
    await pool.query(CREATE_TABLE);
    return new MySQLMockStore(pool);
  }

  async createBlankUser(scenarioId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const [insert] = await connection.execute(
          "INSERT INTO mock_users (active_scenario_id) VALUES (?)",
          [scenarioId],
        );
        const user = createSyntheticUser(Number(insert.insertId), scenarioId);
        await connection.execute(
          `UPDATE mock_users
             SET mock_user_id = ?,
                 display_name = ?,
                 qq_openid = ?,
                 phone = ?,
                 realname_name = ?,
                 realname_id_card = ?,
                 identity_alias_hash = ?,
                 created_at = ?,
                 last_selected_at = ?
           WHERE sequence_id = ?`,
          [
            user.mockUserId,
            user.displayName,
            user.qqOpenId,
            user.phone,
            user.realnameName,
            user.realnameIDCard,
            user.identityAliasHash,
            user.createdAt.slice(0, 23).replace("T", " "),
            user.lastSelectedAt.slice(0, 23).replace("T", " "),
            insert.insertId,
          ],
        );
        await connection.commit();
        return user;
      } catch (error) {
        await connection.rollback();
        if (!isDuplicate(error) || attempt === 4) throw error;
      } finally {
        connection.release();
      }
    }
    throw new Error("failed to generate a unique blank user");
  }

  async listUsers({ query = "", page = 1, pageSize = 20 } = {}) {
    const offset = (page - 1) * pageSize;
    const like = `%${query.normalize("NFKC").trim()}%`;
    const where = query ? "WHERE mock_user_id LIKE ? OR display_name LIKE ?" : "";
    const args = query ? [like, like] : [];
    const [countRows] = await this.pool.execute(
      `SELECT COUNT(*) AS total FROM mock_users ${where}`,
      args,
    );
    const [rows] = await this.pool.query(
      `SELECT * FROM mock_users
       ${where}
       ORDER BY last_selected_at DESC, sequence_id DESC
       LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    );
    return {
      items: rows.map(rowToUser),
      total: Number(countRows[0].total),
    };
  }

  async getUser(mockUserId) {
    const [rows] = await this.pool.execute(
      "SELECT * FROM mock_users WHERE mock_user_id = ? LIMIT 1",
      [mockUserId],
    );
    return rowToUser(rows[0]);
  }

  async updateScenario(mockUserId, scenarioId) {
    const [result] = await this.pool.execute(
      `UPDATE mock_users
       SET active_scenario_id = ?, last_selected_at = CURRENT_TIMESTAMP(3)
       WHERE mock_user_id = ?`,
      [scenarioId, mockUserId],
    );
    if (!result.affectedRows) return undefined;
    return this.getUser(mockUserId);
  }

  async findByIdentityAliasHash(aliasHash) {
    const [rows] = await this.pool.execute(
      "SELECT * FROM mock_users WHERE identity_alias_hash = ? LIMIT 1",
      [aliasHash],
    );
    return rowToUser(rows[0]);
  }
}
