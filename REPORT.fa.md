# گزارش پروژه — پلتفرم GameNet

## خلاصه
از صفر، یک محصول واقعی چندمستأجره برای مدیریت گیم‌نت ساخته شد: ثبت‌نام/ورود، خرید اشتراک، پنل هر گیم‌نت، پنل مدیر اصلی، پرداخت و فاکتور، تیکت با هوش مصنوعی، فایل و فضای ذخیره‌سازی، اعلان‌ها، Audit و بکاپ — با جداسازی کامل داده‌ها بین مستأجرها.

## معماری (تصمیم من)
- **Backend:** Node.js 20 + Express (modular monolith — جداکردن DB/Queue/Storage در آینده ممکن است)
- **DB:** SQLite (WAL) با FK، ایندکس، migration و تراکنش — قابل جابه‌جایی به Postgres
- **Auth:** JWT در Cookie HttpOnly + Refresh چرخشی + CSRF double-submit + Rate limit
- **RBAC:** Super Admin / Admin / Support / Owner / Staff + گارد عضویت مستأجر (requireTenant)
- **AI:** فقط Tool allowlist با بررسی tenant — هرگز SQL خام یا دسترسی بی‌حد ندارد
- **پرداخت:** Idempotency در ۳ لایه (کلید سفارش، provider_ref، webhook event_id)
- **ذخیره‌سازی:** سهمیه per-tenant، هشدار ۸۰٪/۹۵٪، جلوگیری از پرشدن (413)
- **بکاپ:** VACUUM INTO + نگه‌داشتن ۱۴ نسخه
- **UI:** فارسی RTL، تم تاریک، حالت loading/empty/error/success

## بخش‌های تحویلی
1. Landing 2. ثبت‌نام/ورود (ایمیل+فراموشی+تأیید+Google hook) 3. صفحه پلن‌ها و خرید 4. پنل گیم‌نت (داشبورد، فایل، تیکت، AI، اعلان) 5. پنل Super Admin (آمار، کاربران، گیم‌نت، اشتراک، License، پرداخت، تیکت، فضا، Audit، بکاپ، تنظیمات) 6. چرخه اشتراک 7. پرداخت/فاکتور 8. AI داخل پنل 9. تیکت + تحویل به انسان 10. فایل/فضا 11. اعلان 12. Audit 13. بکاپ

## تست‌ها (۱۰/۱۰ پاس)
- unit (رمز، JWT)
- auth (ثبت‌نام/ورود/خروج، رمز ضعیف)
- **ایزولیشن مستأجر** (کاربر B نمی‌خواند/نمی‌نویسد/نمی‌بیند داده A؛ AI هم ۴۰۳)
- پرداخت idempotent (سفارش تکراری + webhook تکراری = یک فعال‌سازی)
- مجوزهای AI (فقط ابزارهای allowlist)

## اجرا
```bash
cd gamenet-platform
npm install
npm run migrate && npm run seed
npm start   # http://localhost:3000
```
- پنل مدیر: `/admin/` — کاربر seed: `admin@gamenet.local` / `Admin@12345` (حتماً در production عوض شود)
- پنل گیم‌نت: `/app/`
- Health: `/api/health`

## امنیت
- بدون secret در سورсе (فقط `.env`)
- رمز plaintext هرگز ذخیره نمی‌شود (scrypt)
- Headers امن (helmet/CSP)، CORS محدود، بدون stack trace به کاربر
- لاگ/commit بدون توکن

## وضعیت
- سرور روی پورت ۳۰۰۰ در حال اجرا
- تست‌ها سبز
- کد در git commit شده (پوش به GitHub با توکن انجام شد)
