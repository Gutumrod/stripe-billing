# SB01 Real-Money Readiness — 2026-09-28

Task: `HOUSE-SB01-REAL-MONEY`
Branch: `codex/sb01-real-money-20260928`
สถานะ: งาน implementation ระดับ source/test; **HOLD — ยังห้าม deploy หรือเปิดรับเงินจริง**

## ขอบเขตและสถานะปัจจุบัน

- Runtime แยก `BILLING_ENVIRONMENT=test|production`; `production` ผูกกับ environment ภายใน `live` และ schema `billing_core`. Test ผูก `billing_core_staging`. Stripe key prefix ต้องตรง environment; test runtime ปฏิเสธ live keys, objects และ webhooks.
- Checkout เก็บ THB/USD แบบจำนวนตายตัวใน profile; `locale=th` เลือก THB และ `locale=en` เลือก USD. ไม่มีการแปลงค่าเงินอัตโนมัติ.
- PS01 profile v2 เป็น candidate ที่ยัง `pending_validation`; มี A-10 monthly/annual price data แต่ mappings ยังไม่ครบ และ annual offer ยังปิดจนกว่าจะกำหนด sales window. มีเพียง Pro monthly THB ที่ผูก TEST Price เดิม.
- เพิ่ม reconciliation สำหรับ `charge.refunded`, purchase ledger แบบ one-time, สิทธิใช้ source ต่อเนื่องหลังปีแรก, วันหมดอายุ update 12 เดือน, และการถอนสิทธิเมื่อคืนเงินเต็มจำนวน. Partial refund ไม่ถอนสิทธิ. Refund ที่มาถึงก่อน purchase จะถูกเก็บไว้และจับคู่ตอน purchase reconcile.
- Module Hub profile candidate เก็บ A-12 เป็น versioned profile data: 8 โมดูลและ bundle-8, ซื้อขาด, ไม่มี renewal product, update ฟรี 12 เดือน. ตัวเลขอยู่นอก business logic. Profile ไม่มี Stripe Price IDs และยัง `pending_validation`.
- Module Hub SKUs ที่บรีฟไม่ได้ล็อกยังไม่ใส่ใน profile; ตารางราคา 0.7 สำหรับรายการเหล่านั้นยังไม่ถูกยืนยัน/เปิดขาย.
- `productId=module-hub` และ `productCode=MODULE-HUB` เป็นชื่อ provisional จากงานนี้ ยังไม่มีหลักฐานยืนยันกับ product registry.
- Existing LR-2F-A Control projection คงเดิม เป็น read-only และ `canExecutePaymentActions:false`.

## Module Hub — Addendum A-12

ราคานี้มาจาก Owner lock ใน STATUS-HOUSE Addendum A-12; THB/USD เป็นราคาคงที่ ไม่คำนวณแลกเปลี่ยน:

| สินค้า | THB | USD |
|---|---:|---:|
| event-bus, feature-flags, rate-limit (แต่ละชิ้น) | ฿1,390 | $39 |
| http-client, enterprise-features, notification, config-runtime (แต่ละชิ้น) | ฿1,690 | $49 |
| product-catalog | ฿2,390 | $69 |
| bundle-8 | ฿8,690 | $249 |

ไม่มีการต่ออายุ; ใช้ source version ที่ซื้อได้ต่อไปโดยไม่มีกำหนด และได้รับ update ใหม่ฟรี 12 เดือนนับจากเวลาซื้อ. Profile candidate ใส่ระยะเวลา 12 เดือนและไม่มี plan ต่ออายุ. ราคานี้เป็นข้อมูลแก้ไขได้ใน product profile; runtime ไม่ฝังจำนวนเงิน.

## Phase gates

| Phase / gate | สถานะ | หลักฐาน / blocker |
|---|---|---|
| Phase 0 preflight | PASS | เลือก base `a7d65834326b22a460d0d0cb12dab2b4e657232b`; แยกจาก destructive WIP `9c5e1be`; reuse/MT01 review อยู่ใน Vault report และ Module Reuse Check. |
| Phase 1 G1 environment | PARTIAL | guards และ negative tests ผ่านใน source; ไม่มี production runtime/schema/key หรือ live verification. |
| Phase 1 G7 refund revoke | SOURCE-LEVEL PASS / DB UNVERIFIED | Provider Charge lookup, webhook durable routing, idempotent refund ledger, full/partial refund semantics และ monotonic subscription transition version มี tests. Migration ไม่ได้ apply และไม่มี real Postgres verification. |
| Phase 1 G8 PS01 | PARTIAL | Profile v2 และ A-10 pricing data มี; Stripe Price mapping, annual sales window และ production evidence ยังไม่ครบ. |
| Phase 1 G9 Control | PASS (existing contract) | Regression suite ผ่าน; projection ไม่เปลี่ยนและคง `canExecutePaymentActions:false`. |
| Phase 2 G4 USD | SOURCE-LEVEL PASS / PROVIDER UNVERIFIED | เลือก THB/USD ตาม locale และจำนวนตายตัว; negative tests ผ่าน. USD TEST Price IDs และ Stripe TEST API evidence ไม่มี. |
| Phase 3 G5 Module Hub | SOURCE-LEVEL PARTIAL | A-12 prices, no-renewal profile, perpetual source/update window, read projection และ refund revoke code อยู่ใน branch. Profile ยัง pending; Product identity/Stripe mappings/DB migration/integration evidence ยังไม่ยืนยัน. |
| Phase 4 runbook / release | BLOCKED | ยังเป็น Node `server.mjs`; locked platform host คือ Hono บน Cloudflare Worker พร้อม `scheduled()` และยังไม่มี adapter qualification. Migration provenance/application, pre-migration dump, deploy steps, rollback rehearsal และ independent review ยังไม่ครบ. |
| G6 PromptPay | OUT OF SCOPE | ไม่ทำในงานนี้; วางไว้ในแผนเฟสถัดไป. |

## Verification

- `npm run typecheck`: PASS.
- `npm test`: build ผ่าน; 80 tests PASS. 3 real-Postgres test files หยุดก่อน execution ด้วย `BLOCKED_CREDENTIAL: BILLING_DATABASE_URL` (LR-2D, LR-2E, webhook JSONB/outbox crash window). ไม่ได้ใช้ hosted/LAB DB.
- Focused run: `node --test tests/real-money-mode.test.mjs tests/real-money-refund.test.mjs tests/real-money-webhook.test.mjs tests/real-money-migration.test.mjs tests/http-checkout-slice.test.mjs tests/negative-authority-matrix.test.mjs`: 45/45 PASS.
- Build: `npm test` เรียก registry/runtime TypeScript build และ build ผ่านก่อน DB test fixtures หยุด.
- `git diff --check`: PASS.
- Fail-before evidence บน detached base `a7d6583`: refund adapter tests 2 fail เพราะยังไม่มี Charge resolver; signed webhook routing tests 2 fail เพราะ Charge/session IDs ยังไม่ถูกเลือก; migration test setup fail เพราะ migration 0003 ยังไม่มี. Pass-after tests อยู่ใน focused run.
- Stripe ใช้ mock เท่านั้น: ไม่มี SB01/stripe-billing TEST key; ไม่โหลด key ของโปรเจกต์อื่น. ไม่มี Stripe API call, DB migration, deploy หรือ production write.
- เอกสาร Stripe ระบุว่า charge amount ใช้ minor units และ THB เป็นสกุลสองตำแหน่ง; ดู [Supported currencies](https://docs.stripe.com/currencies).
- Independent review ยังไม่เกิด; ผู้ตรวจต้องเป็น session อื่น.

## Owner actions ก่อน release

1. ยืนยัน Product Registry identity สำหรับ Module Hub (`productId`/`productCode`) และจัด TEST credentials ของ SB01 ผ่านช่องทางลับที่อนุมัติ.
2. สร้าง/ยืนยัน Stripe TEST Products และ Price IDs สำหรับ PS01 ทั้ง THB/USD และ Module Hub 9 SKU; บันทึก immutable mappings ใน profile version ใหม่. ห้ามใช้ค่า USD แปลงจาก THB.
3. ระบุ annual PS01 sales window และตรวจว่า refund policy reference/profile ตรงกับ Owner lock ก่อน activate.
4. จัด local/isolated Postgres staging credential สำหรับ migration qualification; reconcile migration provenance กับ Project A schema/role และทดสอบ forward migration, replay, refund-before-purchase, refund duplicate, full/partial refund และ rollback application โดยเก็บ money tables.
5. ทำ Hono/Cloudflare Worker + `scheduled()` adapter ให้ตรง `BILLING_CORE_PLAN`, ทดสอบกับ staging binding/role โดยไม่ deploy production และรักษา Control contract.
6. ให้ independent reviewer ตรวจ branch SHA หลัง remediation; แก้ finding และให้ตรวจซ้ำ.
7. หลัง gates ข้างต้นผ่านเท่านั้น ให้ Owner จัดทำ/ดำเนิน production dump, migration, secrets, Stripe Live และ deploy จาก Cloudflare Dashboard ตาม release runbook ที่ตรวจแล้ว. Codex ไม่ทำขั้น production เหล่านี้.

## Release decision

**HOLD — ห้าม deploy หรือรับเงินจริง.** งาน source ผ่าน focused regression แต่ยังขาด integration กับ Postgres/Stripe TEST, mappings ที่เปิด checkout ได้, identity confirmation, Worker architecture, migration qualification และ independent review. A-12 ปิด blocker เรื่องราคาของ 8 โมดูลกับ bundle แล้ว; รายการนอกขอบเขตยังไม่ถูกเปิดขาย.

## Round 2 implementation delta — 2026-09-28

บรีฟ `17-SB01-ROUND-2.md` อนุมัติให้ทำ Worker adapter, local disposable PostgreSQL และ Stripe TEST catalog script โดยยังห้าม deploy/API call จริง. สถานะ implementation หลัง delta:

- เพิ่ม Hono Worker `fetch` + internal `scheduled()` (batch สูงสุด 20 jobs/รอบ, cron ทุก 15 นาที) และ runbook Dashboard/rollback; `wrangler dev --local` กับ PostgreSQL localhost ตอบ `/healthz` 200 และ `wrangler deploy --dry-run` ผ่าน.
- เพิ่ม embedded PostgreSQL runner บน localhost และ migration replay 0001–0003. `npm test` รวม unit/integration ผ่าน 110/110; real-Postgres suites 25/25.
- Worker/Node test registration ใช้ product IDs ตาม slug โฟลเดอร์ Module Hub 8 รายการ และ bundle `module-hub-bundle-8`; A-12 prices ยังคงอยู่ใน versioned editable profile data. `hub-web/client/src/productCatalog.ts` ไม่มีทั้ง 8 SKU; ใช้ slug `modules-hub/modules/` ตามคำสั่ง Owner และบันทึก gap.
- เพิ่ม `PS01_ANNUAL_LAUNCH_STARTS_AT` / `PS01_ANNUAL_LAUNCH_ENDS_AT`; ถ้าค่าไม่ครบ, format ไม่ถูก หรือ end ไม่หลัง start จะ fail closed. Stripe TEST catalog script มี prefix guard และยังไม่ถูกรัน.
- Migration 0001 คัดลอก byte-for-byte จาก SaaS Product Hub SHA `94ce432121b7bc79914fe22c976dab83745b8e50`; provenance/hashes อยู่ใน `MIGRATION-PROVENANCE-0001.md`.

สถานะยัง HOLD: ไม่มี Stripe TEST Product/Price IDs เพราะยังไม่รันสคริปต์ตามบรีฟ, ไม่มี profile activation, hosted schema/role verification หรือ independent review. Catalog SKU ที่อยู่นอก 8 โมดูลกับ bundle ยังไม่ล็อกและไม่ได้เพิ่ม.
