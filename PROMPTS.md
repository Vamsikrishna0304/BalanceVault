# BalanceVault – AI Development Log

**Project:** BalanceVault – Secure Banking & Transaction Ledger  
**Challenge:** Snovasys Fresher Hiring Challenge 2026  
**Developer:** Vamsi Krishna  
**Development period:** November 2026

This document records how AI coding assistants were used during the development of BalanceVault. AI tools were used for guidance, code suggestions, debugging, and documentation. I reviewed suggestions, ran commands, tested the implementation, and investigated issues during development.

**Note:** The entries below summarize the actual development activities. They are not presented as verbatim copies of every original prompt.

---

## 1. Project Planning and Architecture

**Date:** November 2026

**Development task:** Plan a full-stack banking application.

**Prompt summary:**

Help me plan a secure banking application using React, Node.js, Express, PostgreSQL, and Prisma. Identify the main modules, database entities, API responsibilities, and development phases.

**AI assistance:**
- Suggested a modular frontend and backend architecture.
- Helped identify the main database entities.
- Explained authentication, account management, transfers, and ledger concepts.

**Developer contribution:**
- Selected the project direction and technology stack.
- Set up the project structure.
- Implemented and tested the application incrementally.

---

## 2. Database Design and Prisma Setup

**Date:** November 11, 2026

**Development task:** Design the relational database.

**Prompt summary:**

Help design a Prisma schema for a banking application with users, accounts, transfers, ledger entries, idempotency keys, and audit logs.

**AI assistance:**
- Explained model relationships and database constraints.
- Helped troubleshoot Prisma 7 configuration.
- Assisted with migration and client-generation commands.

**Developer contribution:**
- Configured the Neon PostgreSQL database.
- Created and applied the database migration.
- Verified the database connection and generated Prisma Client.

---

## 3. Authentication and Authorization

**Date:** November 2026

**Development task:** Implement secure authentication and role-based access control.

**Prompt summary:**

Help implement registration and login using bcrypt password hashing and JWT authentication. Ensure that account holders cannot access administrator-only operations and that protected APIs enforce authorization on the backend.

**AI assistance:**
- Explained password hashing and JWT authentication.
- Suggested middleware for authentication and role checks.
- Helped troubleshoot authentication and authorization tests.

**Developer contribution:**
- Integrated the authentication flow.
- Tested registration, login, logout, and protected API requests.
- Verified that account-holder requests cannot access administrator operations.

---

## 4. Account Management and Ownership

**Date:** November 2026

**Development task:** Implement account creation and access restrictions.

**Prompt summary:**

Help implement account creation, account listing, account ownership validation, and administrator-controlled account status transitions.

**AI assistance:**
- Suggested API validation and ownership checks.
- Helped investigate authorization edge cases.

**Developer contribution:**
- Tested account creation and retrieval.
- Verified that users can access only their own accounts.
- Tested administrator account activation and status restrictions.

---

## 5. Transfers, Ledger Entries, and Idempotency

**Date:** November 11–12, 2026

**Development task:** Implement reliable account-to-account transfers.

**Prompt summary:**

Help implement a safe transfer service using PostgreSQL transactions. Ensure source debit and destination credit are recorded together, create matching debit and credit ledger entries, prevent insufficient-funds transfers, and support idempotent retries.

**AI assistance:**
- Explained transactional transfer processing.
- Helped troubleshoot concurrency and retry handling.
- Suggested test cases for duplicate requests and insufficient funds.

**Developer contribution:**
- Implemented and tested the transfer workflow.
- Verified balance updates and matching ledger entries.
- Investigated a concurrency test failure and verified the retry-handling correction.

---

## 6. Audit Logging and Transaction Rollback

**Date:** November 12, 2026

**Development task:** Verify audit logging and transaction consistency.

**Prompt summary:**

Help review audit logging in the transfer workflow. Verify that an audit-write failure does not leave partial balance updates, transfer records, ledger entries, or idempotency records.

**AI assistance:**
- Explained how audit writes participate in a database transaction.
- Helped identify rollback test scenarios.
- Suggested verification of failed transaction behavior.

**Developer contribution:**
- Tested the audit-write failure scenario.
- Verified that transaction changes roll back when the audit write fails.
- Reviewed the resulting integration test output.

---

## 7. Automated Testing and Debugging

**Date:** November 12, 2026

**Development task:** Verify backend, frontend, and PostgreSQL integration tests.

**Prompt summary:**

Help investigate test failures and verify the banking application's authentication, account, transfer, concurrency, idempotency, and rollback behavior.

**AI assistance:**
- Helped interpret Node.js test output.
- Explained PostgreSQL serialization conflicts.
- Assisted with troubleshooting test configuration.

**Developer contribution:**
- Executed tests locally.
- Reviewed failures and corrections.
- Verified the final test results.

**Recorded verification:**
- Backend unit/API tests: 12 passed.
- Frontend API-client tests: 2 passed.
- PostgreSQL transfer integration tests: 5 passed in a separate test run.

---

## 8. Frontend Quality and Documentation

**Date:** November 12, 2026

**Development task:** Verify the frontend and prepare project documentation.

**Prompt summary:**

Help review the existing application and create accurate project documentation, including architecture, features, setup instructions, API endpoints, testing commands, and known limitations.

**AI assistance:**
- Helped structure the README.
- Suggested documentation improvements.
- Helped verify Prisma, lint, test, and build commands.

**Developer contribution:**
- Ran the test suite, lint, and production build.
- Reviewed the README against the actual implementation.
- Committed and pushed the documentation to GitHub.

---

## 9. AI Usage and Development Responsibility

AI tools were used as development assistants, not as substitutes for understanding or verification.

My development workflow included:

1. Understanding the requirement before requesting coding assistance.
2. Reviewing AI-generated suggestions before using them.
3. Integrating changes into the application.
4. Running commands and automated tests.
5. Investigating errors and verifying corrections.
6. Maintaining Git commits and project documentation.

The final implementation and its behavior were verified through local development and testing.

---

**Repository:** https://github.com/Vamsikrishna0304/BalanceVault