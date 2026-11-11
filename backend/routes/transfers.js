const express = require("express");
const { z } = require("zod");
const { performTransfer, TransferError } = require("../lib/transfers");

const createTransferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountNumber: z.string().trim().min(1).max(64),
  amount: z.string(),
  description: z.string().trim().max(140).optional(),
}).strict();

const paginationSchema = z.object({
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const idempotencyKeySchema = z.string().trim().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);

function createTransfersRouter({ prisma, authenticate, requireRole }) {
  const router = express.Router();
  router.use(authenticate, requireRole("ACCOUNT_HOLDER"));

  router.post("/", async (req, res) => {
    const validation = createTransferSchema.safeParse(req.body);
    const key = idempotencyKeySchema.safeParse(req.get("idempotency-key"));
    if (!validation.success || !key.success) {
      return res.status(400).json({
        success: false,
        message: "Provide valid transfer details and an Idempotency-Key header",
      });
    }

    try {
      const result = await performTransfer({
        prisma,
        userId: req.user.id,
        actorIp: req.ip,
        idempotencyKey: key.data,
        input: validation.data,
      });
      return res.status(result.replayed ? 200 : 201).json(result.response);
    } catch (error) {
      if (error instanceof TransferError) {
        return res.status(error.status).json({ success: false, message: error.message, code: error.code });
      }
      if (error.code === "P2034" ||
        (error.code === "P2010" && error.meta?.driverAdapterError?.cause?.originalCode === "40001")) {
        return res.status(409).json({
          success: false,
          message: "The transfer conflicted with another update; try again",
          code: "CONCURRENT_CONFLICT",
        });
      }
      console.error("Transfer failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Transfer could not be completed" });
    }
  });

  router.get("/", async (req, res) => {
    const validation = paginationSchema.safeParse(req.query);
    if (!validation.success) {
      return res.status(400).json({ success: false, message: "Invalid transfer query" });
    }

    const ownership = {
      OR: [
        { fromAccount: { is: { ownerId: req.user.id } } },
        { toAccount: { is: { ownerId: req.user.id } } },
      ],
    };
    const filters = [ownership];
    if (validation.data.accountId) {
      const account = await prisma.account.findFirst({
        where: { id: validation.data.accountId, ownerId: req.user.id },
        select: { id: true },
      });
      if (!account) {
        return res.status(404).json({ success: false, message: "Account not found" });
      }
      filters.push({
        OR: [
          { fromAccountId: validation.data.accountId },
          { toAccountId: validation.data.accountId },
        ],
      });
    }
    const where = { AND: filters };

    try {
      const [transfers, total] = await Promise.all([
        prisma.transfer.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: validation.data.offset,
          take: validation.data.limit,
          include: {
            fromAccount: { select: { accountNumber: true } },
            toAccount: { select: { accountNumber: true } },
          },
        }),
        prisma.transfer.count({ where }),
      ]);
      return res.status(200).json({
        success: true,
        transfers,
        pagination: {
          limit: validation.data.limit,
          offset: validation.data.offset,
          total,
        },
      });
    } catch (error) {
      console.error("Transfer history failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Transfer history could not be loaded" });
    }
  });

  router.get("/:transferId", async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.transferId);
    if (!id.success) {
      return res.status(400).json({ success: false, message: "Invalid transfer ID" });
    }
    try {
      const transfer = await prisma.transfer.findFirst({
        where: {
          AND: [
            { id: id.data },
            {
              OR: [
                { fromAccount: { is: { ownerId: req.user.id } } },
                { toAccount: { is: { ownerId: req.user.id } } },
              ],
            },
          ],
        },
        include: {
          fromAccount: { select: { id: true, accountNumber: true } },
          toAccount: { select: { id: true, accountNumber: true } },
          ledgerEntries: true,
        },
      });
      if (!transfer) {
        return res.status(404).json({ success: false, message: "Transfer not found" });
      }
      return res.status(200).json({ success: true, transfer });
    } catch (error) {
      console.error("Transfer lookup failed:", error?.name || "Error");
      return res.status(500).json({ success: false, message: "Transfer could not be loaded" });
    }
  });

  return router;
}

module.exports = createTransfersRouter;
