const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { createApp } = require("../app");
const { SESSION_COOKIE } = require("../middleware/auth");

const SECRET = "test-secret-with-at-least-32-characters";
const HOLDER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_ACCOUNT_ID = "00000000-0000-4000-8000-000000000004";
const ADMIN_ID = "00000000-0000-4000-8000-000000000006";

function makeAccount(data) {
  const numericBalance = Number(data.balance ?? 0);
  return {
    id: data.id || randomUUID(),
    accountNumber: data.accountNumber,
    ownerId: data.ownerId,
    balance: {
      isZero: () => numericBalance === 0,
      toJSON: () => numericBalance.toFixed(2),
    },
    currency: data.currency || "INR",
    status: data.status || "PENDING",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createDatabase() {
  const users = [
    { id: HOLDER_ID, name: "Account Holder", email: "holder@example.com", role: "ACCOUNT_HOLDER", isActive: true },
    { id: OTHER_ID, name: "Other Holder", email: "other@example.com", role: "ACCOUNT_HOLDER", isActive: true },
    { id: ADMIN_ID, name: "Admin", email: "admin@example.com", role: "ADMIN", isActive: true },
  ];
  const accounts = [
    makeAccount({ id: ACCOUNT_ID, accountNumber: "BV000000000001", ownerId: HOLDER_ID, status: "ACTIVE", balance: 50 }),
    makeAccount({ id: OTHER_ACCOUNT_ID, accountNumber: "BV000000000002", ownerId: OTHER_ID, status: "ACTIVE" }),
  ];
  const auditLogs = [];

  const userModel = {
    findUnique: async ({ where }) => users.find((user) =>
      where.id ? user.id === where.id : user.email === where.email
    ) || null,
  };
  const accountModel = {
    create: async ({ data }) => {
      const account = makeAccount(data);
      accounts.push(account);
      return account;
    },
    findMany: async ({ where }) => accounts.filter((account) =>
      !where.ownerId || account.ownerId === where.ownerId
    ),
    count: async ({ where } = {}) => accounts.filter((account) =>
      !where?.ownerId || account.ownerId === where.ownerId
    ).length,
    findUnique: async ({ where }) => accounts.find((account) => account.id === where.id) || null,
    updateMany: async ({ where, data }) => {
      const account = accounts.find((record) =>
        record.id === where.id && record.status === where.status
      );
      if (!account) return { count: 0 };
      account.status = data.status;
      return { count: 1 };
    },
  };
  const auditModel = {
    create: async ({ data }) => {
      const log = { id: randomUUID(), ...data };
      auditLogs.push(log);
      return log;
    },
  };
  const database = {
    users,
    accounts,
    auditLogs,
    user: userModel,
    account: accountModel,
    $transaction: (callback) => callback({
      user: userModel,
      account: accountModel,
      auditLog: auditModel,
    }),
  };
  return database;
}

async function startTestServer(t, database, userId = HOLDER_ID, role = "ACCOUNT_HOLDER") {
  const app = createApp({ database, jwtSecret: SECRET });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const token = jwt.sign({ sub: userId, role }, SECRET, { expiresIn: "1h" });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  };
}

test("account holders can only create and list their own pending accounts", async (t) => {
  const database = createDatabase();
  const { baseUrl, headers } = await startTestServer(t, database);

  const createdResponse = await fetch(`${baseUrl}/api/accounts`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ currency: "inr", ownerId: OTHER_ID }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201);
  assert.equal(created.account.ownerId, HOLDER_ID);
  assert.equal(created.account.status, "PENDING");
  assert.match(created.account.accountNumber, /^BV\d{12}$/);

  const listedResponse = await fetch(`${baseUrl}/api/accounts`, { headers });
  const listed = await listedResponse.json();
  assert.equal(listed.accounts.length, 2);
  assert.ok(listed.accounts.every((account) => account.ownerId === HOLDER_ID));

  const otherAccount = await fetch(`${baseUrl}/api/accounts/${OTHER_ACCOUNT_ID}`, { headers });
  assert.equal(otherAccount.status, 404);
  assert.equal(database.auditLogs.filter((log) => log.action === "ACCOUNT_CREATED").length, 1);
});

test("account-holder requests cannot use admin APIs", async (t) => {
  const database = createDatabase();
  const { baseUrl, headers } = await startTestServer(t, database);

  const response = await fetch(`${baseUrl}/api/admin/overview`, { headers });
  assert.equal(response.status, 403);
});

test("unauthenticated requests to the malformed account-status path return 401", async (t) => {
  const database = createDatabase();
  const { baseUrl } = await startTestServer(t, database);

  const response = await fetch(`${baseUrl}/api/admin/accounts//status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "ACTIVE" }),
  });

  assert.equal(response.status, 401);
});

test("account holders cannot change account status, even with a valid account ID", async (t) => {
  const database = createDatabase();
  const { baseUrl, headers } = await startTestServer(t, database);

  const response = await fetch(`${baseUrl}/api/admin/accounts/${ACCOUNT_ID}/status`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "FROZEN" }),
  });

  assert.equal(response.status, 403);
  assert.equal(database.accounts.find((account) => account.id === ACCOUNT_ID).status, "ACTIVE");
  assert.equal(database.auditLogs.length, 0);
});

test("admins can activate pending accounts but cannot close accounts with balances", async (t) => {
  const database = createDatabase();
  const pendingId = "00000000-0000-4000-8000-000000000005";
  database.accounts.push(makeAccount({
    id: pendingId,
    accountNumber: "BV000000000003",
    ownerId: HOLDER_ID,
    status: "PENDING",
  }));
  const { baseUrl, headers } = await startTestServer(t, database, ADMIN_ID, "ADMIN");

  const activated = await fetch(`${baseUrl}/api/admin/accounts/${pendingId}/status`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "ACTIVE" }),
  });
  assert.equal(activated.status, 200);
  assert.equal((await activated.json()).account.status, "ACTIVE");
  assert.equal(database.accounts.find((account) => account.id === pendingId).status, "ACTIVE");

  const invalidTransition = await fetch(`${baseUrl}/api/admin/accounts/${pendingId}/status`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "PENDING" }),
  });
  assert.equal(invalidTransition.status, 409);
  assert.equal(database.accounts.find((account) => account.id === pendingId).status, "ACTIVE");

  const closeWithBalance = await fetch(`${baseUrl}/api/admin/accounts/${ACCOUNT_ID}/status`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "CLOSED" }),
  });
  assert.equal(closeWithBalance.status, 409);
});
