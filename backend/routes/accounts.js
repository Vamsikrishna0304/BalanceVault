const express = require("express");
const { randomInt } = require("node:crypto");
const { z } = require("zod");
const { writeAuditLog } = require("../lib/audit");

const createAccountSchema = z.object({
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()).default("INR"),
  ownerId: z.string().uuid().optional(),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function createAccountsRouter({ prisma, authenticate, requireRole }) {
  const router = express.Router();
  router.use(authenticate);
  router.use(requireRole("ADMIN", "ACCOUNT_HOLDER"));

  router.post("/", async (req, res) => {
    const validation = createAccountSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid account details" });
    }

    const ownerId = req.user.role === "ADMIN" ? validation.data.ownerId : req.user.id;
    if (!ownerId) {
      return res.status(400).json({ success: false, message: "An account owner is required" });
    }

    try {
      const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true } });
      if (!owner) {
        return res.status(404).json({ success: false, message: "Account owner not found" });
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const accountNumber = `BV${randomInt(0, 1_000_000_000_000).toString().padStart(12, "0")}`;
        try {
          const account = await prisma.$transaction(async (tx) => {
            const created = await tx.account.create({
              data: {
                accountNumber,
                ownerId,
                currency: validation.data.currency,
              },
            });
            await writeAuditLog(tx, {
              actorId: req.user.id,
              action: "ACCOUNT_CREATED",
              entityType: "Account",
              entityId: created.id,
              details: { ownerId, currency: created.currency },
              ipAddress: req.ip,
            });
            return created;
          });
          return res.status(201).json({ success: true, account });
        } catch (error) {
          if (error.code !== "P2002" || attempt === 4) throw error;
        }
      }
    } catch (error) {
      console.error("Account creation failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Account could not be created" });
    }
  });

  router.get("/", async (req, res) => {
    const validation = paginationSchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid pagination values" });
    }
    const where = req.user.role === "ADMIN" ? {} : { ownerId: req.user.id };
    try {
      const [accounts, total] = await Promise.all([
        prisma.account.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: validation.data.offset,
          take: validation.data.limit,
        }),
        prisma.account.count({ where }),
      ]);
      return res.status(200).json({ success: true, accounts, pagination: { ...validation.data, total } });
    } catch (error) {
      console.error("Account listing failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Accounts could not be loaded" });
    }
  });

  router.get("/:accountId", async (req, res) => {
    const idValidation = z.string().uuid().safeParse(req.params.accountId);
    if (!idValidation.success) {
      return res.status(400).json({ success: false, message: "Invalid account ID" });
    }

    try {
      const account = await prisma.account.findUnique({
        where: { id: idValidation.data },
        include: {
          ledgerEntries: {
            orderBy: { createdAt: "desc" },
            take: 20,
            include: {
              transfer: {
                select: {
                  id: true,
                  fromAccountId: true,
                  toAccountId: true,
                  amount: true,
                  currency: true,
                  status: true,
                  description: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      });

      if (!account || (req.user.role !== "ADMIN" && account.ownerId !== req.user.id)) {
        return res.status(404).json({ success: false, message: "Account not found" });
      }
      return res.status(200).json({ success: true, account });
    } catch (error) {
      console.error("Account lookup failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Account could not be loaded" });
    }
  });

  return router;
}

module.exports = createAccountsRouter;
