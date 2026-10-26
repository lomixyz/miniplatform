# نقل MiniPlatform إلى سيرفر Oracle Cloud المجاني الدائم

هذا دليل عملي لنقل تطبيقك من Render إلى VM مجاني دائم على Oracle Cloud "Always Free" — بدون نوم (sleep)، وبقرص دائم تحتفظ عليه بقاعدة SQLite كما هي، بدون أي تعديل على الكود.

> ملاحظة: لا أستطيع إنشاء حساب Oracle أو السيرفر نيابةً عنك — هذه خطوة تسجيل حساب سحابي يجب أن تقوم بها بنفسك. لكن جهزت لك كل ملفات الإعداد (systemd + nginx) والخطوات بالتفصيل.

## 1) إنشاء الحساب والسيرفر (Oracle Cloud)

1. افتح https://www.oracle.com/cloud/free/ وأنشئ حساب "Always Free" (يطلب بطاقة للتحقق فقط، لا يُخصم منها شيء طالما بقيت ضمن الحد المجاني).
2. من لوحة التحكم → **Compute → Instances → Create Instance**.
3. اختر الصورة (Image): **Ubuntu 22.04** أو أحدث.
4. اختر النوع (Shape): **VM.Standard.A1.Flex** (معمارية ARM — هذه هي الفئة "Always Free" الدائمة؛ اختر حسب الحد المتاح لك حالياً في حسابك، عادة 1-2 vCPU وذاكرة حتى 12 جيجا).
5. عند إنشاء المفتاح (SSH key)، احفظ الملف الخاص (private key) على جهازك — ستحتاجه للدخول.
6. بعد الإنشاء، من **Networking → Virtual Cloud Network → Security Lists**، افتح المنافذ التالية (Ingress Rules):
   - `80/tcp` (HTTP)
   - `443/tcp` (HTTPS)
   - اترك `22/tcp` (SSH) مفتوح كما هو افتراضياً.

## 2) الدخول للسيرفر وتجهيزه

```bash
ssh -i /path/to/your-key.pem ubuntu@<SERVER_PUBLIC_IP>

# تحديث النظام
sudo apt update && sudo apt upgrade -y

# تفعيل الجدار الداخلي للسيرفر نفسه (Ubuntu's own firewall, منفصل عن Oracle's Security List)
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable

# تثبيت Node.js (نسخة LTS حديثة تدعم node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx

node -v   # تأكد أنها 22.x أو أحدث (node:sqlite يحتاج Node 22+)
```

## 3) سحب المشروع وتشغيله

```bash
cd /opt
sudo git clone https://github.com/lomixyz/miniplatform.git
sudo chown -R ubuntu:ubuntu miniplatform
cd miniplatform
npm install --omit=dev

# أنشئ ملف البيئة (نفس المتغيرات التي تستخدمها على Render)
nano .env
```

ضع بداخله (عدّل القيم حسب إعدادك الحالي):
```
PORT=3000
ADMIN_PASSWORD=ضع_كلمة_مرور_قوية_هنا
SESSION_SECRET=ضع_قيمة_عشوائية_طويلة_هنا
```

جرّب التشغيل اليدوي أولاً للتأكد:
```bash
node src/server.js
# افتح في متصفحك: http://<SERVER_PUBLIC_IP>:3000
# إذا اشتغل، أوقفه بـ Ctrl+C وتابع للخطوة التالية (systemd)
```

## 4) تشغيل دائم عبر systemd (بديل "لا ينام أبداً")

انسخ ملف `miniplatform.service` المرفق إلى السيرفر في `/etc/systemd/system/miniplatform.service`، ثم:

```bash
sudo systemctl daemon-reload
sudo systemctl enable miniplatform
sudo systemctl start miniplatform
sudo systemctl status miniplatform   # تأكد أنه Active (running)
```

من الآن، التطبيق يعمل دائماً، ويعيد التشغيل تلقائياً عند أي تعطل أو عند إعادة تشغيل السيرفر نفسه.

## 5) Nginx كبوابة أمامية + دومين (اختياري لكن يُنصح به)

انسخ ملف `nginx-miniplatform.conf` المرفق إلى `/etc/nginx/sites-available/miniplatform`، ثم:

```bash
sudo ln -s /etc/nginx/sites-available/miniplatform /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx
```

إذا عندك دومين (مثلاً miniplatform.com)، وجّه DNS A record إلى IP السيرفر، ثم فعّل HTTPS مجاناً عبر Let's Encrypt:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

هذا يعطيك شهادة SSL مجانية ويجدّدها تلقائياً.

## 6) تحديث الكود لاحقاً

في كل مرة أعطيك ملفات محدّثة:
```bash
cd /opt/miniplatform
git pull            # أو استبدل الملفات يدوياً ثم git add/commit/push من جهازك
npm install --omit=dev   # فقط إذا تغيّرت package.json
sudo systemctl restart miniplatform
```

## 7) قاعدة البيانات (SQLite) — تبقى كما هي

بما أن القرص على هذا السيرفر **دائم** (وليس مؤقتاً مثل Render الاقتصادي)، ملف `data/app.db` يبقى محفوظاً بين كل إعادة تشغيل — لا حاجة لأي تعديل على كود قاعدة البيانات. يبقى Litestream (إن أردت الاستمرار باستخدامه) مفيداً فقط كنسخة احتياطية إضافية احترازية، وليس كحل لمشكلة فقدان البيانات — لأن القرص هنا لا يُمسح تلقائياً.

## الخلاصة

| | Render (الحالي) | Oracle Cloud Always Free |
|---|---|---|
| ينام بعد عدم نشاط | نعم (دقيقة تقريباً لإعادة التشغيل) | لا — يعمل 24/7 |
| القرص دائم لـ SQLite | لا (في الخطة المجانية) | نعم |
| التكلفة | مجاني | مجاني دائم |
| يحتاج صيانة سيرفر يدوية | لا | نعم (تحديثات أمنية دورية بسيطة) |
