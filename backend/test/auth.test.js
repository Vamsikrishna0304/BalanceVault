const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { createApp } = require("../app");

function createTestDatabase() {
  const users = [];
  const auditLogs = [];

  const userModel = {
    findUnique: async ({ where }) => users.find((user) =>
      where.id ? user.id === where.id : user.email === where.email
    ) || null,
    create: async ({ data }) => {
      if (users.some((user) => user.email === data.email)) {
        const error = new Error("Unique constraint");
        error.code = "P2002";
        throw error;
      }
      const user = {
        id: randomUUID(),
        ...data,
        role: "ACCOUNT_HOLDER",
        isActive: true,
        createdAt: new Date(),
      };
      users.push(user);
      return user;
    },
  };

  const auditModel = {
    create: async ({ data }) => {
      const log = { id: randomUUID(), ...data };
      auditLogs.push(log);
      return log;
    },
  };

  return {
    users,
    auditLogs,
    user: userModel,
    $transaction: (callback) => callback({ user: userModel, auditLog: auditModel }),
  };
}

async function startTestServer(t, database) {
  const app = createApp({ database, jwtSecret: "test-secret-with-at-least-32-characters" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function getCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

test("registration creates account-holder only and issues an HttpOnly session", async (t) => {
  const database = createTestDatabase();
  const baseUrl = await startTestServer(t, database);
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Jordan Lee",
      email: "Jordan@example.com",
      password: "correct-horse-battery",
      role: "ADMIN",
    }),
  });
  const body = await response.json();
  const cookie = getCookie(response);

  assert.equal(response.status, 201);
  assert.equal(body.user.role, "ACCOUNT_HOLDER");
  assert.equal(body.token, undefined);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
  assert.equal(database.users[0].email, "jordan@example.com");
  assert.equal(await bcrypt.compare("correct-horse-battery", database.users[0].passwordHash), true);

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, "jordan@example.com");

  const duplicate = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Jordan Lee",
      email: "jordan@example.com",
      password: "correct-horse-battery",
    }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(database.auditLogs.filter((log) => log.action === "USER_REGISTERED").length, 1);
});

test("login rejects invalid passwords, issues a session, and logout clears it", async (t) => {
  const database = createTestDatabase();
  const passwordHash = await bcrypt.hash("safe-password-123", 4);
  database.users.push({
    id: randomUUID(),
    name: "Morgan Chen",
    email: "morgan@example.com",
    passwordHash,
    role: "ACCOUNT_HOLDER",
    isActive: true,
  });
  const baseUrl = await startTestServer(t, database);

  const denied = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "morgan@example.com", password: "wrong-password" }),
  });
  assert.equal(denied.status, 401);

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "MORGAN@example.com", password: "safe-password-123" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, "ACCOUNT_HOLDER");
  const cookie = getCookie(response);
  assert.ok(cookie);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(database.auditLogs.filter((log) => log.action === "USER_LOGIN").length, 1);
});

test("authentication rejects missing, tampered, and inactive-user sessions", async (t) => {
  const database = createTestDatabase();
  const inactiveUserId = randomUUID();
  database.users.push({
    id: inactiveUserId,
    name: "Inactive User",
    email: "inactive@example.com",
    passwordHash: "unused",
    role: "ACCOUNT_HOLDER",
    isActive: false,
  });
  const baseUrl = await startTestServer(t, database);

  const missing = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(missing.status, 401);

  const tampered = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { authorization: "Bearer not-a-valid-token" },
  });
  assert.equal(tampered.status, 401);

  const inactiveToken = jwt.sign(
    { sub: inactiveUserId },
    "test-secret-with-at-least-32-characters",
  );
  const inactive = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { authorization: `Bearer ${inactiveToken}` },
  });
  assert.equal(inactive.status, 401);
});
