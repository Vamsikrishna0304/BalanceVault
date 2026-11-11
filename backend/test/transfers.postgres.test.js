const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performTransfer, TransferError } = require("../lib/transfers");
const { createTestPrismaClient } = require("./helpers/test-database");

const prisma = createTestPrismaClient();
const runId = randomUUID().replaceAll("-", "");

function decimalToCents(value) {
  const [whole, fraction = ""] = value.toString().split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function expectMoney(actual, expected) {
  assert.equal(decimalToCents(actual), decimalToCents(expected));
}

async function createFixture(t, sourceBalance = "100.00", destinationBalance = "10.00") {
  const fixtureId = randomUUID().replaceAll("-", "");
  const userIds = [];
  const accountIds = [];

  const cleanup = async () => {
    if (accountIds.length === 0 && userIds.length === 0) return;
    await prisma.$transaction(async (tx) => {
      const transfers = accountIds.length
        ? await tx.transfer.findMany({
          where: {
            OR: [
              { fromAccountId: { in: accountIds } },
              { toAccountId: { in: accountIds } },
            ],
          },
          select: { id: true },
        })
        : [];
      const transferIds = transfers.map(({ id }) => id);
      const auditEntityIds = [...accountIds, ...userIds, ...transferIds];

      if (userIds.length || auditEntityIds.length) {
        await tx.auditLog.deleteMany({
          where: {
            OR: [
              ...(userIds.length ? [{ actorId: { in: userIds } }] : []),
              ...(auditEntityIds.length ? [{ entityId: { in: auditEntityIds } }] : []),
            ],
          },
        });
      }
      if (accountIds.length) {
        await tx.ledgerEntry.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.transfer.deleteMany({
          where: {
            OR: [
              { fromAccountId: { in: accountIds } },
              { toAccountId: { in: accountIds } },
            ],
          },
        });
      }
      if (userIds.length) {
        await tx.idempotencyKey.deleteMany({ where: { userId: { in: userIds } } });
      }
      if (accountIds.length) {
        await tx.account.deleteMany({ where: { id: { in: accountIds } } });
      }
      if (userIds.length) {
        await tx.user.deleteMany({ where: { id: { in: userIds } } });
      }
    });
  };
  t.after(cleanup);

  const sourceUser = await prisma.user.create({
    data: {
      name: "Transfer Integration Source",
      email: `test-${runId}-${fixtureId}-source@example.test`,
      passwordHash: "not-used-by-transfer-integration-tests",
    },
    select: { id: true },
  });
  userIds.push(sourceUser.id);

  const destinationUser = await prisma.user.create({
    data: {
      name: "Transfer Integration Destination",
      email: `test-${runId}-${fixtureId}-destination@example.test`,
      passwordHash: "not-used-by-transfer-integration-tests",
    },
    select: { id: true },
  });
  userIds.push(destinationUser.id);

  const source = await prisma.account.create({
    data: {
      accountNumber: `BV${fixtureId.slice(0, 20)}S`,
      ownerId: sourceUser.id,
      currency: "INR",
      status: "ACTIVE",
      balance: sourceBalance,
    },
  });
  accountIds.push(source.id);

  const destination = await prisma.account.create({
    data: {
      accountNumber: `BV${fixtureId.slice(0, 20)}D`,
      ownerId: destinationUser.id,
      currency: "INR",
      status: "ACTIVE",
      balance: destinationBalance,
    },
  });
  accountIds.push(destination.id);

  return {
    userId: sourceUser.id,
    source,
    destination,
    async transfer(amount, key, description = "Integration test transfer", client = prisma) {
      return performTransfer({
        prisma: client,
        userId: sourceUser.id,
        actorIp: "127.0.0.1",
        idempotencyKey: `it:${runId}:${key}`,
        input: {
          fromAccountId: source.id,
          toAccountNumber: destination.accountNumber,
          amount,
          description,
        },
      });
    },
  };
}

test("PostgreSQL transfer debits and credits accounts with equal ledger entries", async (t) => {
  const fixture = await createFixture(t);
  const result = await fixture.transfer("12.34", "success");

  assert.equal(result.replayed, false);
  assert.equal(result.response.transfer.status, "COMPLETED");
  const [source, destination, entries] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: fixture.source.id } }),
    prisma.account.findUniqueOrThrow({ where: { id: fixture.destination.id } }),
    prisma.ledgerEntry.findMany({
      where: { transferId: result.response.transfer.id },
      orderBy: { entryType: "asc" },
    }),
  ]);
  expectMoney(source.balance, "87.66");
  expectMoney(destination.balance, "22.34");
  assert.equal(entries.length, 2);

  const debit = entries.find((entry) => entry.entryType === "DEBIT");
  const credit = entries.find((entry) => entry.entryType === "CREDIT");
  assert.ok(debit);
  assert.ok(credit);
  assert.equal(debit.accountId, fixture.source.id);
  assert.equal(credit.accountId, fixture.destination.id);
  expectMoney(debit.amount, "12.34");
  expectMoney(credit.amount, "12.34");
  assert.equal(decimalToCents(debit.amount), decimalToCents(credit.amount));
});

test("insufficient funds leave no transfer, balance, ledger, idempotency, or audit changes", async (t) => {
  const fixture = await createFixture(t, "5.00", "10.00");

  await assert.rejects(
    fixture.transfer("5.01", "insufficient"),
    (error) => error instanceof TransferError && error.code === "INSUFFICIENT_FUNDS",
  );

  const [source, destination, transfers, entries, keys, logs] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: fixture.source.id } }),
    prisma.account.findUniqueOrThrow({ where: { id: fixture.destination.id } }),
    prisma.transfer.count({
      where: { OR: [{ fromAccountId: fixture.source.id }, { toAccountId: fixture.destination.id }] },
    }),
    prisma.ledgerEntry.count({ where: { accountId: { in: [fixture.source.id, fixture.destination.id] } } }),
    prisma.idempotencyKey.count({ where: { userId: fixture.userId } }),
    prisma.auditLog.count({ where: { actorId: fixture.userId } }),
  ]);

  expectMoney(source.balance, "5.00");
  expectMoney(destination.balance, "10.00");
  assert.equal(transfers, 0);
  assert.equal(entries, 0);
  assert.equal(keys, 0);
  assert.equal(logs, 0);
});

test("retrying the same idempotency key and request creates only one transfer", async (t) => {
  const fixture = await createFixture(t);
  const first = await fixture.transfer("15.00", "idempotent");
  const second = await fixture.transfer("15.00", "idempotent");

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.response, first.response);
  assert.equal(await prisma.transfer.count({ where: { fromAccountId: fixture.source.id } }), 1);
  assert.equal(await prisma.ledgerEntry.count({ where: { accountId: fixture.source.id } }), 1);
  const source = await prisma.account.findUniqueOrThrow({ where: { id: fixture.source.id } });
  expectMoney(source.balance, "85.00");
});

test("concurrent transfers against one balance never create a negative balance", async (t) => {
  const fixture = await createFixture(t, "100.00", "0.00");
  const results = await Promise.allSettled([
    fixture.transfer("75.00", "concurrent-a"),
    fixture.transfer("75.00", "concurrent-b"),
  ]);
  const completed = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  const [source, destination, transfers, entries, accounts] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: fixture.source.id } }),
    prisma.account.findUniqueOrThrow({ where: { id: fixture.destination.id } }),
    prisma.transfer.count({ where: { fromAccountId: fixture.source.id } }),
    prisma.ledgerEntry.findMany({ where: { accountId: { in: [fixture.source.id, fixture.destination.id] } } }),
    prisma.account.findMany({ where: { id: { in: [fixture.source.id, fixture.destination.id] } } }),
  ]);

  expectMoney(source.balance, "25.00");
  expectMoney(destination.balance, "75.00");
  assert.ok(accounts.every((account) => decimalToCents(account.balance) >= 0n));
  assert.equal(completed.length, 1);
  assert.equal(rejected.length, 1);
  const errorDetails = rejected[0].reason;
  assert.ok(
    ["INSUFFICIENT_FUNDS", "CONCURRENT_CONFLICT"].includes(errorDetails.code),
    `Unexpected concurrency rejection: ${errorDetails.name} (${errorDetails.code || "no code"}): ${errorDetails.message}`,
  );
  assert.equal(transfers, 1);
  assert.equal(entries.length, 2);
  expectMoney(entries.find((entry) => entry.entryType === "DEBIT").amount, "75.00");
  expectMoney(entries.find((entry) => entry.entryType === "CREDIT").amount, "75.00");
});

test("an audit-write failure rolls back all PostgreSQL transfer changes", async (t) => {
  const fixture = await createFixture(t);
  const failingAuditClient = prisma.$extends({
    query: {
      auditLog: {
        async create({ args, query }) {
          if (args.data.action === "TRANSFER_COMPLETED") {
            throw new Error("Intentional test-only audit failure");
          }
          return query(args);
        },
      },
    },
  });

  await assert.rejects(
    fixture.transfer("12.00", "audit-failure", "Audit rollback test", failingAuditClient),
    /Intentional test-only audit failure/,
  );

  const [source, destination, transfers, entries, keys, logs] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id: fixture.source.id } }),
    prisma.account.findUniqueOrThrow({ where: { id: fixture.destination.id } }),
    prisma.transfer.count({
      where: { OR: [{ fromAccountId: fixture.source.id }, { toAccountId: fixture.destination.id }] },
    }),
    prisma.ledgerEntry.count({ where: { accountId: { in: [fixture.source.id, fixture.destination.id] } } }),
    prisma.idempotencyKey.count({ where: { userId: fixture.userId } }),
    prisma.auditLog.count({ where: { actorId: fixture.userId } }),
  ]);

  expectMoney(source.balance, "100.00");
  expectMoney(destination.balance, "10.00");
  assert.equal(transfers, 0);
  assert.equal(entries, 0);
  assert.equal(keys, 0);
  assert.equal(logs, 0);
});

test.after(async () => {
  await prisma.$disconnect();
});
