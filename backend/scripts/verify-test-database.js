const { createTestPrismaClient, getTestDatabaseUrl } = require("../test/helpers/test-database");

async function verifyTestDatabase() {
  getTestDatabaseUrl();
  const prisma = createTestPrismaClient();
  try {
    const [database] = await prisma.$queryRaw`
      SELECT
        current_database() AS database_name,
        to_regclass('"User"')::text AS user_table,
        to_regclass('"Account"')::text AS account_table,
        to_regclass('"Transfer"')::text AS transfer_table,
        to_regclass('"LedgerEntry"')::text AS ledger_entry_table,
        to_regclass('"IdempotencyKey"')::text AS idempotency_key_table,
        to_regclass('"AuditLog"')::text AS audit_log_table
    `;

    const missingTables = Object.entries(database)
      .filter(([name, value]) => name.endsWith("_table") && value === null)
      .map(([name]) => name);
    if (missingTables.length > 0) {
      throw new Error("The test database is missing tables from the existing Prisma migrations.");
    }

    console.log("Test database verified: reachable, distinct from DATABASE_URL, and schema tables are present.");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  verifyTestDatabase().catch(() => {
    console.error("Test database verification failed. Check the isolated test URL, connectivity, and applied migrations; details are redacted.");
    process.exitCode = 1;
  });
}

module.exports = { verifyTestDatabase };
