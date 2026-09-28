# SB01 Cloudflare Worker owner runbook

สถานะ: ขั้นเตรียม source เท่านั้น — ยังไม่อนุญาตให้ Owner deploy จนกว่าจะมี independent review และ release GO ตาม `BILLING_CORE_PLAN.md`.

`wrangler.jsonc` currently uses an all-zero Hyperdrive ID as a dry-run placeholder. The live environment also has no production profile/credential activation in this branch. Owner/reviewer must replace/configure these through the separately approved release process before any deploy; the placeholder is not a usable binding.

## Runtime ที่ล็อก

- Entry point: `platform/runtime/src/worker.ts` (Hono `fetch` + Cloudflare `scheduled()`).
- Cron: ทุก 15 นาที; จำกัดการ drain สูงสุด 20 jobs ต่อรอบ และไม่มี public cron route.
- PostgreSQL production binding: Cloudflare Hyperdrive `HYPERDRIVE`; ห้ามตั้ง `BILLING_DATABASE_URL` บน hosted Worker.
- Worker secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_PRODUCT_CREDENTIALS_JSON`, `BILLING_ACCOUNT_ASSERTION_KEYS_JSON`, `BILLING_ENTITLEMENT_SIGNING_KEYS_JSON`.
- Worker configuration: `BILLING_ENVIRONMENT`, `BILLING_SCHEMA`, `BILLING_ADMISSION_TEST_MODE`, `BILLING_WEBHOOK_MAX_BYTES`, `BILLING_RETURN_URLS_JSON`, `PS01_ANNUAL_LAUNCH_STARTS_AT`, `PS01_ANNUAL_LAUNCH_ENDS_AT`.
- ต้องตั้ง annual launch window เป็น ISO-8601 ที่ถูกต้องทั้ง start/end; Worker ปฏิเสธค่าที่ขาดไปข้างหนึ่งหรือ end ไม่หลัง start.

## ก่อน Owner กด deploy

1. Reviewer ตรวจ source SHA ล่าสุด, full test/real-Postgres evidence, Wrangler dry run, Stripe TEST object IDs และ schema/role contract.
2. Owner ตรวจ Hyperdrive ชี้ Project A production endpoint และ scoped production role ตาม `BILLING_CORE_PLAN.md`; ห้ามใช้ direct DB connection string.
3. Owner สร้าง Cloudflare secrets ผ่าน Dashboard โดยนำค่าจาก secret store ที่กำหนดให้ SB01 เท่านั้น. ห้ามใส่ secrets ใน Wrangler vars, repository, task log หรือ chat.
4. ตรวจค่าตั้ง `BILLING_ENVIRONMENT=production`, `BILLING_SCHEMA=billing_core`, disabled admission mode, return URL allowlist และช่วงราคา annual.
5. ใช้ Cloudflare Dashboard preview/review ขั้นตอน release ที่อนุมัติแล้ว. บรีฟรอบนี้อนุญาตเพียง `wrangler deploy --dry-run`; ห้ามใช้คำสั่ง deploy จริงในงานนี้.

## Rollback

Owner ใช้ Cloudflare Dashboard กลับไป deployment Worker version ก่อนหน้าที่ทราบ SHA และยืนยัน health/cron logs. ห้าม rollback ด้วยการลบ billing rows หรือย้อน migration ที่เก็บข้อมูลการเงิน. กรณี DB schema mismatch ให้ปิด checkout/credentials ด้วยขั้นที่ Owner และ reviewer อนุมัติ แล้วกู้ด้วย forward fix; อย่ารัน `0002` rollback บน production.
