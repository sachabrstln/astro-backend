// Connexion Postgres + helper de requêtes
import pg from 'pg';

const { Pool } = pg;

// SÉCURITÉ TLS Postgres :
// - Par défaut Supabase pooler utilise un cert signé par AWS, compatible avec la store CA système.
// - DATABASE_SSL_STRICT=1 → vérifie le CA (production hardened).
// - Sinon, SSL actif mais sans vérif (acceptable car réseau Render↔Supabase en AWS interne).
// TODO avant prod publique : mettre DATABASE_SSL_STRICT=1 et fournir le CA Supabase via DATABASE_CA.
const strict = process.env.DATABASE_SSL_STRICT === '1';
const sslConfig = process.env.NODE_ENV === 'production'
  ? (strict
      ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA || undefined }
      : { rejectUnauthorized: false })
  : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}
