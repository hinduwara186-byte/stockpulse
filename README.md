# StockPulse — Real-Time Inventory & Sales Management (100% Free)

A progressive web application (PWA) designed for real-time inventory synchronization between your **Computer** and **Android Phone** at **$0 cost** using **Supabase PostgreSQL Realtime** and **Camera Barcode Scanning**.

---

## 🌟 Key Features

1. **Shipment Arrival (+Stock)**:
   - Add received items with quantity, unit cost, and supplier batch notes.
   - Database trigger automatically increments the available quantity.
2. **Sales / POS Checkout (-Stock)**:
   - Search by name or scan barcode using your phone camera.
   - Instantly calculates remaining stock and validates against overselling.
   - Completes the sale and deducts stock in real time.
3. **Multi-Device Instant Sync**:
   - Updates made on your computer reflect on your phone in under a second without page refresh.
4. **Permanent Audit Ledger**:
   - Every shipment and sale is permanently logged with timestamps and amounts.
5. **Mobile & Desktop Installation (PWA)**:
   - On Android: Tap "Add to Home Screen" or "Install App".
   - On PC: Click "Install" in Chrome/Edge for a standalone desktop window.

---

## 🚀 Step 1: Free Supabase Cloud Database Setup (3 Minutes)

1. Create a free account at [supabase.com](https://supabase.com).
2. Create a new project (e.g., `stockpulse`).
3. In the left navigation, click on the **SQL Editor**.
4. Open the [supabase_schema.sql](./supabase_schema.sql) file included in this project, copy all its contents, paste them into the SQL editor, and click **Run**.
   - This creates the `products` and `transactions` tables.
   - This sets up the automatic trigger that recalculates stock on every sale or shipment.
   - This enables real-time WebSocket publications.
5. Go to **Project Settings &rarr; API** in Supabase and copy:
   - **Project URL**
   - **anon / public key**
6. Open StockPulse in your browser, switch to the **Database / Cloud** tab, paste the URL & Key, and click **Save & Connect Live**.

---

## 💻 Step 2: Running Locally

The local server is currently running at:
```
http://localhost:4173
```

To run it at any time in the terminal:
```powershell
python -m http.server 4173
```

---

## 📱 Step 3: Accessing from Your Android Phone

### Option A: Over Your Local Wi-Fi (Instant)
1. Find your computer's local IP address (run `ipconfig` in terminal, e.g. `192.168.1.15`).
2. On your Android phone (connected to the same Wi-Fi), open Chrome and go to:
   ```
   http://YOUR_COMPUTER_IP:4173
   ```
3. Tap the three dots menu in Chrome &rarr; **Add to Home screen** / **Install app**.

### Option B: Deploy Free Online (Accessible Anywhere in the World)
You can deploy this static PWA to **Cloudflare Pages**, **Vercel**, or **GitHub Pages** for free in under 60 seconds:
- Drag-and-drop the `stockpulse` directory into [Cloudflare Pages](https://pages.cloudflare.com) or [Vercel](https://vercel.com).
- You get a free HTTPS URL (e.g. `https://stockpulse.pages.dev`).
- Now both your PC and Android phone can connect from any network with full camera barcode scanning permissions!
