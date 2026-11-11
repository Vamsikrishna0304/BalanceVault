const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const backendRoot = path.resolve(__dirname, "../..");

function loadTestEnvironment() {
  const baseEnvPath = path.join(backendRoot, ".env");
  if (!process.env.DATABASE_URL && fs.existsSync(baseEnvPath)) {
    const baseEnvironment = dotenv.parse(fs.readFileSync(baseEnvPath));
    if (baseEnvironment.DATABASE_URL) {
      process.env.DATABASE_URL = baseEnvironment.DATABASE_URL;
    }
  }

  if (!process.env.TEST_DATABASE_URL) {
    const testEnvPath = path.join(backendRoot, ".env.test");
    if (fs.existsSync(testEnvPath)) {
      const testEnvironment = dotenv.parse(fs.readFileSync(testEnvPath));
      if (testEnvironment.TEST_DATABASE_URL) {
        process.env.TEST_DATABASE_URL = testEnvironment.TEST_DATABASE_URL;
      }
    }
  }
}

function databaseIdentity(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Database URL is invalid; expected a PostgreSQL connection URL.");
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error("Database URL is invalid; expected a PostgreSQL connection URL with a database name.");
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/-pooler(?=\.)/, "");
  const port = url.port || "5432";
  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Database URL contains an invalid database name.");
  }

  return `${hostname}:${port}/${databaseName}`;
}

function getTestDatabaseUrl() {
  loadTestEnvironment();

  const testUrl = process.env.TEST_DATABASE_URL;
  const developmentUrl = process.env.DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is required. Configure it in backend/.env.test.");
  }
  if (!developmentUrl) {
    throw new Error("DATABASE_URL is required to verify that the test database is separate.");
  }

  const testIdentity = databaseIdentity(testUrl);
  const developmentIdentity = databaseIdentity(developmentUrl);
  if (testIdentity === developmentIdentity) {
    throw new Error("Refusing to run: TEST_DATABASE_URL points to the same database as DATABASE_URL.");
  }

  return testUrl;
}

function createTestPrismaClient() {
  const adapter = new PrismaPg({ connectionString: getTestDatabaseUrl() });
  return new PrismaClient({ adapter });
}

module.exports = {
  createTestPrismaClient,
  databaseIdentity,
  getTestDatabaseUrl,
};
