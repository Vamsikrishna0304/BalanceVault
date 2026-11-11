require("dotenv").config();

const { z } = require("zod");
const prisma = require("../lib/prisma");
const { writeAuditLog } = require("../lib/audit");

async function promoteAdmin(emailArgument) {
  const emailValidation = z.string().trim().email().safeParse(emailArgument);
  if (!emailValidation.success) {
    throw new Error("Provide the email address of an existing account.");
  }

  const email = emailValidation.data.toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  });
  if (!user) {
    throw new Error("No BalanceVault user exists with that email address.");
  }
  if (user.role === "ADMIN") {
    console.log("The requested user already has administrator access.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { role: "ADMIN" },
    });
    await writeAuditLog(tx, {
      action: "ADMIN_ROLE_GRANTED",
      entityType: "User",
      entityId: user.id,
      details: { role: "ADMIN", provisionedBy: "CLI" },
    });
  });
  console.log("Administrator role granted and audit event recorded.");
}

if (require.main === module) {
  const [email, ...extraArguments] = process.argv.slice(2);
  if (!email || extraArguments.length) {
    console.error("Usage: npm run admin:promote -- <existing-user-email>");
    process.exitCode = 2;
  } else {
    promoteAdmin(email)
      .catch((error) => {
        console.error("Administrator promotion failed:", error.message);
        process.exitCode = 1;
      })
      .finally(() => prisma.$disconnect());
  }
}

module.exports = { promoteAdmin };
