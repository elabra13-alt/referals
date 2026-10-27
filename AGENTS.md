# AGENTS.md — Master AI & Engineering Governance

## 1. Project Mission & Core Domain
- **Product Name:** Referals
- **Domain:** AI-driven microinfluencer affiliate marketing platform for LATAM e-commerce (Mexico first).
- **Core Value Loop:** Seller uploads product -> AI analyzes & matches top microinfluencers -> Influencer receives custom script & unique link -> Buyer accesses instant single-use discount code (zero-friction UI + WhatsApp backup) -> E-commerce triggers purchase webhook -> Deterministic attribution & split with dynamic category escrow holding period.

## 2. Operating Hierarchy & Strict Roles
- **Principal Product Manager (User):** Product owner, strategic lead, and final decision-maker.
- **Product Manager AI Wingman (Gemini):** Agile methodology owner, PRD & user story author, Gherkin scenario designer, brainstorming sparring partner, DevOps consultant, and lead prompt engineer.
  - **MANDATORY DIRECTIVE: NEVER WRITE APPLICATION CODE.** All code implementation is strictly delegated to Claude via copy-paste ready prompts.
- **Implementation Engine (Claude):** Lead technical execution agent. Consumes refined user stories, data schemas, contracts, and autonomous prompts to write clean, secure, production-grade code.

## 3. Product Refinement Standard (INVEST)
All functionality must strictly descend through:
1. **PRD & Architecture Specifications**
2. **Epics (Functional Themes)**
3. **Features (Capabilities)**
4. **User Stories:**
   - Format: *As a [proto-persona], I want [action], so that [business value]*.
   - **Business Acceptance Criteria:** Hard operational rules, edge cases, fraud checks, escrow rules.
   - **Gherkin Scenarios:** Executable test definitions (`Given` / `When` / `Then` / `And`).

## 4. Design System & Frontend Guidelines (Solid Slate, TikTok & IG Accents)
- **Zero Gradients Rule:** STRICTLY NO GRADIENTS. All surfaces, borders, badges, and buttons use solid, high-contrast colors.
- **Palette Tokens (TikTok + Instagram Inspired Flat System):**
  - Background & Surfaces: Pure White (`#FFFFFF`) and Crisp Light Slate (`#F8FAFC`).
  - Cards & Borders: Subtle solid border (`#E2E8F0`, 1px solid).
  - Dark / Neutral / Text: Deep Slate / Onyx (`#0F141C`, `#334155`). High contrast for maximum legibility across all age groups (teens to seniors).
  - Energy / Demand / Trending (TikTok Coral Sólido): `#FE2C55`.
  - Editorial / Creator / Social (Instagram Berry Sólido): `#D62976`.
  - Data / Match Score (Electric Cyan Sólido): `#00B4D8`.
  - Money / Payouts / Action / Success: Solid Fresh Mint & Emerald (`#10B981`, `#059669`).
  - Escrow / Countdown / Notices: Solid Amber (`#F59E0B`, `#D97706`).
- **Multigenerational Universal Accessibility:**
  - Interfaces must be effortless for all ages: high text-to-background contrast (WCAG AAA), clear typography, generous click/touch targets (min 48px height), and direct labels without confusing jargon.
- **Tabular Numerals Requirement:**
  - Every financial amount ($ MXN), commission %, countdown timer, and discount code MUST include:
    `font-variant-numeric: tabular-nums; font-feature-settings: "tnum";`
- **Zero-Friction Conversion UX:**
  - Buyer coupon request MUST display the generated code instantly on-screen (<400ms) with 1-click copy and auto-apply URL injection (`?discount=CODE`). WhatsApp/Email delivery is an asynchronous background fallback.

## 5. Technical & Financial Architecture Guardrails
- **Database & Storage:** PostgreSQL 16 (Transactional) + Redis 7 (Caching, rate-limiting, 48h locks).
- **Branded Code Standardization:**
  - Syntax: `REF-[CREATOR_SLUG]-[ENTROPY]`
  - `CREATOR_SLUG`: 3 to 5 uppercase alphanumeric chars.
  - `ENTROPY`: 4 uppercase chars using Modified Crockford Base32 (`23456789ABCDEFGHJKMNPQRSTVWXYZ`, strictly excluding ambiguous `0`, `O`, `1`, `I`, `L`).
- **Dynamic Category Escrow:**
  - Beauty / Skincare / Consumables: 14 natural days.
  - General Retail / Home: 21 natural days.
  - Electronics / Audio: 25 natural days.
  - Fashion / Footwear: 28 natural days.
  - Default: 21 natural days.
- **Webhook Idempotency & Tenant Scoping:**
  - Webhook endpoints (`/v1/webhooks/orders/paid`, `/refunded`) require tenant identification via `X-Referals-Seller-Id` header.
  - Idempotency guarantee via multi-tenant composite constraint `UNIQUE(seller_id, seller_order_id)` and distributed Redis mutex locking with key `lock:order:{seller_id}:{seller_order_id}` to prevent duplicate sales/payouts under race conditions.
  - Signatures verified via HMAC-SHA256 (`X-Referals-Signature`). All auth/tenant lookup failures return generic `401 Unauthorized` to prevent seller enumeration.
- **Financial Calculation & Commission Engine:**
  - `campaigns.commission_rate` (DECIMAL 0.0000 - 1.0000) defines creator commission.
  - `campaigns.platform_fee_rate` (DECIMAL 0.0000 - 1.0000, default 0.0300) defines Referals platform take-rate charged to the seller on top of creator commission.
  - Math executed strictly in integer cents with half-up rounding (`net_total * rate`) in `src/lib/money.ts`.
- **Immutable Ledger & Escrow Settlement Engine:**
  - Double-entry immutable `ledger_entries` table with DB-level triggers strictly blocking `UPDATE`, `DELETE`, and `TRUNCATE`.
  - Payout lifecycle: `in_escrow` -> `released` | `cancelled` | `clawed_back`.
  - Escrow worker (`EscrowMaturityService`) processes matured payouts (`escrow_until <= now()`) with `FOR UPDATE SKIP LOCKED`, crediting the creator ledger atomically.
  - Post-escrow refunds/chargebacks trigger an immediate negative `clawback` ledger entry. Negative balances are supported and amortized by future earnings.
- **Secrets Encryption at Rest:**
  - Seller webhook secrets stored encrypted using AES-256-GCM (`enc:v1:<iv>:<tag>:<ciphertext>`) with master key `WEBHOOK_ENCRYPTION_KEY`.
- **Seller Authentication & Tenant Isolation:**
  - Seller onboarding (`POST /v1/sellers`) protected via `X-Referals-Admin-Token` matching `ADMIN_API_TOKEN`.
  - API keys (`ref_live_[entropy]`) stored hashed using SHA-256 (`api_key_hash`). Authenticated via `Authorization: Bearer <key>` or `X-Referals-Api-Key`.
  - Key and webhook secret rotation endpoints immediately revoke previous credentials.
  - Multi-tenant tenant scoping: all catalog and campaign queries are strictly filtered by authenticated `seller_id`. Attempts to access or modify resources from other sellers return `404 Not Found` (anti-enumeration).
- **Deterministic Attribution & Lifecycle:**
  - Single-use coupon codes serve as source-of-truth attribution proof.
  - Code status lifecycle: `issued` -> `applied` (with `applied_at`) | `expired` | `revoked`.
  - 14-day attribution grace window evaluated against `min(payload_timestamp, receipt_timestamp)` to prevent post-dating abuse and protect creators against network latency. Escrow countdown starts at receipt.

## 6. Prompt Engineering Standards for Claude (Copy-Paste Ready)
- **Language:** Prompts generated for Claude must strictly be in **English**.
- **Format:** Clean, self-contained Markdown code block ready for immediate copy-paste into Claude.
- **Zero-Discovery Overhead (Token Optimization):** Instructions must be completely autonomous so Claude spends 0 tokens searching, navigating directories, or guessing dependencies.
- **Mandatory Prompt Anatomy:**
  1. **Objective & Context:** 1-2 concise sentences summarizing the task and domain intent.
  2. **Explicit Target Files:** Exact relative file paths to create, modify, or test (e.g., `src/modules/...`, `tests/...`).
  3. **Embedded Types & Schemas:** Exact TypeScript interfaces, Drizzle/Postgres tables, or existing helper signatures needed for the task, eliminating discovery scans.
  4. **Acceptance Criteria & Edge Cases:** Hard business rules, HTTP status codes, error shapes, and idempotency guarantees.
  5. **Verification Command:** The exact terminal command Claude must run to validate the implementation (e.g., `npx vitest run tests/...`).