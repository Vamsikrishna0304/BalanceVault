const { createHash } = require("node:crypto");
const { writeAuditLog } = require("./audit");

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

class TransferError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "TransferError";
    this.code = code;
    this.status = status;
  }
}

function isSerializationConflict(error) {
  return error.code === "P2034" ||
    (error.code === "P2010" && error.meta?.driverAdapterError?.cause?.originalCode === "40001");
}

function normalizeAmount(value) {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value)) {
    throw new TransferError("INVALID_AMOUNT", "Enter an amount with at most two decimal places");
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n) {
    throw new TransferError("INVALID_AMOUNT", "Transfer amount must be greater than zero");
  }
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function transferRequestHash(userId, input) {
  const canonical = JSON.stringify({
    userId,
    fromAccountId: input.fromAccountId,
    toAccountNumber: input.toAccountNumber,
    amount: input.amount,
    description: input.description || null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function existingIdempotencyResult(record, requestHash) {
  if (record.requestHash !== requestHash) {
    throw new TransferError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used for a different request",
      409,
    );
  }
  if (!record.response) {
    throw new TransferError("REQUEST_IN_PROGRESS", "A request with this key is still being processed", 409);
  }
  return { response: record.response, replayed: true };
}

async function findExistingIdempotency(prisma, userId, key, requestHash) {
  const record = await prisma.idempotencyKey.findUnique({
    where: { userId_key: { userId, key } },
  });
  return record ? existingIdempotencyResult(record, requestHash) : null;
}

async function performTransfer({ prisma, userId, actorIp, idempotencyKey, input }) {
  const amount = normalizeAmount(input.amount);
  const normalizedInput = {
    fromAccountId: input.fromAccountId,
    toAccountNumber: input.toAccountNumber,
    amount,
    description: input.description || null,
  };
  const requestHash = transferRequestHash(userId, normalizedInput);

  const existing = await findExistingIdempotency(prisma, userId, idempotencyKey, requestHash);
  if (existing) return existing;

  const destination = await prisma.account.findUnique({
    where: { accountNumber: normalizedInput.toAccountNumber },
    select: { id: true },
  });
  if (!destination) {
    throw new TransferError("DESTINATION_NOT_FOUND", "Destination account was not found", 404);
  }
  if (destination.id === normalizedInput.fromAccountId) {
    throw new TransferError("SAME_ACCOUNT", "Choose a different destination account");
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.idempotencyKey.create({
          data: { userId, key: idempotencyKey, requestHash },
        });

        const locked = await tx.$queryRaw`
          SELECT "id" FROM "Account"
          WHERE "id" IN (${normalizedInput.fromAccountId}::uuid, ${destination.id}::uuid)
          ORDER BY "id"
          FOR UPDATE
        `;
        if (locked.length !== 2) {
          throw new TransferError("ACCOUNT_NOT_FOUND", "Source or destination account was not found", 404);
        }

        const accounts = await tx.account.findMany({
          where: { id: { in: [normalizedInput.fromAccountId, destination.id] } },
        });
        const byId = new Map(accounts.map((account) => [account.id, account]));
        const sender = byId.get(normalizedInput.fromAccountId);
        const recipient = byId.get(destination.id);

        if (!sender || !recipient) {
          throw new TransferError("ACCOUNT_NOT_FOUND", "Source or destination account was not found", 404);
        }
        if (sender.ownerId !== userId) {
          throw new TransferError("SOURCE_FORBIDDEN", "Source account was not found", 404);
        }
        if (sender.status !== "ACTIVE" || recipient.status !== "ACTIVE") {
          throw new TransferError("ACCOUNT_INACTIVE", "Both accounts must be active to transfer funds", 409);
        }
        if (sender.currency !== recipient.currency) {
          throw new TransferError("CURRENCY_MISMATCH", "Transfers require matching account currencies", 400);
        }

        const transfer = await tx.transfer.create({
          data: {
            fromAccountId: sender.id,
            toAccountId: recipient.id,
            amount,
            currency: sender.currency,
            description: normalizedInput.description,
          },
        });

        const debit = await tx.account.updateMany({
          where: { id: sender.id, status: "ACTIVE", balance: { gte: amount } },
          data: { balance: { decrement: amount } },
        });
        if (debit.count !== 1) {
          throw new TransferError("INSUFFICIENT_FUNDS", "Insufficient funds for this transfer", 409);
        }

        const credit = await tx.account.updateMany({
          where: { id: recipient.id, status: "ACTIVE" },
          data: { balance: { increment: amount } },
        });
        if (credit.count !== 1) {
          throw new TransferError("ACCOUNT_INACTIVE", "Destination account is not active", 409);
        }

        await tx.ledgerEntry.createMany({
          data: [
            {
              transferId: transfer.id,
              accountId: sender.id,
              entryType: "DEBIT",
              amount,
            },
            {
              transferId: transfer.id,
              accountId: recipient.id,
              entryType: "CREDIT",
              amount,
            },
          ],
        });

        const completedTransfer = await tx.transfer.update({
          where: { id: transfer.id },
          data: { status: "COMPLETED" },
        });
        const response = {
          success: true,
          transfer: {
            id: completedTransfer.id,
            fromAccountId: completedTransfer.fromAccountId,
            toAccountId: completedTransfer.toAccountId,
            amount: completedTransfer.amount.toString(),
            currency: completedTransfer.currency,
            status: completedTransfer.status,
            description: completedTransfer.description,
            createdAt: completedTransfer.createdAt.toISOString(),
          },
        };

        await writeAuditLog(tx, {
          actorId: userId,
          action: "TRANSFER_COMPLETED",
          entityType: "Transfer",
          entityId: completedTransfer.id,
          details: {
            fromAccountId: sender.id,
            toAccountId: recipient.id,
            amount,
            currency: sender.currency,
          },
          ipAddress: actorIp,
        });
        await tx.idempotencyKey.update({
          where: { userId_key: { userId, key: idempotencyKey } },
          data: { response },
        });

        return { response, replayed: false };
      }, {
        isolationLevel: "Serializable",
        maxWait: 5000,
        timeout: 10000,
      });
    } catch (error) {
      if (isSerializationConflict(error)) {
        if (attempt < 3) continue;
        throw new TransferError(
          "CONCURRENT_CONFLICT",
          "The transfer conflicted with another update; try again",
          409,
        );
      }
      if (error.code === "P2002") {
        const duplicate = await findExistingIdempotency(prisma, userId, idempotencyKey, requestHash);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  throw new TransferError("CONCURRENT_CONFLICT", "The transfer conflicted with another update; try again", 409);
}

module.exports = {
  TransferError,
  normalizeAmount,
  transferRequestHash,
  performTransfer,
};
