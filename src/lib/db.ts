import mysql from "mysql2/promise";

const FREE_UPLOAD_LIMIT = 10;

let pool: mysql.Pool | null = null;

function getPool() {
  if (pool) return pool;

  // Use public URL for external access, internal URL when deployed on Railway
  const connectionString =
    process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL;

  if (!connectionString) {
    throw new Error("Missing MYSQL_PUBLIC_URL or MYSQL_URL in environment.");
  }

  pool = mysql.createPool({
    uri: connectionString,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  return pool;
}

export async function initDatabase() {
  const db = getPool();

  await db.execute(`
    CREATE TABLE IF NOT EXISTS visitors (
      id VARCHAR(36) PRIMARY KEY,
      fingerprint VARCHAR(64),
      upload_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_fingerprint (fingerprint)
    )
  `);
}

export async function getOrCreateVisitor(
  cookieId: string | null,
  fingerprint: string | null
): Promise<{ id: string; uploadCount: number; isNew: boolean }> {
  const db = getPool();

  // Try to find by cookie ID first
  if (cookieId) {
    const [rows] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT id, upload_count FROM visitors WHERE id = ?",
      [cookieId]
    );
    if (rows.length > 0) {
      return { id: rows[0].id, uploadCount: rows[0].upload_count, isNew: false };
    }
  }

  // Try to find by fingerprint
  if (fingerprint) {
    const [rows] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT id, upload_count FROM visitors WHERE fingerprint = ?",
      [fingerprint]
    );
    if (rows.length > 0) {
      return { id: rows[0].id, uploadCount: rows[0].upload_count, isNew: false };
    }
  }

  // Create new visitor
  const newId = crypto.randomUUID();
  await db.execute(
    "INSERT INTO visitors (id, fingerprint, upload_count) VALUES (?, ?, 0)",
    [newId, fingerprint || null]
  );

  return { id: newId, uploadCount: 0, isNew: true };
}

export async function incrementUpload(visitorId: string): Promise<number> {
  const db = getPool();

  await db.execute(
    "UPDATE visitors SET upload_count = upload_count + 1 WHERE id = ?",
    [visitorId]
  );

  const [rows] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT upload_count FROM visitors WHERE id = ?",
    [visitorId]
  );

  return rows[0]?.upload_count ?? 0;
}

export async function getUploadCount(visitorId: string): Promise<number> {
  const db = getPool();

  const [rows] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT upload_count FROM visitors WHERE id = ?",
    [visitorId]
  );

  return rows[0]?.upload_count ?? 0;
}

export async function canUpload(visitorId: string): Promise<{
  allowed: boolean;
  remaining: number;
  used: number;
}> {
  const count = await getUploadCount(visitorId);
  const remaining = Math.max(0, FREE_UPLOAD_LIMIT - count);

  return {
    allowed: count < FREE_UPLOAD_LIMIT,
    remaining,
    used: count,
  };
}

export { FREE_UPLOAD_LIMIT };
