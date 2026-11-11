const express = require("express");
const { z } = require("zod");
const { writeAuditLog } = require("../lib/audit");

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const statusSchema = z.object({
  status: z.enum(["PENDING", "ACTIVE", "FROZEN", "CLOSED"]),
});

const allowedTransitions = {
  PENDING: ["ACTIVE", "CLOSED"],
  ACTIVE: ["FROZEN", "CLOSED"],
  FROZEN: ["ACTIVE", "CLOSED"],
  CLOSED: [],
};

function createAdminRouter({ prisma, authenticate, requireRole }) {
  const router = express.Router();
  router.use(authenticate, requireRole("ADMIN"));

  router.get("/overview", async (req, res) => {
    try {
      const [userCount, accountCount, accountStatuses, transferCount, completedTransfers] = await Promise.all([
        prisma.user.count(),
        prisma.account.count(),
        prisma.account.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.transfer.count(),
        prisma.transfer.groupBy({
          by: ["currency"],
          where: { status: "COMPLETED" },
          _sum: { amount: true },
          _count: { _all: true },
        }),
      ]);
      return res.status(200).json({
        success: true,
        overview: {
          userCount,
          accountCount,
          accountStatuses: Object.fromEntries(accountStatuses.map(({ status, _count }) => [status, _count._all])),
          transferCount,
          completedTransferCount: completedTransfers.reduce((total, item) => total + item._count._all, 0),
          completedTransferVolumes: Object.fromEntries(
            completedTransfers.map(({ currency, _sum }) => [currency, _sum.amount?.toString() || "0"]),
          ),
        },
      });
    } catch (error) {
      console.error("Admin overview failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Admin overview could not be loaded" });
    }
  });

  router.get("/users", async (req, res) => {
    const validation = paginationSchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid pagination values" });
    }
    try {
      const [users, total] = await Promise.all([
        prisma.user.findMany({
          select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          skip: validation.data.offset,
          take: validation.data.limit,
        }),
        prisma.user.count(),
      ]);
      return res.status(200).json({ success: true, users, pagination: { ...validation.data, total } });
    } catch (error) {
      console.error("Admin user listing failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Users could not be loaded" });
    }
  });

  router.get("/transfers", async (req, res) => {
    const validation = paginationSchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid pagination values" });
    }
    try {
      const [transfers, total] = await Promise.all([
        prisma.transfer.findMany({
          orderBy: { createdAt: "desc" },
          skip: validation.data.offset,
          take: validation.data.limit,
          include: {
            fromAccount: { select: { accountNumber: true, owner: { select: { name: true, email: true } } } },
            toAccount: { select: { accountNumber: true, owner: { select: { name: true, email: true } } } },
          },
        }),
        prisma.transfer.count(),
      ]);
      return res.status(200).json({ success: true, transfers, pagination: { ...validation.data, total } });
    } catch (error) {
      console.error("Admin transfer listing failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Transfers could not be loaded" });
    }
  });

  router.get("/audit-logs", async (req, res) => {
    const validation = paginationSchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid pagination values" });
    }
    try {
      const [auditLogs, total] = await Promise.all([
        prisma.auditLog.findMany({
          orderBy: { createdAt: "desc" },
          skip: validation.data.offset,
          take: validation.data.limit,
          include: { actor: { select: { name: true, email: true } } },
        }),
        prisma.auditLog.count(),
      ]);
      return res.status(200).json({ success: true, auditLogs, pagination: { ...validation.data, total } });
    } catch (error) {
      console.error("Audit log listing failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Audit logs could not be loaded" });
    }
  });

  router.patch("/accounts/:accountId/status", async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.accountId);
    const validation = statusSchema.safeParse(req.body);
    if (!id.success || !validation.success) {
      return res.status(400).json({ success: false, message: "Invalid account status request" });
    }

    try {
      const account = await prisma.$transaction(async (tx) => {
        const current = await tx.account.findUnique({ where: { id: id.data } });
        if (!current) return null;
        if (!allowedTransitions[current.status].includes(validation.data.status)) {
          const error = new Error("Invalid account status transition");
          error.code = "INVALID_STATUS_TRANSITION";
          throw error;
        }
        if (validation.data.status === "CLOSED" && !current.balance.isZero()) {
          const error = new Error("Account balance must be zero before closure");
          error.code = "ACCOUNT_HAS_BALANCE";
          throw error;
        }

        const updated = await tx.account.updateMany({
          where: { id: current.id, status: current.status },
          data: { status: validation.data.status },
        });
        if (updated.count !== 1) {
          const error = new Error("Account status changed concurrently");
          error.code = "STATUS_CONFLICT";
          throw error;
        }
        await writeAuditLog(tx, {
          actorId: req.user.id,
          action: "ACCOUNT_STATUS_CHANGED",
          entityType: "Account",
          entityId: current.id,
          details: { from: current.status, to: validation.data.status },
          ipAddress: req.ip,
        });
        return tx.account.findUnique({ where: { id: current.id } });
      }, { isolationLevel: "Serializable" });

      if (!account) return res.status(404).json({ success: false, message: "Account not found" });
      return res.status(200).json({ success: true, account });
    } catch (error) {
      if (error.code === "INVALID_STATUS_TRANSITION") {
        return res.status(409).json({ success: false, message: error.message });
      }
      if (error.code === "ACCOUNT_HAS_BALANCE") {
        return res.status(409).json({ success: false, message: "Account balance must be zero before closure" });
      }
      if (error.code === "STATUS_CONFLICT" || error.code === "P2034") {
        return res.status(409).json({ success: false, message: "Account changed during the request; try again" });
      }
      console.error("Account status update failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Account status could not be changed" });
    }
  });

  return router;
}

module.exports = createAdminRouter;
