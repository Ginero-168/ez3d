# EventSpace 3D | Mockup Studio 🎨✨

แอปพลิเคชันเว็บสามมิติสำหรับการออกแบบ จัดเตรียมบูธนิทรรศการ และระบายสีพรมแบ่งโซนรายช่อง (1m x 1m) บนเว็บเบราว์เซอร์อย่างง่ายดายโดยไม่ต้องผ่านโปรแกรมดีไซน์ที่ซับซ้อน

---

## 📦 ไฟล์ 3D ที่รองรับ

ระบบอัปโหลดโมเดล 3D รองรับไฟล์ `.glb`, `.gltf`, `.fbx`, `.obj`, `.stl`, `.ply`, และ `.dae` โดยไฟล์จะถูกจัดกึ่งกลางและวางฐานไว้บนพื้นอัตโนมัติหลังโหลดเข้า scene

โมเดลที่อัปโหลดจะถูกเก็บอ้างอิงไว้ใน IndexedDB ของเบราว์เซอร์ เพื่อให้ autosave และการ save/load project ในเครื่องเดิมสามารถกู้คืนโมเดลกลับมาได้โดยไม่ฝังไฟล์ binary ขนาดใหญ่ลงใน JSON

---

## 🛠️ การพัฒนาบนเครื่อง Local (Local Development)

โปรเจกต์นี้ได้รับการติดตั้งเครื่องมือ **Vite** สำหรับรันเซิร์ฟเวอร์จำลองและรวมไฟล์ส่งพิมพ์/ขึ้นเซิร์ฟเวอร์อย่างรวดเร็ว

1. **ติดตั้ง Dependencies:**
   ```bash
   npm install
   ```

2. **เปิดระบบจำลองเครื่อง (Local Server Dev):**
   ```bash
   npm run dev
   ```
   *เปิดเบราว์เซอร์ไปที่ลิงก์ที่แสดงบนหน้าจอ (ปกติคือ `http://localhost:5173`)*

3. **บิลด์ไฟล์เพื่อพร้อมนำไป Deploy (Build Production):**
   ```bash
   npm run build
   ```
   *โค้ดจะถูกรวมและสร้างขึ้นใหม่ในโฟลเดอร์ `dist/` ซึ่งเบาและพร้อมรันบนอินเทอร์เน็ตทันที*

---

## 🚀 วิธีการนำขึ้นเซิร์ฟเวอร์ Hostinger (Hostinger Deployment Guide)

สำหรับการรันบน **Hostinger Shared Hosting** (ผ่านระบบ hPanel File Manager) ให้ปฏิบัติตามขั้นตอนดังนี้ครับ:

### ขั้นตอนที่ 1: บิลด์ไฟล์ในเครื่องคอมพิวเตอร์ของคุณ
เปิด Terminal ในเครื่อง Mac แล้วรันคำสั่ง:
```bash
cd "/Users/peerawatrodkaew/Desktop/Same energy"
npm install
npm run build
```
เมื่อรันเสร็จสิ้น คุณจะได้โฟลเดอร์ใหม่ชื่อ **`dist`** ปรากฏขึ้นในโปรเจกต์ของคุณ ซึ่งโฟลเดอร์นี้ประกอบด้วย:
* `index.html`
* โฟลเดอร์ `assets/` (บรรจุไฟล์ CSS และ JS ที่คอมไพล์แล้วแบบย่อขนาด)

### ขั้นตอนที่ 2: บีบอัดไฟล์สำหรับอัปโหลด (แนะนำ)
1. เข้าไปในโฟลเดอร์ **`dist`** (ไม่ใช่โฟลเดอร์โปรเจกต์หลัก)
2. เลือกไฟล์ `index.html` และโฟลเดอร์ `assets` ทั้งหมด
3. คลิกขวาแล้วเลือก **Compress (บีบอัด)** เพื่อให้ได้ไฟล์ชื่อ `archive.zip` (หรือ `dist.zip`)

### ขั้นตอนที่ 3: อัปโหลดเข้าสู่ Hostinger hPanel
1. เข้าสู่ระบบ [Hostinger hPanel](https://hpanel.hostinger.com/)
2. ไปที่เมนู **File Manager** ของโดเมนที่คุณต้องการใช้งาน
3. ดับเบิ้ลคลิกเข้าโฟลเดอร์ **`public_html`** (ซึ่งเป็นไดเรกทอรีหลักสำหรับแสดงผลหน้าเว็บ)
4. กดปุ่ม **Upload** ที่มุมขวาบน แล้วอัปโหลดไฟล์ `archive.zip` ที่คุณบีบอัดไว้ขึ้นมา
5. คลิกขวาที่ไฟล์ `archive.zip` บน Hostinger แล้วเลือก **Extract (แตกไฟล์)** ลงในโฟลเดอร์ `public_html` โดยตรง
6. ลบไฟล์ `archive.zip` ที่ไม่จำเป็นออก

*หน้าเว็บของคุณพร้อมออนไลน์เข้าชมผ่านโดเมนของคุณบน Hostinger ทันที!*

### ทางเลือก: Deploy Hostinger อัตโนมัติผ่าน GitHub Actions
Workflow ใน `.github/workflows/deploy.yml` จะ deploy ไป `gh-pages` ทุกครั้งที่ push เข้า `main` และสามารถอัปโหลดขึ้น Hostinger ผ่าน FTP ได้ด้วยถ้าตั้งค่า repository secrets ต่อไปนี้:

* `HOSTINGER_FTP_SERVER` เช่น `ftp.your-domain.com`
* `HOSTINGER_FTP_USERNAME`
* `HOSTINGER_FTP_PASSWORD`
* `HOSTINGER_FTP_SERVER_DIR` เช่น `/public_html/` (ไม่ใส่ก็ใช้ `/public_html/`)

ถ้ายังไม่ได้ตั้ง secrets เหล่านี้ workflow จะข้ามขั้นตอน Hostinger deploy และยัง deploy ไป `gh-pages` ตามปกติ

---

## 🌐 ทางเลือกอื่นๆ สำหรับการ Deploy ฟรี
สามารถดูคู่มือการตั้งค่า Vercel, Netlify และ GitHub Pages อัตโนมัติ ได้ในประวัติของสคริปต์ [deploy.yml](.github/workflows/deploy.yml) และ [vercel.json](vercel.json)
