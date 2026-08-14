# 02 — Stripe Subscription Backend-as-a-Service

**สถานะ:** ✅ พร้อมเริ่มเขียนบรีฟเต็ม — module ที่ใช้ทั้งหมดมีโค้ดจริง หนาแน่น (968+863+485+974 บรรทัด)

## Modules ที่ก็อปมา
- `webhook-receiver` — มี provider สำเร็จรูปสำหรับ stripe/github/line/generic-hmac (863 บรรทัด)
- `payment` — payment core + stripe adapter (968 บรรทัด, test 6 ไฟล์)
- `subscription` — subscription + entitlement engine (485 บรรทัด)
- `audit-log` — audit trail (974 บรรทัด)

## รู้ไว้ก่อนเขียนบรีฟ
- นี่คือกลุ่มที่แน่นที่สุดใน 10 ไอเดีย — ทุก module มี test และ MODULE.md ครบ
- ต้องเช็คว่า `payment`/`subscription` core อ่าน Stripe API version ปัจจุบันไหม (Stripe เปลี่ยน API บ่อย) ก่อนโปรโมทว่า production-ready

## TODO — ไล่เขียนด้วยกัน
- [ ] ลูกค้าเป้าหมาย (indie SaaS / agency ที่ไม่อยากเขียน billing เอง)
- [ ] MVP scope (self-serve checkout, webhook sync, dunning?)
- [ ] โมเดลราคา
- [ ] Timeline
- [ ] ความเสี่ยง
