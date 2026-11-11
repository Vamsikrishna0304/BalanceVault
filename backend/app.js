require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const prisma = require("./lib/prisma");
const createAuthRouter = require("./routes/auth");
const createAccountsRouter = require("./routes/accounts");
const createAdminRouter = require("./routes/admin");
const createTransfersRouter = require("./routes/transfers");
const { createAuthMiddleware } = require("./middleware/auth");

function createApp({ database = prisma, jwtSecret = process.env.JWT_SECRET } = {}) {
  const app = express();
  const frontendOrigin = process.env.FRONTEND_URL || "http://localhost:5173";
  const { authenticate, requireRole } = createAuthMiddleware({ prisma: database, jwtSecret });

  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
  app.use(helmet());
  app.use(cors({ origin: frontendOrigin, credentials: true }));
  app.use(express.json({ limit: "10kb" }));

  app.use((req, res, next) => {
    const origin = req.get("origin");
    const stateChanging = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (stateChanging && origin) {
      try {
        if (new URL(origin).origin !== new URL(frontendOrigin).origin) {
          return res.status(403).json({ success: false, message: "Request origin is not allowed" });
        }
      } catch {
        return res.status(403).json({ success: false, message: "Request origin is not allowed" });
      }
    }
    return next();
  });

  app.get("/api/health", (req, res) => {
    res.status(200).json({
      success: true,
      message: "BalanceVault API is running",
      timestamp: new Date().toISOString(),
    });
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { success: false, message: "Too many authentication attempts. Try again later." },
  });

  app.use("/api/auth", createAuthRouter({
    prisma: database,
    jwtSecret,
    authenticate,
    authLimiter,
  }));
  app.use("/api/accounts", createAccountsRouter({ prisma: database, authenticate, requireRole }));
  app.use("/api/transfers", createTransfersRouter({ prisma: database, authenticate, requireRole }));
  app.use("/api/admin", createAdminRouter({ prisma: database, authenticate, requireRole }));

  app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("Unhandled API error:", error?.name || "Error");
    return res.status(500).json({ success: false, message: "Internal server error" });
  });

  return app;
}

module.exports = { createApp };
