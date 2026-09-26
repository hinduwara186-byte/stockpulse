-- ==============================================================================
-- STOCKPULSE - REALTIME INVENTORY & SALES TRACKING (SUPABASE SCHEMA)
-- Run this in your Supabase SQL Editor (100% Free Forever)
-- ==============================================================================

-- 1. Create Products Table
CREATE TABLE IF NOT EXISTS public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    barcode TEXT UNIQUE,
    sku TEXT,
    category TEXT DEFAULT 'General',
    stock_quantity INTEGER NOT NULL DEFAULT 0,
    min_alert_qty INTEGER DEFAULT 5,
    cost_price NUMERIC(10, 2) DEFAULT 0.00,
    selling_price NUMERIC(10, 2) DEFAULT 0.00,
    image_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Create Stock Transactions (Audit Log for Shipments & Sales)
CREATE TABLE IF NOT EXISTS public.transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES public.products(id) ON DELETE CASCADE NOT NULL,
    product_name TEXT,
    type TEXT NOT NULL CHECK (type IN ('SHIPMENT_IN', 'SALE_OUT', 'ADJUSTMENT')),
    quantity INTEGER NOT NULL,
    unit_price NUMERIC(10, 2) DEFAULT 0.00,
    total_amount NUMERIC(10, 2) DEFAULT 0.00,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Audit Ledger & Transaction Management
-- Drop any existing automatic triggers to prevent double-counting of quantities
DROP TRIGGER IF EXISTS trg_stock_transaction ON public.transactions;
DROP FUNCTION IF EXISTS public.handle_stock_transaction();

-- 4. Enable Row Level Security (RLS)
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- Allow public read & write via Anon Key for quick setup
CREATE POLICY "Public Read/Write Products" 
ON public.products 
FOR ALL 
TO anon, authenticated 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Public Read/Write Transactions" 
ON public.transactions 
FOR ALL 
TO anon, authenticated 
USING (true) 
WITH CHECK (true);

-- 5. Enable Real-Time Listeners on both tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.products;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;

-- 6. Insert Starter Demo Products
INSERT INTO public.products (name, barcode, sku, category, stock_quantity, min_alert_qty, cost_price, selling_price)
VALUES
('Arabica Coffee Beans 1kg', '8901234567890', 'COF-ARA-01', 'Beverages', 45, 10, 14.50, 24.00),
('Organic Green Tea (50 bags)', '8901234567891', 'TEA-GRN-02', 'Beverages', 18, 15, 4.20, 8.50),
('USB-C Fast Charging Cable 2m', '8901234567892', 'CAB-USBC-01', 'Electronics', 60, 10, 2.50, 9.99),
('Wireless Bluetooth Earbuds', '8901234567893', 'EAR-BT-05', 'Electronics', 8, 10, 12.00, 29.99),
('Stainless Steel Water Bottle 750ml', '8901234567894', 'BOT-SS-03', 'Accessories', 3, 8, 5.50, 16.00)
ON CONFLICT (barcode) DO NOTHING;
