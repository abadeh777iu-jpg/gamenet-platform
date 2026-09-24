# GameNet Platform

سیستم مدیریت چندمستأجره (Multi-Tenant) گیم‌نت — production-ready.

## اجرا

```bash
npm install
cp .env.example .env   # سپس مقادیر امن بسازید
npm run migrate && npm run seed
npm start              # http://0.0.0.0:3000
```

## تست

```bash
npm test
```

## ساختار

- `src/routes` — HTTP layer فقط
- `src/services` — business logic (پرداخت، اشتراک، AI tools، storage…)
- `src/middleware` — auth، RBAC، tenant isolation، CSRF، rate limit
- `src/db` — schema + migration + seed
- `web/` — UI فارسی RTL dark
- `tests/` — unit + integration + tenant isolation + payment idempotency + AI permission

## اکانت پیش‌فرض seed

- `admin@gamenet.local` / `Admin@12345` — **در production حتماً عوض کنید**

## نکات امنیتی

- رمزها فقط env؛ هیچ secret در source
- scrypt password hashing
- Cookie JWT HttpOnly + CSRF double-submit
- Isolation چندمستأجره در middleware و AI tool layer
- Audit log برای عملیات حساس
