// ==============================================================================
// STOCKPULSE - REALTIME STOCK & IN/OUT MANAGEMENT
// Real-time synchronization between PC and Android phone with Free Supabase
// ==============================================================================

// ESC key closes any open modal
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ['adjustStockModal', 'batchInOutModal', 'invoiceDetailsModal', 'itemHistoryModal'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
});

import { createClient } from '@supabase/supabase-js';

// Default starter products
const DEFAULT_PRODUCTS = [
  { id: '1', name: 'Broiler Starter Feed 50kg',     category: 'Poultry',  stock_quantity: 45, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: '2', name: 'Layer Mash High Protein 50kg',  category: 'Poultry',  stock_quantity: 28, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: '3', name: 'Broiler Finisher Pellets 50kg', category: 'Poultry',  stock_quantity: 60, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: '4', name: 'Chick Booster Vitamins 1L',     category: 'Poultry',  stock_quantity:  8, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: 'pf-1', name: 'Pedigree Adult Dog Food 10kg', category: 'Pet Food', stock_quantity: 25, min_alert_qty: 4, updated_at: new Date().toISOString() },
  { id: 'pf-2', name: 'Whiskas Ocean Fish Cat 3kg',   category: 'Pet Food', stock_quantity: 16, min_alert_qty: 4, updated_at: new Date().toISOString() },
];

const DEFAULT_MOVEMENTS = [
  { id: 'm-1', product_id: '1', product_name: 'Broiler Starter Feed 50kg',      type: 'IN',  quantity: 20, note: 'Supplier Shipment Arrival',         created_at: new Date(Date.now() - 3600000 * 5).toISOString() },
  { id: 'm-2', product_id: 'pf-1', product_name: 'Pedigree Adult Dog Food 10kg', type: 'OUT', quantity:  4, note: 'Invoice #INV-PF-101 • Pet Store Dispatch', invoice_number: 'INV-PF-101', created_at: new Date(Date.now() - 3600000 * 2).toISOString() },
];

// ── App State ──────────────────────────────────────────────────────────────────
let supabase             = null;
let isLiveSupabase       = false;
let products             = [];
let movements            = [];
let broadcastChannel     = null;
let currentActiveTab     = 'poultry'; // 'poultry' | 'petfood' | 'inout' | 'records'
let currentInvoiceFilter = 'ALL';     // 'ALL' | 'POULTRY' | 'PET_FOOD'

// ── Category Classification Helpers ────────────────────────────────────────────
function isPetFood(category) {
  if (!category) return false;
  return String(category).trim().toLowerCase() === 'pet food';
}

function isPetFoodProduct(productOrId, productName) {
  if (productOrId && typeof productOrId === 'object') {
    return isPetFood(productOrId.category);
  }
  const prod = products.find(p => String(p.id) === String(productOrId) || p.name === productName);
  return prod ? isPetFood(prod.category) : false;
}

function getPoultryProducts() {
  return products.filter(p => !isPetFood(p.category));
}

function getPetFoodProducts() {
  return products.filter(p => isPetFood(p.category));
}

// Memoized invoice records cache
let cachedInvoiceRecords = null;
function invalidateRecordsCache() {
  cachedInvoiceRecords = null;
}

// Current batch modal mode: 'IN' | 'OUT'
let batchMode = 'IN';

// ── Debounce Utility for fast responsive typing ───────────────────────────────
function debounce(fn, delay = 100) {
  let timer = null;
  return function(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ── Audio & Haptic (Lazy initialized on first user interaction) ────────────────
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) audioCtx = new AudioCtx();
  }
  return audioCtx;
}

function playBeep(freq = 880, duration = 0.08, type = 'sine') {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}

function playSuccessChime() {
  playBeep(659.25, 0.08);
  setTimeout(() => playBeep(880, 0.12), 90);
}

function triggerHaptic() {
  if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
}

// ── Toast Notifications ────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : type === 'danger' ? '⚠️' : 'ℹ️'}</span>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

// ── Multi-Tab Broadcast (Demo Mode) ───────────────────────────────────────────
function setupBroadcastChannel() {
  if ('BroadcastChannel' in window) {
    broadcastChannel = new BroadcastChannel('stockpulse_simple_sync');
    broadcastChannel.onmessage = (event) => {
      if (event.data?.type === 'PRODUCT_UPDATE' && !isLiveSupabase) {
        loadDataFromStorage();
        renderAll();
        showToast('Realtime update received from another window!', 'info');
        playBeep(523.25, 0.1);
      }
    };
  }
}

// ── Supabase Permanent Configuration ───────────────────────────────────────────
const SUPABASE_URL = 'https://euxupebzsfiqnlmbpxri.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1eHVwZWJ6c2ZpcW5sbWJweHJpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzODc3NzQsImV4cCI6MjEwNTk2Mzc3NH0.XFBLXMfo748oKIBd6F2KJ1FlRtrMXByrowaC4likncY';

async function initSupabaseClient() {
  const statusDot  = document.getElementById('statusDot');
  const statusText = document.getElementById('syncStatusText');

  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await supabase.from('products').select('*').limit(1);
    if (error) throw error;

    isLiveSupabase = true;
    if (statusDot) statusDot.className  = 'status-dot pulse';
    if (statusText) statusText.textContent = 'Supabase Cloud Live 🟢';

    await fetchRemoteProducts();
    await fetchRemoteMovements();

    supabase
      .channel('public:realtime-products-and-tx')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' },     handleRemoteProductChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, handleRemoteTransactionChange)
      .subscribe((status) => console.log('[Supabase Realtime]:', status));

    return;
  } catch (err) {
    console.warn('Supabase connection fallback to local storage:', err);
    isLiveSupabase = false;
    if (statusDot) statusDot.className  = 'status-dot demo';
    if (statusText) statusText.textContent = 'Demo Mode 🟡';
    loadDataFromStorage();
    renderAll();
  }
}

const INVOICE_REGEX = /Invoice\s*#?([A-Za-z0-9\-_/]+)/i;
const INVOICE_PREFIX_REGEX = /^Invoice\s*#?[^\s•]+(\s*•\s*)?/i;

function parseInvoiceNumber(notes) {
  if (!notes) return null;
  const match = notes.match(INVOICE_REGEX);
  return match ? match[1].trim() : null;
}

function cleanInvoiceNote(note, inv) {
  if (!note) return '-';
  if (!inv) return note;
  return note.replace(INVOICE_PREFIX_REGEX, '').trim() || '-';
}

async function fetchRemoteProducts() {
  if (!supabase) return;
  const { data, error } = await supabase.from('products').select('*').order('name');
  if (!error && data) {
    const seen = new Set();
    products = data.filter(p => {
      if (seen.has(String(p.id))) return false;
      seen.add(String(p.id));
      return true;
    });
    saveDataToStorage();
    renderAll();
  }
}

async function fetchRemoteMovements() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from('transactions').select('*')
    .order('created_at', { ascending: false }).limit(1000);
  if (!error && data) {
    invalidateRecordsCache();
    const seen = new Set();
    const cleanMovements = [];
    for (const tx of data) {
      if (!seen.has(String(tx.id))) {
        seen.add(String(tx.id));
        cleanMovements.push({
          id:           tx.id,
          product_id:   tx.product_id,
          product_name: tx.product_name,
          type:         tx.type === 'SHIPMENT_IN' ? 'IN' : 'OUT',
          quantity:     tx.quantity,
          invoice_number: parseInvoiceNumber(tx.notes),
          note:         tx.notes || (tx.type === 'SHIPMENT_IN' ? 'Shipment Received' : 'Dispatched for Distribution'),
          created_at:   tx.created_at,
        });
      }
    }
    movements = cleanMovements;
    saveDataToStorage();
    if (currentActiveTab === 'inout') renderInOutActivity();
    if (currentActiveTab === 'records') renderRecordsPage();
  }
}

function handleRemoteProductChange(payload) {
  const { eventType, new: newRec, old: oldRec } = payload;
  if (eventType === 'INSERT') {
    const existingIdx = products.findIndex(p => 
      String(p.id) === String(newRec.id) ||
      (String(p.id).startsWith('prod-') && p.name.trim().toLowerCase() === newRec.name.trim().toLowerCase())
    );

    if (existingIdx !== -1) {
      // Reconcile optimistic/existing entry with remote data
      products[existingIdx] = newRec;
      saveDataToStorage();
      renderAll();
      return;
    }

    products.unshift(newRec);
    saveDataToStorage();
    playSuccessChime();
    showToast(`New item added: ${newRec.name}`, 'info');
    renderAll();
  } else if (eventType === 'UPDATE') {
    const idx = products.findIndex(p => String(p.id) === String(newRec.id));
    if (idx !== -1) {
      const wasSameStock = Number(products[idx].stock_quantity) === Number(newRec.stock_quantity);
      products[idx] = newRec;
      highlightUpdatedRow(newRec.id);
      saveDataToStorage();
      renderAll();
      if (!wasSameStock) {
        playSuccessChime();
        showToast(`Stock updated for ${newRec.name}: now ${newRec.stock_quantity}`, 'success');
      }
    }
  } else if (eventType === 'DELETE') {
    products = products.filter(p => String(p.id) !== String(oldRec.id));
    saveDataToStorage();
    renderAll();
  }
}

function handleRemoteTransactionChange(payload) {
  if (payload.eventType === 'INSERT') {
    const tx = payload.new;
    // 1. Skip if transaction already exists by ID
    if (movements.some(m => String(m.id) === String(tx.id))) {
      return;
    }

    const txType = tx.type === 'SHIPMENT_IN' ? 'IN' : 'OUT';
    const txInv  = parseInvoiceNumber(tx.notes);

    // 2. Reconcile if matching a local optimistic placeholder
    const optIdx = movements.findIndex(m => {
      if (!m.id || !String(m.id).startsWith('m-')) return false;
      if (String(m.product_id) !== String(tx.product_id)) return false;
      if (m.type !== txType) return false;
      if (Number(m.quantity) !== Number(tx.quantity)) return false;
      if (txInv && m.invoice_number && m.invoice_number.toLowerCase() !== txInv.toLowerCase()) return false;
      return true;
    });

    invalidateRecordsCache();

    if (optIdx !== -1) {
      movements[optIdx].id = tx.id;
      movements[optIdx].created_at = tx.created_at;
      movements[optIdx].note = tx.notes || movements[optIdx].note;
      movements[optIdx].invoice_number = txInv || movements[optIdx].invoice_number;
    } else {
      // Remote transaction arrived from another device
      movements.unshift({
        id:           tx.id,
        product_id:   tx.product_id,
        product_name: tx.product_name,
        type:         txType,
        quantity:     tx.quantity,
        invoice_number: txInv,
        note:         tx.notes || '',
        created_at:   tx.created_at,
      });
      playSuccessChime();
    }

    saveDataToStorage();
    if (currentActiveTab === 'inout') {
      renderInOutActivity();
      renderInOutList();
    }
    if (currentActiveTab === 'records') {
      renderRecordsPage();
    }
  }
}

function highlightUpdatedRow(productId) {
  [`prod-row-${productId}`, `inout-row-${productId}`].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.classList.add('flash-update');
      setTimeout(() => el.classList.remove('flash-update'), 1500);
    }
  });
}

// ── Storage Helpers ────────────────────────────────────────────────────────────
function loadDataFromStorage() {
  invalidateRecordsCache();
  const storedProd = localStorage.getItem('stockpulse_simple_products');
  const storedMov  = localStorage.getItem('stockpulse_simple_movements');
  products  = storedProd ? JSON.parse(storedProd) : [...DEFAULT_PRODUCTS];
  movements = storedMov  ? JSON.parse(storedMov)  : [...DEFAULT_MOVEMENTS];
  if (!storedProd || !storedMov) saveDataToStorage();
}

function saveDataToStorage() {
  invalidateRecordsCache();
  localStorage.setItem('stockpulse_simple_products', JSON.stringify(products));
  localStorage.setItem('stockpulse_simple_movements', JSON.stringify(movements));
  broadcastChannel?.postMessage({ type: 'PRODUCT_UPDATE' });
}

// ── Render Functions ───────────────────────────────────────────────────────────
function renderAll(forceAll = false) {
  renderMetrics();
  if (forceAll) {
    renderPoultryProducts();
    renderPetFoodProducts();
    renderInOutList();
    renderInOutActivity();
    renderRecordsPage();
    return;
  }
  if (currentActiveTab === 'poultry' || currentActiveTab === 'inventory') {
    renderPoultryProducts();
  } else if (currentActiveTab === 'petfood') {
    renderPetFoodProducts();
  } else if (currentActiveTab === 'inout') {
    renderInOutList();
    renderInOutActivity();
  } else if (currentActiveTab === 'records') {
    renderRecordsPage();
  }
}

function renderMetrics() {
  let currentItems = products;
  let labelText = 'Total Items';

  if (currentActiveTab === 'petfood') {
    currentItems = getPetFoodProducts();
    labelText = 'Pet Food Items';
  } else if (currentActiveTab === 'poultry' || currentActiveTab === 'inventory') {
    currentItems = getPoultryProducts();
    labelText = 'Poultry Items';
  }

  const totalItems = currentItems.length;
  const totalUnits = currentItems.reduce((acc, p) => acc + (Number(p.stock_quantity) || 0), 0);
  const lowStock   = currentItems.filter(p => (Number(p.stock_quantity) || 0) <= (Number(p.min_alert_qty) || 5)).length;

  const skusEl = document.getElementById('metricTotalSkus');
  const unitsEl = document.getElementById('metricTotalUnits');
  const lowEl = document.getElementById('metricLowStock');
  const labelEl = document.getElementById('metricSkusLabel');

  if (skusEl) skusEl.textContent = totalItems;
  if (unitsEl) unitsEl.textContent = totalUnits;
  if (lowEl) lowEl.textContent = lowStock;
  if (labelEl) labelEl.textContent = labelText;
}

function renderItemRowHtml(p) {
  const stock    = Number(p.stock_quantity) || 0;
  const alertQty = Number(p.min_alert_qty)  || 5;
  let badgeClass = 'in-stock', badgeLabel = 'in stock';
  if (stock === 0)          { badgeClass = 'out-of-stock'; badgeLabel = 'out of stock'; }
  else if (stock <= alertQty) { badgeClass = 'low-stock';   badgeLabel = 'low stock'; }

  return `
    <div class="inventory-list-row" id="prod-row-${p.id}">
      <div class="col-item">
        <button type="button" class="item-title-btn" data-history-id="${p.id}" onclick="window.openItemHistory('${p.id}')" title="Click to view In & Out history">
          <span>${escapeHtml(p.name)}</span>
          <span class="item-history-tag">📜 History</span>
        </button>
      </div>
      <div class="col-stock">
        <span class="stock-pill ${badgeClass}">
          <span style="font-size:1.25rem; font-weight:800;">${stock}</span> ${badgeLabel}
        </span>
      </div>
      <div class="col-actions">
        <button class="btn-list-action restock" onclick="window.openStockAdjust('${p.id}','ADD')" title="Add stock">
          <span>+</span> Add Stock
        </button>
        <button class="btn-list-action deduct" onclick="window.openStockAdjust('${p.id}','DEDUCT')" title="Remove stock">
          <span>-</span> Remove Stock
        </button>
        <button class="btn-list-action delete" onclick="window.deleteItem('${p.id}')" title="Delete item">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </div>`;
}

// Page 1 – Poultry Stock List
function renderPoultryProducts() {
  const listContainer = document.getElementById('inventoryList');
  if (!listContainer) return;

  const poultryItems = getPoultryProducts();
  const searchVal = (document.getElementById('inventorySearch')?.value || '').toLowerCase().trim();
  const filtered  = poultryItems.filter(p => !searchVal || p.name.toLowerCase().includes(searchVal));

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align:center; padding:48px 20px; color:var(--text-secondary); animation:viewEnter 0.3s ease both;">
        <div style="font-size:2.8rem; margin-bottom:10px;">🐔</div>
        <p style="font-size:1.1rem; font-weight:600; color:var(--text-primary);">No poultry items found</p>
        <p style="font-size:0.85rem; margin-top:4px;">Use the "+ Add New Poultry Item" form above to add an item.</p>
      </div>`;
    return;
  }

  listContainer.innerHTML = filtered.map(p => renderItemRowHtml(p)).join('');
}
const renderProducts = renderPoultryProducts;

// Page 2 – Pet Food Stock List
function renderPetFoodProducts() {
  const listContainer = document.getElementById('petFoodList');
  if (!listContainer) return;

  const petFoodItems = getPetFoodProducts();
  const searchVal = (document.getElementById('petFoodSearch')?.value || '').toLowerCase().trim();
  const filtered  = petFoodItems.filter(p => !searchVal || p.name.toLowerCase().includes(searchVal));

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align:center; padding:48px 20px; color:var(--text-secondary); animation:viewEnter 0.3s ease both;">
        <div style="font-size:2.8rem; margin-bottom:10px;">🐾</div>
        <p style="font-size:1.1rem; font-weight:600; color:var(--text-primary);">No pet food items found</p>
        <p style="font-size:0.85rem; margin-top:4px;">Use the "+ Add New Pet Food Item" form above to add an item.</p>
      </div>`;
    return;
  }

  listContainer.innerHTML = filtered.map(p => renderItemRowHtml(p)).join('');
}

// Page 2 – In & Out list (same items, read-only view of stock)
function renderInOutList() {
  const container = document.getElementById('inoutItemList');
  if (!container) return;

  if (products.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:36px 20px; color:var(--text-secondary);">
        No items in stock. Add an item from the Stock List page.
      </div>`;
    return;
  }

  container.innerHTML = products.map(p => {
    const stock    = Number(p.stock_quantity) || 0;
    const alertQty = Number(p.min_alert_qty)  || 5;
    let badgeClass = 'in-stock', badgeLabel = 'in stock';
    if (stock === 0)          { badgeClass = 'out-of-stock'; badgeLabel = 'out of stock'; }
    else if (stock <= alertQty) { badgeClass = 'low-stock';   badgeLabel = 'low stock'; }

    return `
      <div class="inventory-list-row" id="inout-row-${p.id}">
        <div class="col-item">
          <button type="button" class="item-title-btn" data-history-id="${p.id}" onclick="window.openItemHistory('${p.id}')" title="Click to view In & Out history">
            <span>${escapeHtml(p.name)}</span>
            <span class="item-history-tag">📜 History</span>
          </button>
        </div>
        <div class="col-stock">
          <span class="stock-pill ${badgeClass}">
            <span style="font-size:1.2rem; font-weight:800;">${stock}</span> ${badgeLabel}
          </span>
        </div>
        <div class="col-actions" style="font-size:0.82rem; color:var(--text-muted);">
          Use the buttons above to add shipment or dispatch stock.
        </div>
      </div>`;
  }).join('');
}

// In & Out Activity Log
function renderInOutActivity() {
  const tbody = document.getElementById('inoutActivityTableBody');
  if (!tbody) return;

  if (movements.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">No In/Out activity recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = movements.slice(0, 30).map(m => {
    const isIN    = m.type === 'IN';
    const tagClass = isIN ? 'tx-in' : 'tx-out';
    const tagText  = isIN ? '📥 Shipment Arrived (+)' : '📤 Out for Distribution (-)';
    return `
      <tr>
        <td style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-muted);">${new Date(m.created_at).toLocaleString()}</td>
        <td><span class="tx-type-tag ${tagClass}">${tagText}</span></td>
        <td style="font-weight:700;">${escapeHtml(m.product_name)}</td>
        <td style="font-family:var(--font-mono); font-weight:800; font-size:1rem; color:${isIN ? 'var(--accent-emerald)' : 'var(--accent-amber)'};">
          ${isIN ? '+' : '-'}${m.quantity}
        </td>
        <td style="color:var(--text-secondary); font-size:0.82rem;">${escapeHtml(m.note || '-')}</td>
      </tr>`;
  }).join('');
}

// ── Batch Modal (Shipment In / Distribution Out) ───────────────────────────────

// Current batch values map: productId -> quantity
const batchValues = new Map();

function openBatchModal(mode) {
  batchMode = mode; // 'IN' or 'OUT'

  const titleEl    = document.getElementById('batchModalTitle');
  const subtitleEl = document.getElementById('batchModalSubtitle');
  const saveBtn    = document.getElementById('saveBatchUpdateBtn');
  const invoiceField = document.getElementById('batchInvoiceField');
  const invoiceInput = document.getElementById('batchModalInvoice');

  if (mode === 'IN') {
    titleEl.textContent    = '📥 Add Shipment — Receive Items into Stock';
    subtitleEl.textContent = 'Enter how many units arrived for each item. Leave 0 to skip.';
    saveBtn.textContent    = '💾 Save Shipment & Update Stock';
    saveBtn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
    if (invoiceField) invoiceField.style.display = 'none';
  } else {
    titleEl.textContent    = '📤 Out for Distribution — Dispatch Items from Stock';
    subtitleEl.textContent = 'Enter how many units to dispatch for each item. Leave 0 to skip.';
    saveBtn.textContent    = '💾 Save Distribution & Update Stock';
    saveBtn.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
    if (invoiceField) invoiceField.style.display = 'block';
  }

  batchValues.clear();
  const searchInput = document.getElementById('batchModalSearch');
  if (searchInput) searchInput.value = '';
  document.getElementById('batchModalNote').value = '';
  if (invoiceInput) invoiceInput.value = '';

  renderBatchModalItems();
  document.getElementById('batchInOutModal').classList.add('active');
  if (mode === 'OUT' && invoiceInput) {
    setTimeout(() => invoiceInput.focus(), 150);
  }
}

function renderBatchModalItems() {
  const container = document.getElementById('batchModalItemsList');
  if (!container) return;

  const searchFilter = (document.getElementById('batchModalSearch')?.value || '').toLowerCase().trim();
  const filteredProducts = products.filter(p => !searchFilter || p.name.toLowerCase().includes(searchFilter));

  if (filteredProducts.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:32px 16px; color:var(--text-secondary);">
        No matching items found.
      </div>`;
    updateBatchTotalCount();
    return;
  }

  container.innerHTML = filteredProducts.map(p => {
    const stock = Number(p.stock_quantity) || 0;
    const currentVal = batchValues.has(p.id) ? batchValues.get(p.id) : 0;
    const isActive = currentVal > 0;
    const isPet = isPetFoodProduct(p);
    const categoryBadge = isPet 
      ? `<span class="category-tag-pet" style="font-size:0.72rem; padding:1px 6px;">🐾 Pet Food</span>`
      : `<span class="category-tag-poultry" style="font-size:0.72rem; padding:1px 6px;">🐔 Poultry</span>`;
    return `
      <div class="batch-item-row ${isActive ? 'batch-row-active' : ''}" id="batch-row-${p.id}" data-product-id="${p.id}">
        <div class="batch-item-name">
          <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            <span style="font-weight:700; font-size:0.97rem;">${escapeHtml(p.name)}</span>
            ${categoryBadge}
          </div>
          <span class="batch-current-stock">Available: <strong>${stock}</strong></span>
        </div>
        <div class="batch-qty-control">
          <button type="button" class="batch-minus-btn" onclick="window.batchChangeQty('${p.id}', -1)" aria-label="Decrease">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <input
            type="number"
            id="batch-qty-${p.id}"
            class="batch-qty-input"
            value="${currentVal}"
            min="0"
            inputmode="numeric"
            aria-label="Quantity for ${escapeHtml(p.name)}"
            onfocus="this.select()"
            oninput="window.batchQtyInputChanged('${p.id}')"
            onblur="window.batchQtyInputBlurred('${p.id}')"
          >
          <button type="button" class="batch-plus-btn" onclick="window.batchChangeQty('${p.id}', 1)" aria-label="Increase">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  updateBatchTotalCount();
}

// Search filter in modal (debounced)
document.getElementById('batchModalSearch')?.addEventListener('input', debounce(renderBatchModalItems, 100));

// Called by +/- buttons
window.batchChangeQty = (productId, delta) => {
  const current = batchValues.has(productId) ? batchValues.get(productId) : 0;
  let next = Math.max(0, current + delta);

  if (batchMode === 'OUT') {
    const prod = products.find(p => p.id === productId);
    const maxStock = Number(prod?.stock_quantity) || 0;
    if (next > maxStock) {
      showToast(`Cannot exceed current stock (${maxStock}) for "${prod?.name}"`, 'danger');
      playBeep(220, 0.2, 'sawtooth');
      next = maxStock;
    }
  }

  batchValues.set(productId, next);
  const input = document.getElementById(`batch-qty-${productId}`);
  if (input) input.value = next;
  highlightBatchRow(productId, next);
  updateBatchTotalCount();
};

// Called when user types directly
window.batchQtyInputChanged = (productId) => {
  const input = document.getElementById(`batch-qty-${productId}`);
  if (!input) return;
  const raw = input.value.trim();
  const val = raw === '' ? 0 : parseInt(raw, 10);
  const safeVal = isNaN(val) || val < 0 ? 0 : val;
  batchValues.set(productId, safeVal);
  highlightBatchRow(productId, safeVal);
  updateBatchTotalCount();
};

window.batchQtyInputBlurred = (productId) => {
  const input = document.getElementById(`batch-qty-${productId}`);
  if (!input) return;
  const raw = input.value.trim();
  const val = raw === '' ? 0 : parseInt(raw, 10);
  let safeVal = isNaN(val) || val < 0 ? 0 : val;

  if (batchMode === 'OUT') {
    const prod = products.find(p => p.id === productId);
    const maxStock = Number(prod?.stock_quantity) || 0;
    if (safeVal > maxStock) {
      showToast(`Adjusted to maximum available stock (${maxStock}) for "${prod?.name}"`, 'danger');
      safeVal = maxStock;
    }
  }

  input.value = safeVal;
  batchValues.set(productId, safeVal);
  highlightBatchRow(productId, safeVal);
  updateBatchTotalCount();
};

function highlightBatchRow(productId, qty) {
  const row = document.getElementById(`batch-row-${productId}`);
  if (!row) return;
  row.classList.toggle('batch-row-active', qty > 0);
}

function updateBatchTotalCount() {
  let count = 0;
  products.forEach(p => {
    if ((batchValues.get(p.id) || 0) > 0) count++;
  });
  const el = document.getElementById('batchTotalCount');
  if (el) el.textContent = count;
}

// Reset all batch inputs to 0
document.getElementById('resetBatchInputsBtn')?.addEventListener('click', () => {
  batchValues.clear();
  renderBatchModalItems();
  updateBatchTotalCount();
});

// Save Batch Update
document.getElementById('saveBatchUpdateBtn')?.addEventListener('click', async () => {
  const note = (document.getElementById('batchModalNote')?.value || '').trim();
  const invoiceVal = (document.getElementById('batchModalInvoice')?.value || '').trim();

  let noteText;
  if (batchMode === 'OUT') {
    if (invoiceVal) {
      noteText = `Invoice #${invoiceVal}${note ? ' • ' + note : ''}`;
    } else {
      noteText = note || 'Dispatched for Distribution';
    }
  } else {
    noteText = note || 'Shipment Arrival';
  }

  // Collect items with qty > 0 from batchValues
  const updates = [];
  products.forEach(p => {
    const qty = batchValues.get(p.id) || 0;
    if (qty > 0) {
      updates.push({ product: p, qty });
    }
  });

  if (updates.length === 0) {
    showToast('No quantities entered. Please enter a value for at least one item.', 'danger');
    return;
  }

  // Validate OUT doesn't exceed current stock
  if (batchMode === 'OUT') {
    for (const { product, qty } of updates) {
      if (qty > (Number(product.stock_quantity) || 0)) {
        showToast(`Cannot dispatch ${qty} of "${product.name}" — only ${product.stock_quantity} in stock!`, 'danger');
        playBeep(220, 0.25, 'sawtooth');
        return;
      }
    }
  }

  const saveBtn = document.getElementById('saveBatchUpdateBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = '⏳ Saving...';

  try {
    for (const { product, qty } of updates) {
      const currentStock = Number(product.stock_quantity) || 0;
      const newStock     = batchMode === 'IN'
        ? currentStock + qty
        : Math.max(0, currentStock - qty);

      // Optimistic local update
      product.stock_quantity = newStock;
      product.updated_at     = new Date().toISOString();
      const optMov = {
        id:           'm-' + Date.now() + '-' + product.id,
        product_id:   product.id,
        product_name: product.name,
        type:         batchMode,
        quantity:     qty,
        invoice_number: batchMode === 'OUT' && invoiceVal ? invoiceVal : null,
        note:         noteText,
        created_at:   new Date().toISOString(),
      };
      movements.unshift(optMov);

      if (isLiveSupabase && supabase) {
        await supabase.from('products').update({
          stock_quantity: newStock,
          updated_at:     new Date().toISOString(),
        }).eq('id', product.id);

        const { data: txData } = await supabase.from('transactions').insert({
          product_id:   product.id,
          product_name: product.name,
          type:         batchMode === 'IN' ? 'SHIPMENT_IN' : 'SALE_OUT',
          quantity:     qty,
          notes:        noteText,
        }).select().single();

        if (txData) {
          optMov.id = txData.id;
          optMov.created_at = txData.created_at;
        }
      }
      highlightUpdatedRow(product.id);
    }

    saveDataToStorage();
    renderAll();

    const verb = batchMode === 'IN' ? 'Shipment saved' : 'Distribution recorded';
    const invMsg = batchMode === 'OUT' && invoiceVal ? ` [Invoice #${invoiceVal}]` : '';
    showToast(`${verb}${invMsg} — ${updates.length} item(s) updated!`, 'success');
    playSuccessChime();
    triggerHaptic();

    // Close modal
    batchValues.clear();
    if (document.getElementById('batchModalInvoice')) {
      document.getElementById('batchModalInvoice').value = '';
    }
    document.getElementById('batchInOutModal')?.classList.remove('active');

  } catch (err) {
    showToast('Error saving batch update: ' + err.message, 'danger');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = batchMode === 'IN' ? '💾 Save Shipment & Update Stock' : '💾 Save Distribution & Update Stock';
  }
});

// Open Batch Shipment / Distribution buttons anywhere in the app
document.querySelectorAll('.js-open-shipment, #openShipmentBatchBtn').forEach(btn => {
  btn.addEventListener('click', () => openBatchModal('IN'));
});

document.querySelectorAll('.js-open-distribution, #openDistributionBatchBtn').forEach(btn => {
  btn.addEventListener('click', () => openBatchModal('OUT'));
});

// Close Batch Modal
document.getElementById('closeBatchModal')?.addEventListener('click', () => {
  document.getElementById('batchInOutModal')?.classList.remove('active');
});

// Click outside batch modal to close
document.getElementById('batchInOutModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('batchInOutModal')) {
    document.getElementById('batchInOutModal').classList.remove('active');
  }
});

// ── Single-Item Stock Adjustment Modal (from Page 1) ──────────────────────────
let activeAdjustProductId = null;
let activeAdjustAction    = 'ADD';

window.openStockAdjust = (productId, action) => {
  const prod = products.find(p => p.id === productId);
  if (!prod) return;

  activeAdjustProductId = productId;
  activeAdjustAction    = action;

  document.getElementById('adjustItemName').textContent = `${prod.name} (Current: ${prod.stock_quantity})`;
  document.getElementById('adjustQtyInput').value       = '1';

  if (action === 'ADD') {
    document.getElementById('adjustModalTitle').textContent = 'Add Incoming Stock (Shipment)';
    document.getElementById('adjustQtyLabel').textContent   = 'Units Received';
    document.getElementById('adjustConfirmBtn').textContent = '+ Add to Stock';
    document.getElementById('adjustConfirmBtn').className   = 'btn btn-primary';
  } else {
    document.getElementById('adjustModalTitle').textContent = 'Deduct Stock (Distribution / Out)';
    document.getElementById('adjustQtyLabel').textContent   = 'Units Out';
    document.getElementById('adjustConfirmBtn').textContent = '- Deduct from Stock';
    document.getElementById('adjustConfirmBtn').className   = 'btn btn-sale';
  }

  document.getElementById('adjustStockModal').classList.add('active');
  document.getElementById('adjustQtyInput').focus();
  document.getElementById('adjustQtyInput').select();
};

document.getElementById('closeAdjustModal')?.addEventListener('click', () => {
  document.getElementById('adjustStockModal').classList.remove('active');
});

document.getElementById('adjustStockModal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('adjustStockModal')) {
    document.getElementById('adjustStockModal').classList.remove('active');
  }
});

document.getElementById('adjustStockForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const qty = parseInt(document.getElementById('adjustQtyInput').value, 10);
  if (isNaN(qty) || qty <= 0) return;

  const prod = products.find(p => p.id === activeAdjustProductId);
  if (!prod) return;

  let newStock = Number(prod.stock_quantity) || 0;
  if (activeAdjustAction === 'ADD') {
    newStock += qty;
  } else {
    if (qty > newStock) {
      showToast(`Cannot deduct ${qty} units! Only ${newStock} available.`, 'danger');
      playBeep(220, 0.25, 'sawtooth');
      return;
    }
    newStock = Math.max(0, newStock - qty);
  }

  prod.stock_quantity = newStock;
  prod.updated_at     = new Date().toISOString();
  const optMov = {
    id:           'm-' + Date.now(),
    product_id:   prod.id,
    product_name: prod.name,
    type:         activeAdjustAction === 'ADD' ? 'IN' : 'OUT',
    quantity:     qty,
    note:         activeAdjustAction === 'ADD' ? 'Shipment Arrival' : 'Dispatched for Distribution',
    created_at:   new Date().toISOString(),
  };
  movements.unshift(optMov);
  saveDataToStorage();
  renderAll();
  highlightUpdatedRow(prod.id);

  if (isLiveSupabase && supabase) {
    try {
      await supabase.from('products').update({
        stock_quantity: newStock,
        updated_at:     new Date().toISOString(),
      }).eq('id', prod.id);

      const { data: txData } = await supabase.from('transactions').insert({
        product_id:   prod.id,
        product_name: prod.name,
        type:         activeAdjustAction === 'ADD' ? 'SHIPMENT_IN' : 'SALE_OUT',
        quantity:     qty,
        notes:        activeAdjustAction === 'ADD' ? 'Quick Stock Addition' : 'Quick Stock Deduction',
      }).select().single();

      if (txData) {
        optMov.id = txData.id;
        optMov.created_at = txData.created_at;
      }
    } catch (err) {
      showToast('Error syncing with database: ' + err.message, 'danger');
      return;
    }
  }

  showToast(`${activeAdjustAction === 'ADD' ? '+' : '-'}${qty} units updated for ${prod.name}!`, 'success');
  playSuccessChime();
  triggerHaptic();
  document.getElementById('adjustStockModal').classList.remove('active');
});

// ── Add New Poultry Item Form (Page 1) ─────────────────────────────────────────
document.getElementById('directAddItemForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name  = document.getElementById('directItemName').value.trim();
  const stock = parseInt(document.getElementById('directItemStock').value, 10) || 0;
  if (!name) return;

  const newObj = { name, category: 'Poultry', stock_quantity: stock, min_alert_qty: 5, updated_at: new Date().toISOString() };

  if (isLiveSupabase && supabase) {
    try {
      const { data, error } = await supabase.from('products').insert(newObj).select().single();
      if (error) throw error;
      if (data && !products.some(p => String(p.id) === String(data.id))) {
        products.unshift(data);
        saveDataToStorage();
        renderAll();
        highlightUpdatedRow(data.id);
      }
      showToast(`Added poultry item "${name}" with ${stock} in stock!`, 'success');
      playSuccessChime();
    } catch (err) {
      showToast('Error saving product: ' + err.message, 'danger');
      return;
    }
  } else {
    newObj.id = 'prod-' + Date.now();
    products.unshift(newObj);
    saveDataToStorage();
    renderAll();
    highlightUpdatedRow(newObj.id);
    showToast(`Added poultry item "${name}" with ${stock} in stock!`, 'success');
    playSuccessChime();
  }

  document.getElementById('directItemName').value  = '';
  document.getElementById('directItemStock').value = '10';
  document.getElementById('directItemName').focus();
});

// ── Add New Pet Food Item Form (Page 2) ────────────────────────────────────────
document.getElementById('directAddPetFoodForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name  = document.getElementById('directPetFoodName').value.trim();
  const stock = parseInt(document.getElementById('directPetFoodStock').value, 10) || 0;
  if (!name) return;

  const newObj = { name, category: 'Pet Food', stock_quantity: stock, min_alert_qty: 5, updated_at: new Date().toISOString() };

  if (isLiveSupabase && supabase) {
    try {
      const { data, error } = await supabase.from('products').insert(newObj).select().single();
      if (error) throw error;
      if (data && !products.some(p => String(p.id) === String(data.id))) {
        products.unshift(data);
        saveDataToStorage();
        renderAll();
        highlightUpdatedRow(data.id);
      }
      showToast(`Added pet food item "${name}" with ${stock} in stock!`, 'success');
      playSuccessChime();
    } catch (err) {
      showToast('Error saving pet food: ' + err.message, 'danger');
      return;
    }
  } else {
    newObj.id = 'prod-' + Date.now();
    products.unshift(newObj);
    saveDataToStorage();
    renderAll();
    highlightUpdatedRow(newObj.id);
    showToast(`Added pet food item "${name}" with ${stock} in stock!`, 'success');
    playSuccessChime();
  }

  document.getElementById('directPetFoodName').value  = '';
  document.getElementById('directPetFoodStock').value = '10';
  document.getElementById('directPetFoodName').focus();
});

// ── Delete Item ────────────────────────────────────────────────────────────────
window.deleteItem = async (productId) => {
  const prod = products.find(p => p.id === productId);
  if (!prod) return;
  if (!confirm(`Remove "${prod.name}" from your list?`)) return;

  if (isLiveSupabase && supabase) {
    try {
      const { error } = await supabase.from('products').delete().eq('id', productId);
      if (error) throw error;
      products = products.filter(p => p.id !== productId);
      saveDataToStorage();
      renderAll();
      showToast(`Removed "${prod.name}"`, 'info');
    } catch (err) {
      showToast('Error deleting item: ' + err.message, 'danger');
    }
  } else {
    products = products.filter(p => p.id !== productId);
    saveDataToStorage();
    renderAll();
    showToast(`Removed "${prod.name}"`, 'info');
  }
};

// ── Searches (Poultry & Pet Food) ──────────────────────────────────────────────
document.getElementById('inventorySearch')?.addEventListener('input', debounce(renderPoultryProducts, 100));
document.getElementById('petFoodSearch')?.addEventListener('input', debounce(renderPetFoodProducts, 100));

// ── Tab Navigation ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
  const normalizedTab = (tabId === 'inventory') ? 'poultry' : tabId;
  currentActiveTab = normalizedTab;

  document.querySelectorAll('.desktop-nav .nav-btn').forEach(btn => {
    const btnTab = btn.getAttribute('data-tab');
    const isMatch = btnTab === normalizedTab || (btnTab === 'inventory' && normalizedTab === 'poultry');
    btn.classList.toggle('active', isMatch);
  });
  document.querySelectorAll('.mobile-nav-bar .mobile-nav-item').forEach(btn => {
    const btnTab = btn.getAttribute('data-tab');
    const isMatch = btnTab === normalizedTab || (btnTab === 'inventory' && normalizedTab === 'poultry');
    btn.classList.toggle('active', isMatch);
  });
  document.querySelectorAll('.view-section').forEach(view => {
    const isMatch = view.id === `view-${normalizedTab}` || (view.id === 'view-inventory' && normalizedTab === 'poultry');
    view.classList.toggle('active', isMatch);
  });

  renderMetrics();
  if (normalizedTab === 'poultry') {
    renderPoultryProducts();
  } else if (normalizedTab === 'petfood') {
    renderPetFoodProducts();
  } else if (normalizedTab === 'inout') {
    renderInOutList();
    renderInOutActivity();
  } else if (normalizedTab === 'records') {
    renderRecordsPage();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
});

// Records Filter Pills (All / Poultry / Pet Food)
document.querySelectorAll('[data-invoice-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-invoice-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentInvoiceFilter = btn.getAttribute('data-invoice-filter') || 'ALL';
    renderRecordsPage();
  });
});

// ── Date Formatting Utility ───────────────────────────────────────────────────
function formatDateTime(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }) + ' • ' + d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return isoString;
  }
}

// ── Records & Invoices Management (Memoized) ──────────────────────────────────
function getInvoiceRecords() {
  if (cachedInvoiceRecords) return cachedInvoiceRecords;

  const invoiceMap = new Map();
  const seenTxIds = new Set();

  for (let idx = 0; idx < movements.length; idx++) {
    const m = movements[idx];
    if (m.type !== 'OUT') continue;

    // Deduplicate identical transaction IDs
    if (m.id) {
      if (seenTxIds.has(String(m.id))) continue;
      seenTxIds.add(String(m.id));
    }

    const inv = m.invoice_number || parseInvoiceNumber(m.note);
    const key = inv ? `inv_${inv.toLowerCase()}` : `quick_${m.id}`;
    const displayNum = inv || 'Quick Dispatch (No #)';
    const cleanNote = cleanInvoiceNote(m.note, inv);
    const itemIsPetFood = isPetFoodProduct(m.product_id, m.product_name);

    let rec = invoiceMap.get(key);
    if (!rec) {
      rec = {
        key,
        invoice_number: displayNum,
        raw_invoice: inv,
        isCustomInvoice: !!inv,
        created_at: m.created_at,
        formatted_date: formatDateTime(m.created_at),
        note: cleanNote,
        items: [],
        total_units: 0,
        hasPetFood: false,
        hasPoultry: false,
        isPetFoodInvoice: false
      };
      invoiceMap.set(key, rec);
    }

    const qty = Number(m.quantity) || 0;

    // Guard against duplicate optimistic + remote items inside the same invoice
    const duplicateItemIdx = rec.items.findIndex(existing => 
      String(existing.product_id) === String(m.product_id) &&
      Number(existing.quantity) === qty &&
      (
        existing.id === m.id ||
        (String(existing.id).startsWith('m-') || String(m.id).startsWith('m-'))
      ) &&
      Math.abs(new Date(existing.created_at).getTime() - new Date(m.created_at).getTime()) < 30000
    );

    if (duplicateItemIdx !== -1) {
      if (String(rec.items[duplicateItemIdx].id).startsWith('m-') && !String(m.id).startsWith('m-')) {
        rec.items[duplicateItemIdx].id = m.id;
        rec.items[duplicateItemIdx].created_at = m.created_at;
      }
      continue;
    }

    if (itemIsPetFood) {
      rec.hasPetFood = true;
    } else {
      rec.hasPoultry = true;
    }

    rec.items.push({
      id: m.id,
      product_id: m.product_id,
      product_name: m.product_name,
      quantity: qty,
      isPetFood: itemIsPetFood,
      created_at: m.created_at
    });
    rec.total_units += qty;
    if (new Date(m.created_at) > new Date(rec.created_at)) {
      rec.created_at = m.created_at;
      rec.formatted_date = formatDateTime(m.created_at);
    }
    if ((!rec.note || rec.note === '-') && cleanNote && cleanNote !== '-') {
      rec.note = cleanNote;
    }
  }

  const list = Array.from(invoiceMap.values());
  list.forEach(rec => {
    // If invoice contains pet food items, classify as Pet Food invoice
    rec.isPetFoodInvoice = rec.hasPetFood;
  });

  cachedInvoiceRecords = list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return cachedInvoiceRecords;
}

function renderRecordsPage() {
  const container = document.getElementById('recordsList');
  if (!container) return;

  const allRecords = getInvoiceRecords();

  const totalInvoices = allRecords.filter(r => r.isCustomInvoice).length;
  const totalUnits = allRecords.reduce((sum, r) => sum + r.total_units, 0);

  const poultryInvoices = allRecords.filter(r => !r.isPetFoodInvoice);
  const petFoodInvoices = allRecords.filter(r => r.isPetFoodInvoice);

  const totInvEl = document.getElementById('recordsTotalInvoices');
  const totUnitsEl = document.getElementById('recordsTotalUnits');
  const actProdEl = document.getElementById('recordsActiveProducts');

  if (totInvEl) totInvEl.textContent = totalInvoices || allRecords.length;
  if (totUnitsEl) totUnitsEl.textContent = totalUnits;
  if (actProdEl) actProdEl.textContent = products.length;

  // Update counts on filter pills
  const cAll = document.getElementById('countInvAll');
  const cPoultry = document.getElementById('countInvPoultry');
  const cPet = document.getElementById('countInvPetFood');
  if (cAll) cAll.textContent = allRecords.length;
  if (cPoultry) cPoultry.textContent = poultryInvoices.length;
  if (cPet) cPet.textContent = petFoodInvoices.length;

  // Filter based on active category filter tab
  let categoryFiltered = allRecords;
  if (currentInvoiceFilter === 'POULTRY') {
    categoryFiltered = poultryInvoices;
  } else if (currentInvoiceFilter === 'PET_FOOD') {
    categoryFiltered = petFoodInvoices;
  }

  const query = (document.getElementById('recordsSearch')?.value || '').toLowerCase().trim();
  const filtered = categoryFiltered.filter(r => {
    if (!query) return true;
    if (r.invoice_number.toLowerCase().includes(query)) return true;
    if (r.note && r.note.toLowerCase().includes(query)) return true;
    if (r.formatted_date.toLowerCase().includes(query)) return true;
    return r.items.some(i => i.product_name.toLowerCase().includes(query));
  });

  if (filtered.length === 0) {
    const filterName = currentInvoiceFilter === 'PET_FOOD' ? 'pet food' : currentInvoiceFilter === 'POULTRY' ? 'poultry' : '';
    container.innerHTML = `
      <div style="text-align:center; padding:48px 20px; color:var(--text-secondary); animation:viewEnter 0.3s ease both;">
        <div style="font-size:2.8rem; margin-bottom:10px;">🧾</div>
        <p style="font-size:1.1rem; font-weight:600; color:var(--text-primary);">No ${filterName} invoice records found</p>
        <p style="font-size:0.85rem; margin-top:4px;">Dispatches created with an Invoice Number will automatically appear here.</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(r => {
    const isPet = r.isPetFoodInvoice;
    const accentColor = isPet ? 'var(--accent-emerald)' : 'var(--accent-amber)';

    const itemsPreview = r.items
      .map(i => `<span style="font-weight:600; color:var(--text-primary);">${escapeHtml(i.product_name)}</span>: <span style="font-family:var(--font-mono); color:${accentColor}; font-weight:700;">${i.quantity}</span>`)
      .join('<span style="color:var(--text-muted); margin:0 6px;">•</span>');

    return `
      <div class="record-row ${isPet ? 'pet-food-row' : 'poultry-row'}" data-invoice-key="${escapeHtml(r.key)}" onclick="window.openInvoiceDetails('${escapeHtml(r.key)}')" title="Click to view full invoice breakdown">
        <div>
          <span class="invoice-pill ${isPet ? 'pet-food-invoice' : 'poultry-invoice'}">
            <span>🧾</span>
            <span>${escapeHtml(r.invoice_number)}</span>
            ${isPet 
              ? `<span class="category-tag-pet">🐾 Pet Food</span>` 
              : `<span class="category-tag-poultry">🐔 Poultry</span>`}
          </span>
          ${r.note && r.note !== '-' ? `<div style="font-size:0.78rem; color:var(--text-secondary); margin-top:4px;">📍 ${escapeHtml(r.note)}</div>` : ''}
        </div>
        <div style="color:var(--text-secondary); font-size:0.86rem; display:flex; align-items:center; gap:6px;">
          <span>📅</span>
          <span>${r.formatted_date}</span>
        </div>
        <div>
          <div style="font-size:0.88rem; margin-bottom:3px;">
            <strong style="color:${accentColor}; font-family:var(--font-mono); font-size:1rem;">${r.total_units}</strong> units dispatched
            <span style="color:var(--text-muted); font-size:0.8rem;">(${r.items.length} item${r.items.length > 1 ? 's' : ''})</span>
          </div>
          <div style="font-size:0.78rem; line-height:1.4; color:var(--text-secondary);">
            ${itemsPreview}
          </div>
        </div>
        <div style="text-align:right;">
          <button type="button" class="btn btn-secondary view-invoice-btn" onclick="event.stopPropagation(); window.openInvoiceDetails('${escapeHtml(r.key)}')" style="padding:6px 14px; font-size:0.82rem; cursor:pointer;">
            View Details 👁️
          </button>
        </div>
      </div>`;
  }).join('');
}

// Search input listener for Records page (debounced)
document.getElementById('recordsSearch')?.addEventListener('input', debounce(renderRecordsPage, 100));

// ── Invoice Details Modal ───────────────────────────────────────────────────────
window.openInvoiceDetails = function(keyOrNum) {
  if (!keyOrNum) return;
  const records = getInvoiceRecords();
  const searchKey = String(keyOrNum).toLowerCase().trim();
  const rec = records.find(r => 
    String(r.key).toLowerCase() === searchKey ||
    String(r.invoice_number).toLowerCase() === searchKey ||
    (r.raw_invoice && String(r.raw_invoice).toLowerCase() === searchKey) ||
    `inv_${String(r.raw_invoice).toLowerCase()}` === searchKey
  );

  if (!rec) {
    showToast('Invoice details not found', 'danger');
    return;
  }

  const isPet   = rec.isPetFoodInvoice;
  const titleEl = document.getElementById('invoiceDetailsTitle');
  const dateEl  = document.getElementById('invoiceDetailsDate');
  const noteBox = document.getElementById('invoiceDetailsNoteBox');
  const noteEl  = document.getElementById('invoiceDetailsNote');
  const tbody   = document.getElementById('invoiceDetailsTableBody');
  const totalEl = document.getElementById('invoiceDetailsTotalUnits');

  if (titleEl) {
    titleEl.innerHTML = `Invoice #${escapeHtml(rec.invoice_number)} ${isPet ? '<span class="category-tag-pet" style="font-size:0.75rem; vertical-align:middle; margin-left:6px;">🐾 Pet Food</span>' : '<span class="category-tag-poultry" style="font-size:0.75rem; vertical-align:middle; margin-left:6px;">🐔 Poultry</span>'}`;
  }
  if (dateEl) dateEl.textContent = `Dispatched on ${formatDateTime(rec.created_at)}`;

  if (rec.note && rec.note !== '-') {
    noteBox.style.display = 'block';
    noteEl.textContent = rec.note;
  } else {
    noteBox.style.display = 'none';
  }

  if (totalEl) {
    totalEl.textContent = rec.total_units;
    totalEl.style.color = isPet ? 'var(--accent-emerald)' : 'var(--accent-amber)';
  }

  tbody.innerHTML = rec.items.map(i => {
    const prod = products.find(p => String(p.id) === String(i.product_id) || p.name === i.product_name);
    const remainingStock = prod ? (Number(prod.stock_quantity) || 0) : '-';
    const itemColor = (i.isPetFood || isPet) ? 'var(--accent-emerald)' : 'var(--accent-amber)';

    return `
      <tr>
        <td style="font-weight:700; color:var(--text-primary); font-size:0.95rem;">${escapeHtml(i.product_name)}</td>
        <td style="text-align:center; font-family:var(--font-mono); font-weight:800; color:${itemColor}; font-size:1.05rem;">
          -${i.quantity}
        </td>
        <td style="text-align:right; font-family:var(--font-mono); font-weight:700; color:var(--text-secondary); font-size:0.92rem;">
          ${remainingStock} in stock
        </td>
      </tr>`;
  }).join('');

  if (totalEl) totalEl.textContent = rec.total_units;
  const modal = document.getElementById('invoiceDetailsModal');
  if (modal) {
    modal.classList.add('active');
  }
};

document.getElementById('closeInvoiceDetailsModal')?.addEventListener('click', () => {
  document.getElementById('invoiceDetailsModal')?.classList.remove('active');
});
document.getElementById('closeInvoiceDetailsBtn')?.addEventListener('click', () => {
  document.getElementById('invoiceDetailsModal')?.classList.remove('active');
});
document.getElementById('invoiceDetailsModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'invoiceDetailsModal') e.target.classList.remove('active');
});

// ── Item In & Out History Modal ────────────────────────────────────────────────
window.openItemHistory = function(productId) {
  if (!productId) return;
  const prod = products.find(p => String(p.id) === String(productId));
  if (!prod) {
    showToast('Product not found', 'danger');
    return;
  }

  const itemMovements = movements.filter(m => String(m.product_id) === String(prod.id) || m.product_name === prod.name);

  const titleEl = document.getElementById('itemHistoryTitle');
  const subEl   = document.getElementById('itemHistorySubtitle');
  const stockEl = document.getElementById('itemHistoryCurrentStock');
  const inEl    = document.getElementById('itemHistoryTotalIn');
  const outEl   = document.getElementById('itemHistoryTotalOut');
  const countEl = document.getElementById('itemHistoryRecordCount');
  const tbody   = document.getElementById('itemHistoryTableBody');

  const currentStock = Number(prod.stock_quantity) || 0;
  const totalIn = itemMovements.filter(m => m.type === 'IN').reduce((acc, m) => acc + (Number(m.quantity) || 0), 0);
  const totalOut = itemMovements.filter(m => m.type === 'OUT').reduce((acc, m) => acc + (Number(m.quantity) || 0), 0);

  if (titleEl) titleEl.textContent = `In & Out History — ${prod.name}`;
  if (subEl)   subEl.textContent   = `Complete audit trail of all shipments received and stock dispatched for this item.`;
  if (stockEl) stockEl.textContent = currentStock;
  if (inEl)    inEl.textContent    = `+${totalIn}`;
  if (outEl)   outEl.textContent   = `-${totalOut}`;
  if (countEl) countEl.textContent = `${itemMovements.length} total movement(s) recorded`;

  if (itemMovements.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center; padding:32px 16px; color:var(--text-secondary);">
          No movement history recorded for this item yet.
        </td>
      </tr>`;
  } else {
    tbody.innerHTML = itemMovements.map(m => {
      const isIN = m.type === 'IN';
      const inv = m.invoice_number || parseInvoiceNumber(m.note);
      const cleanNote = cleanInvoiceNote(m.note, inv);

      return `
        <tr>
          <td style="color:var(--text-secondary); font-size:0.82rem; white-space:nowrap;">
            ${formatDateTime(m.created_at)}
          </td>
          <td>
            <span class="stock-pill ${isIN ? 'in-stock' : 'low-stock'}" style="font-size:0.75rem; padding:2px 8px;">
              ${isIN ? '📥 IN (Arrival)' : '📤 OUT (Dispatch)'}
            </span>
          </td>
          <td style="text-align:center; font-family:var(--font-mono); font-weight:800; font-size:1.05rem; color:${isIN ? 'var(--accent-emerald)' : 'var(--accent-amber)'};">
            ${isIN ? '+' : '-'}${m.quantity}
          </td>
          <td>
            ${inv 
              ? `<span class="invoice-pill" style="cursor:pointer;" onclick="event.stopPropagation(); window.openInvoiceDetails('${escapeHtml(inv)}')" title="Click to view full invoice breakdown">
                  <span>🧾</span> ${escapeHtml(inv)}
                 </span>`
              : `<span style="color:var(--text-muted); font-size:0.8rem;">—</span>`
            }
          </td>
          <td style="color:var(--text-secondary); font-size:0.82rem;">
            ${escapeHtml(cleanNote || '-')}
          </td>
        </tr>`;
    }).join('');
  }

  document.getElementById('itemHistoryModal')?.classList.add('active');
};

document.getElementById('closeItemHistoryModal')?.addEventListener('click', () => {
  document.getElementById('itemHistoryModal')?.classList.remove('active');
});
document.getElementById('closeItemHistoryBtn')?.addEventListener('click', () => {
  document.getElementById('itemHistoryModal')?.classList.remove('active');
});
document.getElementById('itemHistoryModal')?.addEventListener('click', (e) => {
  if (e.target.id === 'itemHistoryModal') e.target.classList.remove('active');
});

// Event delegation for opening Item History and Invoice Details modals
['inventoryList', 'petFoodList', 'inoutItemList'].forEach(containerId => {
  document.getElementById(containerId)?.addEventListener('click', (e) => {
    const btn = e.target.closest('.item-title-btn');
    if (btn) {
      const id = btn.getAttribute('data-history-id');
      if (id) {
        e.preventDefault();
        window.openItemHistory(id);
      }
    }
  });
});

document.getElementById('recordsList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-invoice-btn');
  const row = e.target.closest('.record-row');
  const target = btn || row;
  if (target) {
    const key = target.getAttribute('data-invoice-key') || row?.getAttribute('data-invoice-key');
    if (key) {
      e.preventDefault();
      window.openInvoiceDetails(key);
    }
  }
});


// ── PWA: Service Worker & Install Prompt ────────────────────────────────────────
let deferredPrompt = null;
const installBtn = document.getElementById('installPwaBtn');
const pwaBanner = document.getElementById('pwaInstallBanner');
const bannerInstallBtn = document.getElementById('bannerInstallBtn');
const bannerDismissBtn = document.getElementById('bannerDismissBtn');

function showInstallUi() {
  if (installBtn) installBtn.style.display = 'inline-flex';
  if (pwaBanner && !sessionStorage.getItem('pwa_banner_dismissed')) {
    pwaBanner.style.display = 'flex';
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  showInstallUi();
});

async function triggerInstallPrompt() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('StockPulse installed successfully!', 'success');
    }
    deferredPrompt = null;
    if (installBtn) installBtn.style.display = 'none';
    if (pwaBanner) pwaBanner.style.display = 'none';
  }
}

installBtn?.addEventListener('click', triggerInstallPrompt);
bannerInstallBtn?.addEventListener('click', triggerInstallPrompt);
bannerDismissBtn?.addEventListener('click', () => {
  if (pwaBanner) pwaBanner.style.display = 'none';
  sessionStorage.setItem('pwa_banner_dismissed', '1');
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  if (installBtn) installBtn.style.display = 'none';
  if (pwaBanner) pwaBanner.style.display = 'none';
  showToast('StockPulse is installed and available on your home screen!', 'success');
});

// Robust Service Worker registration resolving correct repository scope
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let basePath = window.location.pathname;
    if (basePath.endsWith('index.html')) {
      basePath = basePath.slice(0, -'index.html'.length);
    }
    if (!basePath.endsWith('/')) {
      basePath += '/';
    }
    const swUrl = `${window.location.origin}${basePath}sw.js`;
    navigator.serviceWorker.register(swUrl, { scope: basePath }).then(
      (reg) => {
        console.log('[PWA SW] Registered with scope:', reg.scope);
        reg.update();
      },
      (err) => console.warn('[PWA SW] Registration failed:', err)
    );
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
setupBroadcastChannel();
initSupabaseClient();
