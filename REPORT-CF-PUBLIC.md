# گزارش نسخه آنلاین GameNet Platform

## لینک‌های عمومی

| مورد | لینک |
|------|------|
| سایت اصلی | https://gamenet-platform.pages.dev |
| آخرین نسخه (نسخه‌نگاری) | https://6957b3d4.gamenet-platform.pages.dev |
| سلامت سرویس | https://gamenet-platform.pages.dev/api/health |
| پلن‌ها | https://gamenet-platform.pages.dev/api/plans |

## نتیجه تست زنده (ساخت ۲۰۲۶-۰۹-۲۴)

| مورد | نتیجه |
|------|-------|
| health | ✅ `{"ok":true}` |
| plans (۴ پلن) | ✅ basic / pro / business / pro_year |
| register | ✅ ایجاد کاربر + کوکی‌های auth |
| login | ✅ ورود موفق |
| me | ✅ نمایه کاربر |
| ایجاد GameNet | ✅ ساخت و لیست |
| تیکت | ✅ ایجاد و لیست |
| اعلان‌ها | ✅ |
| مسیر ناشناخته API | ✅ 404 مرتب |
| صفحه اصلی | ✅ 200 |
| تست‌های محلی | ✅ 10/10 |

## ریشه مشکل‌های این مرحله و راه‌حل

### ۱. خطای `Unknown response type…` روی همه `/api/*`
**ریشه:** `env.DB.get(k, 'base64')` — Cloudflare KV فقط نوع `text|json|arrayBuffer|stream` می‌پذیرد؛ `base64` نامعتبر بود و کل bootstrap با خطا می‌شکست.

**راه‌حل:** خواندن با `type: 'text'` (مقدار خودِ base64 رشته است) در `worker/bootstrap.js`.

### ۲. لاگین `csrf_failed`
**ریشه:** تست بدون دریافت اولیه کوکی `gn_csrf` و ارسال هدر `x-csrf-token`.

**راه‌حل:** الگوی double-submit درست است (مثل `core.js` فرانت): اول GET، بعد mutation با هدر. خود سرویس نیاز به تغییر نداشت.

### ۳. `invalid_credentials` بلافاصله بعد از register موفق
**ریشه:** چند isolate در Cloudflare؛ isolate پس از flush هنوز snapshot قدیمی KV را در حافظه داشت (`ready` برای همیشه کش می‌شد).

**راه‌حل:** کلید `db:version` در KV؛ با هر flush به‌روز می‌شود؛ در `init` اگر نسخه فرق کرد، snapshot دوباره بارگذاری می‌شود (`force` در `__initSqlJs`).

### ۴. `normalize is not a function` / `fs.stat is not a function`
**ریشه:** مسیر ناشناخته‌ی `/api/*` به `express.static` می‌خورد؛ shim پathom `normalize` نداشت و fs stub هم `stat` ندارد.

**راه‌حل:**  
- `path.normalize` و بقیه API استاندارد path به `worker/shims/path.js` اضافه شد.  
- `app.use('/api', notFound)` **قبل از** static قرار گرفت تا unmatched APIها 404 شوند.

### ۵. ایمیل بزرگ/کوچک
register حالا ایمیل را `toLowerCase()` می‌کند تا با login یکی باشد.

## پوشش امنیتی (حفظ‌شده)
- لاگینا `errorHandler` در production پیام داخلی ماسک می‌کند؛ `pages-entry` فقط `internal error` برمی‌گرداند و stack فقط در `console.error`.
- بدون هیچ secret در سورس؛ همه کلیدها env/secret.
- CSRF double-submit، Cookie HttpOnly، RBAC، isolation مستأجرها.

## استقرار
- Build: `bash worker/build.sh` → `BUILD_OK`
- Deploy: `wrangler pages deploy web --project-name=gamenet-platform`
- Binding: KV `DB` + env سری‌ها در Pages

## مسیرهای مهم API
- `GET /api/health` — سلامت
- `GET /api/plans` — پلن‌ها
- `POST /api/auth/register` — ثبت‌نام (با CSRF)
- `POST /api/auth/login` — ورود (با CSRF)
- `GET /api/auth/me` — نمایه
- `GET|POST /api/gamenets` — فهرست/ایجاد گیم‌نت
- `GET|POST /api/tickets` — تیکت
- `GET /api/notifications` — اعلان‌ها

## ادمین seed
- ایمیل: `admin@gamenet.local`
- رمز: `Admin@12345`  
(در محصول واقعی حتماً عوض شود)

## GitHub
- مخزن: https://github.com/abadeh777iu-jpg/gamenet-platform  
- فایل‌های CF-Port (`worker/`, `wrangler.toml`, `web/_worker.js`) در همین commit.
