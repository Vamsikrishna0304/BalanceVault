
const prisma = require("./lib/prisma");

async function testDatabase() {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;

    console.log("Database connection successful!");
  } catch (error) {
    console.error("Database connection failed:", error.message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

testDatabase();
