# BalanceVault – Threat Model

## 1. Authentication Threats
**Threat:** Unauthorized users may attempt to access accounts.

**Mitigation:** Password hashing with bcrypt, JWT-based authentication, and secure HTTP-only session cookies.

## 2. Authorization Threats
**Threat:** Users may attempt to access another customer's accounts or administrator functions.

**Mitigation:** Server-side role-based access control and account ownership checks.

## 3. Financial Transaction Threats
**Threat:** Users may attempt transfers exceeding their available balance.

**Mitigation:** Server-side balance validation and database transactions.

## 4. Duplicate Transfer Threats
**Threat:** Retried requests may cause duplicate transfers.

**Mitigation:** Idempotency keys and database constraints.

## 5. Ledger Integrity Threats
**Threat:** Incorrect or incomplete ledger entries may cause unbalanced transactions.

**Mitigation:** Double-entry ledger records created within database transactions.

## 6. Audit and Accountability
**Threat:** Sensitive administrative actions may be difficult to trace.

**Mitigation:** Audit logs record important actions such as administrator role changes and account status updates.

## 7. Deployment and Configuration Risks
**Threat:** Exposed secrets or incorrect environment configuration may compromise the application.

**Mitigation:** Environment variables, ignored `.env` files, and HTTPS for deployed services.

## 8. Limitations
BalanceVault is an educational banking application and is not connected to real banking networks. It has not undergone an independent security audit or production compliance assessment.