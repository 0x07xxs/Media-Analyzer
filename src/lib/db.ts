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

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100),
      upload_count INT DEFAULT 0,
      visitor_id VARCHAR(36),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL,
      INDEX idx_email (email),
      INDEX idx_visitor_id (visitor_id)
    )
  `);
}

// ============== USER FUNCTIONS ==============

export type User = {
  id: string;
  email: string;
  name: string | null;
  uploadCount: number;
  createdAt: Date;
};

export async function createUser(
  email: string,
  passwordHash: string,
  name?: string,
  visitorId?: string
): Promise<User> {
  const db = getPool();
  const id = crypto.randomUUID();

  // If linking to a visitor, get their upload count to transfer
  let transferCount = 0;
  if (visitorId) {
    const [visitorRows] = await db.execute<mysql.RowDataPacket[]>(
      "SELECT upload_count FROM visitors WHERE id = ?",
      [visitorId]
    );
    if (visitorRows.length > 0) {
      transferCount = visitorRows[0].upload_count;
    }
  }

  await db.execute(
    `INSERT INTO users (id, email, password_hash, name, upload_count, visitor_id) 
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, email.toLowerCase(), passwordHash, name || null, transferCount, visitorId || null]
  );

  return {
    id,
    email: email.toLowerCase(),
    name: name || null,
    uploadCount: transferCount,
    createdAt: new Date(),
  };
}

export async function getUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
  const db = getPool();

  const [rows] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT id, email, password_hash, name, upload_count, created_at FROM users WHERE email = ?",
    [email.toLowerCase()]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    uploadCount: row.upload_count,
    createdAt: row.created_at,
  };
}

export async function getUserById(id: string): Promise<User | null> {
  const db = getPool();

  const [rows] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT id, email, name, upload_count, created_at FROM users WHERE id = ?",
    [id]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    uploadCount: row.upload_count,
    createdAt: row.created_at,
  };
}

export async function incrementUserUpload(userId: string): Promise<number> {
  const db = getPool();

  await db.execute(
    "UPDATE users SET upload_count = upload_count + 1 WHERE id = ?",
    [userId]
  );

  const [rows] = await db.execute<mysql.RowDataPacket[]>(
    "SELECT upload_count FROM users WHERE id = ?",
    [userId]
  );

  return rows[0]?.upload_count ?? 0;
}

export async function updateLastLogin(userId: string): Promise<void> {
  const db = getPool();
  await db.execute(
    "UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?",
    [userId]
  );
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
