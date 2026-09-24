# Print Billing Software

A modern, multi-tenant billing and operations software tailored for printing, signage, and design businesses. Built with Next.js, React, TypeScript, and MongoDB.

The application operates in **D:\AI\niramaalia** independently. The reference directory `D:\AI\itech` is strictly read-only.

---

## Approved Scope & Features

- **Multi-Tenant Architecture**: Complete tenant isolation for customer profiles, catalogues, invoices, receipts, payment vouchers, jobs, reports, and file storage. Company identity, GSTIN, address, logo, and bank details are derived strictly from tenant settings.
- **Catalogue-Only Products (Zero Stock Tracking)**: Products and services are catalogue entries only. There is no stock tracking, quantity on hand, lots, serials, reservations, inventory movements, or stock adjustments. Invoice line quantity is strictly for billing arithmetic calculation.
- **Mixed Product & Service Invoices**: Invoices support physical printing materials and services with individual descriptions, custom units (`Piece`, `Sheet`, `Page`, `Set`, `Book`, `Square foot`, `Roll`, `Job`, etc.), and detailed print specifications.
- **Printing Specifications**: Optional job specs captured on lines and print jobs: Size, Material, GSM, Colour, Sides, Finishing, Delivery Date, and Notes.
- **Accessible Search Combobox**: Reusable accessible `SearchSelect` component with keyboard navigation, escape-to-close, visible selected value, clear button, debounced live search, and request cancellation across customers, products, services, and invoice selectors.
- **Single-Invoice Customer Receipts**:
  - Customer receipts apply to exactly one unpaid invoice.
  - The unpaid invoice's full due amount is prefilled automatically.
  - The user can enter a smaller partial payment; payment cannot exceed the invoice's balance.
  - Displays remaining balance on the invoice in real time.
  - Multi-invoice allocations, oldest-first auto-split, and receipt-generated customer advances are eliminated.
- **Outgoing Payment Vouchers**:
  - Tenant-scoped transactional outgoing payment vouchers (`PV-...`).
  - Records payee, date, amount, purpose, payment method, reference, notes, and an immutable company snapshot.
  - Does not maintain cash-in-hand, bank balances, account movements, or overdraft rules.
- **Payments UI (`/payments`)**:
  - Prominent sidebar item `Payments & receipts`.
  - Summary cards show document totals for money received and money paid; they are not cash-flow account balances.
  - Two tabs: `Money received` (customer receipts) and `Money paid` (payment vouchers) with search, date filters, modals, and detail preview.
- **Professional Vector Printable Documents**:
  - High-quality vector/text PDFs generated via jsPDF for **Receipts**, **Payment Vouchers**, and **Delivery Challans**.
  - Includes browser print stylesheet, company details from settings, logo, Indian rupee amount-in-words, and dual signature blocks.
- **Delivery Challan**:
  - Non-financial delivery document for issued invoices and print jobs.
  - Displays challan number, date, customer, descriptions, quantities, units, print specifications, delivery notes, and signatures (no financial rates, taxes, or totals).
- **Customer Statement & Payment Reminder**:
  - Customer profile provides instant access to the account ledger statement with PDF/Excel exports.
  - `Create payment reminder` generates a polite, customizable message with tenant name, customer name, total outstanding, unpaid invoice numbers/dates/dues, and tenant bank details from settings.
  - Provides quick `Copy reminder text` and user-initiated `Open WhatsApp` action.
- **Print Jobs Workflow**: Lifecycle tracking: `Received` → `Designing` → `AwaitingApproval` → `Approved` → `Printing` → `Finishing` → `Ready` → `Delivered` → `Cancelled`. Includes atomic sequence generation, optimistic version checks, transactional invoice linking, and Delivery Challan preview.
- **Authoritative Reports**: Approved reports covering Sales, Tax summary (Intra-state & Inter-state GST), Service sales, Payments received, Customer dues, and batch Invoice exports. Excluded modules (Purchases, Suppliers, Expenses dashboard, Daily closing, Profit display) have been cleanly removed.

---

## Getting Started

### 1. Prerequisites
- Node.js (v20+)
- npm (v10+)

### 2. Environment Configuration
Copy `.env.example` to `.env.local` if absent:
```bash
cp .env.example .env.local
```

Configure your environment variables in `.env.local`:
```env
# MongoDB Atlas connection URI and database name
MONGODB_URI="mongodb+srv://<username>:<password>@<cluster>.mongodb.net/niramaalai?retryWrites=true&w=majority"
MONGODB_DB="niramaalai"

# Better Auth Secret (Random string, 32+ characters)
BETTER_AUTH_SECRET="your-32-character-random-secret-key-here"

# Application Origin & Auth URL (Must match)
APP_ORIGIN="http://localhost:3000"
BETTER_AUTH_URL="http://localhost:3000"

# Local-development storage fallback
PRIVATE_STORAGE_ROOT="D:\\AI\\niramaalia_storage"

# Production file storage
CLOUDINARY_CLOUD_NAME="..."
CLOUDINARY_API_KEY="..."
CLOUDINARY_API_SECRET="..."
STORAGE_CREDENTIALS_KEY_V1="..."
```
*Note: Never reuse old or shared credentials from D:\AI\itech.*

### 3. Development Server
Start the local server:
```bash
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## Verification & Test Results

All verification commands have been executed and pass cleanly:

| Check | Command | Result | Details |
|---|---|---|---|
| **TypeScript Typecheck** | `npm run typecheck` | **PASS** | 0 errors across the entire codebase (`tsc --noEmit`) |
| **Domain & Route Integrity Tests** | `npm test` | **PASS** | 12/12 tests passed (`tests/domain.test.mjs`) |
| **Core & Payments Tests** | `npm run test:core` | **PASS** | 28/28 tests passed (`tests/billing-core.test.cjs` & `tests/payments-no-stock.test.cjs`) |
| **Production Build** | `npm run build` | **PASS** | All 32 Next.js routes compiled and generated successfully with webpack |

### Tests Covered in `tests/payments-no-stock.test.cjs`:
1. `RecordCustomerReceiptSchema allows exactly one invoice allocation`
2. `RecordCustomerReceiptSchema rejects multi-invoice allocations`
3. `RecordCustomerReceiptSchema rejects zero invoice allocations`
4. `one receipt applies to one invoice and updates paymentStatus and duePaise to Paid`
5. `partial payment reduces invoice due and marks invoice PartlyPaid`
6. `receipt amount above invoice due is rejected`
7. `receipt amount and allocation mismatch is rejected`
8. `cross-tenant customer receipt is rejected (tenant isolation)`
9. `duplicate receipt idempotency retry returns cached response without double-crediting`
10. `createPaidVoucher generates PV numbering and audit without maintaining account balances`
11. `payment voucher does not require a maintained cash or bank balance`
12. `payment method is recorded without requiring an account selection`
13. `cross-tenant payment voucher GET and listing isolation`
14. `product invoice issues without stock records and never modifies stock collections`
15. `wrong-customer invoice allocation is rejected`
16. `RecordCustomerReceiptSchema rejects zero or negative amounts`
17. `receipt snapshot contains correct before/after balances`
18. `voucher numbering generates sequential tenant-scoped PV numbers`
19. `voucher idempotency returns one voucher without account movements`
20. `two concurrent receipts cannot overpay the invoice`

---

## Current Status & Acceptance Notice

- **Completed**:
  - Full removal of stock tracking, movements, reservations, lots, and serials from products, reports, dashboard, and invoice issuance.
  - Deletion of `/api/inventory` routes and `/api/master/products/[id]/adjust`.
  - Single-invoice customer receipt enforcement with real-time post-payment balance calculation and snapshot preservation.
  - Server-side payment summary totals and independent pagination (25, 50, 100) on Payments page.
  - Outgoing payment voucher APIs (`/api/payments/vouchers`), document summary endpoint (`/api/payments/summary`), and UI (`/payments`). The cash/bank account-balance API has been removed.
  - Accessible `SearchSelect` combobox with live asynchronous search across customers, products, services, and invoice selectors.
  - Delivery Challan preview, browser print, and vector jsPDF generation for invoices and print jobs.
  - Customer payment reminder with editable template, Copy action, and user-initiated WhatsApp link.
  - Focused billing dashboard with sales summary cards, recent invoices, dues requiring attention, recent receipts/vouchers, print jobs by status, and quick billing actions.
  - Full automated test suite (40 total tests across unit and core suites) and clean Next.js production build.
- **Production verification**: Run `npm run verify:atlas`, deploy, then run `npm run verify:production`. The production verifier checks database health, authentication enforcement, removed account-ledger behavior, security headers, and framework-header suppression against `APP_ORIGIN`.
