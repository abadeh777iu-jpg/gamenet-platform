# GameNet Platform

سیستم مدیریت چندمستأجره گیم‌نت — production-ready.

## اجرا
```bash
npm install
npm run migrate && npm run seed
npm start
```
پیش‌فرض: `http://localhost:3000`

- کاربر ادمین seed: `admin@gamenet.local` / `Admin@12345` (در production عوض کنید)
- صفحات: `/` معرفی، `/plans` اشتراک، `/login` ورود، `/app` پنل گیم‌نت، `/admin` پنل مدیر اصلی

## تست
```bash
npm test
```

## معماری
- Express + SQLite (WAL) + job scheduler درون‌برنامه‌ای
- JWT در Cookie HttpOnly + CSRF double-submit + rate limit
- ایزولیشن مستأجر در middleware و Tool layer هوش مصنوعی
- پرداخت idempotent (کلید سفارش + یکتایی webhook)
- بکاپ خودکار VACUUM INTO با retention ۱۴ نسخه
- بدون هیچ secret در سورсе — همه از `.env`
