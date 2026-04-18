# Release Notes — HITL & Transaction Transparency (April 2026)

This release introduces a robust Human-in-the-Loop (HITL) framework and enhanced transparency tools for AI agent operations.

## 🚀 New Features

### 1. Human-in-the-Loop (HITL) Approval System
Agents can now operate autonomously within safe limits while requiring manual oversight for high-value transactions.
- **Auto-Approval Thresholds**: Added `maxValueForAutoApprovalEth` to Agent Policy (default 0.1 ETH).
- **Pending Approval State**: New `PENDING_APPROVAL` status for transactions that exceed thresholds.
- **Admin Approval API**: New secure endpoints for operators to manually `approve` or `reject` pending transactions.

### 2. Public Transaction Explorer
A new visual "Command Center" for monitoring individual transaction progress and security context.
- **Public Status Page**: Accessible at `/transactions/[id]` without requiring an API key.
- **Simulation Transparency**: Displays Tenderly simulation results (gas, success confidence) to the end-user.
- **On-Chain Verification**: Direct links to block explorers (Basescan, Etherscan) once confirmed.
- **Security Context**: Provides a summary of the MPC (Turnkey) and Policy (Safe) protections active for the transaction.

### 3. Operator Notification Service
Real-time alerts for critical system events.
- **Approval Alerts**: Immediate console notifications with deep-links to the approval UI when a transaction is flagged.
- **Audit Logging**: Enhanced logging for all policy violations and operator actions.
- **Extensible Architecture**: Built-in support for future Discord/Telegram/Webhook integrations.

## 🛠️ Technical Changes
- **Database**: Updated Prisma schema with `PENDING_APPROVAL` status and policy threshold fields.
- **Backend**: Integrated `PolicyService` threshold checks across all transaction routes.
- **Admin UI**: 
  - New `TransactionStatusPage` (public-facing).
  - New `TransactionAdminActions` component for one-click approval/rejection.
  - Sidebar logic updated to hide on public explorer views.

---
*Verified by Gemini CLI Agent*
