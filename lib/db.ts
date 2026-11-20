import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * One Prisma client per server process, on the Rust-free engine with the `pg`
 * driver adapter. Point DATABASE_URL at your provider's *pooled* endpoint
 * (Neon/Supabase pooler or PgBouncer) and keep the per-instance pool small:
 * a 512 MB instance is happy with 3 connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PrismaClient({ adapter, log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });
}

export const prisma = globalForPrisma.prisma ?? createClient();
// Next.js dev mode reloads modules; reuse the client instead of opening new pools.
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
