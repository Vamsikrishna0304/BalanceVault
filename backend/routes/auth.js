
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const { writeAuditLog } = require("../lib/audit");
const { setSessionCookie, clearSessionCookie } = require("../middleware/auth");

const DUMMY_PASSWORD_HASH = "$2b$12$vGraUhMRtAJc3I9nJmGkqOkk1b1hsuQbmwSIDtuFWAt6OhxqXAz4e";

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().transform(value => value.toLowerCase()),
  password: z.string().min(8).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72),
});

const loginSchema = z.object({
  email: z.string().trim().email().transform(value => value.toLowerCase()),
  password: z.string().min(1).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72),
});

function createAuthRouter({ prisma, jwtSecret, authenticate, authLimiter }) {
  const router = express.Router();

  router.post("/register", authLimiter, async (req, res) => {
    const validation = registerSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid registration details" });
    }

    if (!jwtSecret) {
      return res.status(500).json({ success: false, message: "Authentication configuration error" });
    }

    const { name, email, password } = validation.data;
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { name, email, passwordHash },
          select: { id: true, name: true, email: true, role: true },
        });
        await writeAuditLog(tx, {
          actorId: created.id,
          action: "USER_REGISTERED",
          entityType: "User",
          entityId: created.id,
          ipAddress: req.ip,
        });
        return created;
      });

      const token = jwt.sign({ sub: user.id }, jwtSecret, { expiresIn: "1h", algorithm: "HS256" });
      setSessionCookie(res, token);
      return res.status(201).json({
        success: true,
        message: "Registration successful",
        user,
      });
    } catch (error) {
      if (error.code === "P2002") {
        return res.status(409).json({ success: false, message: "Email already registered" });
      }
      console.error("Registration failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Registration failed" });
    }
  });

  router.post("/login", authLimiter, async (req, res) => {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid email or password" });
    }
    if (!jwtSecret) {
      return res.status(500).json({ success: false, message: "Authentication configuration error" });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { email: validation.data.email },
        select: { id: true, name: true, email: true, role: true, isActive: true, passwordHash: true },
      });
      const passwordMatches = user
        ? await bcrypt.compare(validation.data.password, user.passwordHash)
        : await bcrypt.compare(validation.data.password, DUMMY_PASSWORD_HASH);

      if (!user || !user.isActive || !passwordMatches) {
        return res.status(401).json({ success: false, message: "Invalid email or password" });
      }

      const token = jwt.sign({ sub: user.id }, jwtSecret, { expiresIn: "1h", algorithm: "HS256" });
      await prisma.$transaction(async (tx) => {
        await writeAuditLog(tx, {
          actorId: user.id,
          action: "USER_LOGIN",
          entityType: "User",
          entityId: user.id,
          ipAddress: req.ip,
        });
      });
      setSessionCookie(res, token);
      return res.status(200).json({
        success: true,
        message: "Login successful",
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
      });
    } catch (error) {
      console.error("Login failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Login failed" });
    }
  });

  router.post("/logout", (req, res) => {
    clearSessionCookie(res);
    return res.status(200).json({ success: true, message: "Logged out" });
  });

  router.get("/me", authenticate, (req, res) => {
    return res.status(200).json({ success: true, user: req.user });
  });

  return router;
}

module.exports = createAuthRouter;
module.exports.registerSchema = registerSchema;
module.exports.loginSchema = loginSchema;
