const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { normalizeAmount, performTransfer, TransferError } = require("../lib/transfers");

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const FROM_ID = "00000000-0000-4000-8000-000000000003";
const TO_ID = "00000000-0000-4000-8000-000000000004";

function cents(value) {
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function decimal(value) {
  const amount = BigInt(value);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}

function createTransferDatabase(initialBalance = "100.00", destinationBalance = "10.00") {
  let state = {
    accounts: [
      {
        id: FROM_ID,
        accountNumber: "BV000000000001",
        ownerId: USER_ID,
        balance: initialBalance,
        currency: "INR",
        status: "ACTIVE",
      },
      {
        id: TO_ID,
        accountNumber: "BV000000000002",
        ownerId: OTHER_USER_ID,
        balance: destinationBalance,
        currency: "INR",
        status: "ACTIVE",
      },
    ],
    transfers: [],
    ledgerEntries: [],
    idempotencyKeys: [],
    auditLogs: [],
  };
  let transactionTail = Promise.resolve();

  const idempotencyFindUnique = async ({ where }) => state.idempotencyKeys.find((record) =>
    record.userId === where.userId_key.userId && record.key === where.userId_key.key
  ) || null;

  const database = {
    get state() {
      return state;
    },
    idempotencyKey: { findUnique: idempotencyFindUnique },
    account: {
      findUnique: async ({ where }) => state.accounts.find((account) =>
        where.accountNumber ? account.accountNumber === where.accountNumber : account.id === where.id
      ) || null,
    },
    $transaction: async (callback) => {
      let release;
      const previous = transactionTail;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await previous;
      const draft = structuredClone(state);
      const accountModel = {
        findMany: async ({ where }) => draft.accounts.filter((account) => where.id.in.includes(account.id)),
        updateMany: async ({ where, data }) => {
          const account = draft.accounts.find((item) => item.id === where.id);
          if (!account || (where.status && account.status !== where.status)) return { count: 0 };
          if (where.balance?.gte && cents(account.balance) < cents(where.balance.gte)) return { count: 0 };
          if (data.balance?.decrement) {
            account.balance = decimal(cents(account.balance) - cents(data.balance.decrement));
          }
          if (data.balance?.increment) {
            account.balance = decimal(cents(account.balance) + cents(data.balance.increment));
          }
          return { count: 1 };
        },
      };
      const transferModel = {
        create: async ({ data }) => {
          const transfer = { id: randomUUID(), ...data, status: "PENDING", createdAt: new Date() };
          draft.transfers.push(transfer);
          return transfer;
        },
        update: async ({ where, data }) => {
          const transfer = draft.transfers.find((item) => item.id === where.id);
          Object.assign(transfer, data);
          return transfer;
        },
      };
      const idempotencyModel = {
        create: async ({ data }) => {
          if (draft.idempotencyKeys.some((item) => item.userId === data.userId && item.key === data.key)) {
            const error = new Error("Unique idempotency key");
            error.code = "P2002";
            throw error;
          }
          draft.idempotencyKeys.push({ ...data, response: null });
        },
        update: async ({ where, data }) => {
          const record = draft.idempotencyKeys.find((item) =>
            item.userId === where.userId_key.userId && item.key === where.userId_key.key
          );
          Object.assign(record, data);
          return record;
        },
      };

      try {
        const result = await callback({
          $queryRaw: async (strings, ...values) => values.map((id) => ({ id })).sort((a, b) => a.id.localeCompare(b.id)),
          account: accountModel,
          transfer: transferModel,
          ledgerEntry: {
            createMany: async ({ data }) => {
              draft.ledgerEntries.push(...data.map((entry) => ({ id: randomUUID(), ...entry })));
              return { count: data.length };
            },
          },
          idempotencyKey: idempotencyModel,
          auditLog: {
            create: async ({ data }) => {
              const log = { id: randomUUID(), ...data };
              draft.auditLogs.push(log);
              return log;
            },
          },
        });
        state = draft;
        return result;
      } finally {
        release();
      }
    },
  };
  return database;
}

const transferInput = {
  fromAccountId: FROM_ID,
  toAccountNumber: "BV000000000002",
  amount: "12.3",
  description: "Test transfer",
};

function runTransfer(prisma, key, input = transferInput) {
  return performTransfer({
    prisma,
    userId: USER_ID,
    actorIp: "127.0.0.1",
    idempotencyKey: key,
    input,
  });
}

test("amount validation uses exact two-decimal precision", () => {
  assert.equal(normalizeAmount("12"), "12.00");
  assert.equal(normalizeAmount("12.3"), "12.30");
  assert.equal(normalizeAmount("9999999999999999.99"), "9999999999999999.99");
  for (const invalid of ["0", "0.00", "-1", "1.001", "1e2", "10000000000000000", 1]) {
    assert.throws(() => normalizeAmount(invalid), TransferError);
  }
});

test("a transfer updates balances, writes equal ledger entries, and replays idempotently", async () => {
  const database = createTransferDatabase();
  const key = "test-transfer-key-0001";
  const first = await runTransfer(database, key);

  assert.equal(first.replayed, false);
  assert.equal(first.response.transfer.status, "COMPLETED");
  assert.equal(first.response.transfer.amount, "12.30");
  assert.equal(database.state.accounts.find((account) => account.id === FROM_ID).balance, "87.70");
  assert.equal(database.state.accounts.find((account) => account.id === TO_ID).balance, "22.30");
  assert.equal(database.state.transfers.length, 1);
  assert.equal(database.state.ledgerEntries.length, 2);
  assert.deepEqual(
    database.state.ledgerEntries.map((entry) => [entry.entryType, entry.amount]),
    [["DEBIT", "12.30"], ["CREDIT", "12.30"]],
  );
  assert.equal(database.state.auditLogs.length, 1);

  const replay = await runTransfer(database, key);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, first.response);
  assert.equal(database.state.transfers.length, 1);

  await assert.rejects(
    runTransfer(database, key, { ...transferInput, amount: "12.31" }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("insufficient funds roll back the debit, transfer, ledger, audit, and idempotency record", async () => {
  const database = createTransferDatabase("10.00", "0.00");

  await assert.rejects(
    runTransfer(database, "test-transfer-key-0002", { ...transferInput, amount: "11.00" }),
    (error) => error.code === "INSUFFICIENT_FUNDS",
  );
  assert.equal(database.state.accounts.find((account) => account.id === FROM_ID).balance, "10.00");
  assert.equal(database.state.accounts.find((account) => account.id === TO_ID).balance, "0.00");
  assert.equal(database.state.transfers.length, 0);
  assert.equal(database.state.ledgerEntries.length, 0);
  assert.equal(database.state.auditLogs.length, 0);
  assert.equal(database.state.idempotencyKeys.length, 0);
});

test("concurrent debits cannot overdraw a shared source account", async () => {
  const database = createTransferDatabase("100.00", "0.00");
  const outcomes = await Promise.allSettled([
    runTransfer(database, "test-transfer-key-0003", { ...transferInput, amount: "75.00" }),
    runTransfer(database, "test-transfer-key-0004", { ...transferInput, amount: "75.00" }),
  ]);
  const completed = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

  assert.equal(completed.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "INSUFFICIENT_FUNDS");
  assert.equal(database.state.accounts.find((account) => account.id === FROM_ID).balance, "25.00");
  assert.equal(database.state.ledgerEntries.length, 2);
  assert.ok(database.state.ledgerEntries.every((entry) => entry.amount === "75.00"));
});
