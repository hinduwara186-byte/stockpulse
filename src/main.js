// ==============================================================================
// STOCKPULSE - REALTIME STOCK & IN/OUT MANAGEMENT
// Real-time synchronization between PC and Android phone with Free Supabase
// ==============================================================================

// ESC key closes any open modal
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ['adjustStockModal', 'batchInOutModal'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
});

import { createClient } from '@supabase/supabase-js';

// Default starter products (Name & Count only)
const DEFAULT_PRODUCTS = [
  { id: '1', name: 'Arabica Coffee Beans 1kg',       stock_quantity: 45, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: '2', name: 'Organic Green Tea (50 bags)',     stock_quantity: 18, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: '3', name: 'USB-C Fast Charging Cable',       stock_quantity: 60, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: '4', name: 'Wireless Bluetooth Earbuds',      stock_quantity:  8, min_alert_qty: 5, updated_at: new Date().toISOString() },
  { id: '5', name: 'Stainless Steel Water Bottle',    stock_quantity:  3, min_alert_qty: 5, updated_at: new Date().toISOString() },
];

const DEFAULT_MOVEMENTS = [
  { id: 'm-1', product_id: '1', product_name: 'Arabica Coffee Beans 1kg',  type: 'IN',  quantity: 20, note: 'Supplier Shipment Arrival',         created_at: new Date(Date.now() - 3600000 * 5).toISOString() },
  { id: 'm-2', product_id: '4', product_name: 'Wireless Bluetooth Earbuds', type: 'OUT', quantity:  2, note: 'Dispatched for Store Distribution', created_at: new Date(Date.now() - 3600000 * 2).toISOString() },
];

// ── App State ──────────────────────────────────────────────────────────────────
let supabase       = null;
let isLiveSupabase = false;
let products       = [];
let movements      = [];
let broadcastChannel = null;

// Current batch modal mode: 'IN' | 'OUT'
let batchMode = 'IN';

// ── Audio & Haptic ─────────────────────────────────────────────────────────────
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playBeep(freq = 880, duration = 0.08, type = 'sine') {
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
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
      if (event.data?.type === 'PRODUCT_UPDATE') {
        loadDataFromStorage();
        renderAll();
        showToast('Realtime update received from another window/phone!', 'info');
        playBeep(523.25, 0.1);
      }
    };
  }
}

// ── Supabase Init ──────────────────────────────────────────────────────────────
const envSupabaseUrl = import.meta.env?.VITE_SUPABASE_URL || '';
const envSupabaseKey = import.meta.env?.VITE_SUPABASE_ANON_KEY || '';

async function initSupabaseClient() {
  const storedUrl = localStorage.getItem('stockpulse_supabase_url') || envSupabaseUrl;
  const storedKey = localStorage.getItem('stockpulse_supabase_key') || envSupabaseKey;

  const statusDot  = document.getElementById('statusDot');
  const statusText = document.getElementById('syncStatusText');

  if (storedUrl && storedKey) {
    try {
      supabase = createClient(storedUrl, storedKey);
      const { data, error } = await supabase.from('products').select('*').limit(1);
      if (error) throw error;

      isLiveSupabase = true;
      statusDot.className  = 'status-dot pulse';
      statusText.textContent = 'Supabase Cloud Live 🟢';
      showToast('Connected to Supabase Cloud Database!', 'success');

      await fetchRemoteProducts();
      await fetchRemoteMovements();

      supabase
        .channel('public:realtime-products-and-tx')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'products' },     handleRemoteProductChange)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, handleRemoteTransactionChange)
        .subscribe((status) => console.log('[Supabase Realtime]:', status));

      return;
    } catch (err) {
      console.warn('Supabase connect failed, falling back to demo mode:', err);
      showToast('Could not connect to Supabase: ' + err.message, 'danger');
    }
  }

  isLiveSupabase = false;
  statusDot.className  = 'status-dot demo';
  statusText.textContent = 'Demo Mode (Sync Ready) 🟡';
  loadDataFromStorage();
  renderAll();
}

async function fetchRemoteProducts() {
  if (!supabase) return;
  const { data, error } = await supabase.from('products').select('*').order('name');
  if (!error && data) { products = data; renderAll(); }
}

async function fetchRemoteMovements() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from('transactions').select('*')
    .order('created_at', { ascending: false }).limit(30);
  if (!error && data) {
    movements = data.map(tx => ({
      id:           tx.id,
      product_id:   tx.product_id,
      product_name: tx.product_name,
      type:         tx.type === 'SHIPMENT_IN' ? 'IN' : 'OUT',
      quantity:     tx.quantity,
      note:         tx.notes || (tx.type === 'SHIPMENT_IN' ? 'Shipment Received' : 'Dispatched for Distribution'),
      created_at:   tx.created_at,
    }));
    renderInOutActivity();
  }
}

function handleRemoteProductChange(payload) {
  const { eventType, new: newRec, old: oldRec } = payload;
  playSuccessChime();
  if (eventType === 'INSERT') {
    products.unshift(newRec);
    showToast(`New item added: ${newRec.name}`, 'info');
  } else if (eventType === 'UPDATE') {
    const idx = products.findIndex(p => p.id === newRec.id);
    if (idx !== -1) { products[idx] = newRec; highlightUpdatedRow(newRec.id); }
    showToast(`Stock updated for ${newRec.name}: now ${newRec.stock_quantity}`, 'success');
  } else if (eventType === 'DELETE') {
    products = products.filter(p => p.id !== oldRec.id);
  }
  renderAll();
}

function handleRemoteTransactionChange(payload) {
  if (payload.eventType === 'INSERT') {
    const tx = payload.new;
    movements.unshift({
      id:           tx.id,
      product_id:   tx.product_id,
      product_name: tx.product_name,
      type:         tx.type === 'SHIPMENT_IN' ? 'IN' : 'OUT',
      quantity:     tx.quantity,
      note:         tx.notes || '',
      created_at:   tx.created_at,
    });
    renderInOutActivity();
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
  const storedProd = localStorage.getItem('stockpulse_simple_products');
  const storedMov  = localStorage.getItem('stockpulse_simple_movements');
  products  = storedProd ? JSON.parse(storedProd) : [...DEFAULT_PRODUCTS];
  movements = storedMov  ? JSON.parse(storedMov)  : [...DEFAULT_MOVEMENTS];
  if (!storedProd || !storedMov) saveDataToStorage();
}

function saveDataToStorage() {
  localStorage.setItem('stockpulse_simple_products', JSON.stringify(products));
  localStorage.setItem('stockpulse_simple_movements', JSON.stringify(movements));
  broadcastChannel?.postMessage({ type: 'PRODUCT_UPDATE' });
}

// ── Render Functions ───────────────────────────────────────────────────────────
function renderAll() {
  renderMetrics();
  renderProducts();
  renderInOutList();
  renderInOutActivity();
}

function renderMetrics() {
  const totalItems = products.length;
  const totalUnits = products.reduce((acc, p) => acc + (Number(p.stock_quantity) || 0), 0);
  const lowStock   = products.filter(p => (Number(p.stock_quantity) || 0) <= (Number(p.min_alert_qty) || 5)).length;
  document.getElementById('metricTotalSkus').textContent  = totalItems;
  document.getElementById('metricTotalUnits').textContent = totalUnits;
  document.getElementById('metricLowStock').textContent   = lowStock;
}

// Page 1 – Main Stock List
function renderProducts() {
  const listContainer = document.getElementById('inventoryList');
  if (!listContainer) return;

  const searchVal = (document.getElementById('inventorySearch')?.value || '').toLowerCase().trim();
  const filtered  = products.filter(p => !searchVal || p.name.toLowerCase().includes(searchVal));

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align:center; padding:48px 20px; color:var(--text-secondary); animation:viewEnter 0.3s ease both;">
        <div style="font-size:2.8rem; margin-bottom:10px;">📋</div>
        <p style="font-size:1.1rem; font-weight:600; color:var(--text-primary);">No items found</p>
        <p style="font-size:0.85rem; margin-top:4px;">Use the "+ Add New Item" form above to add an item.</p>
      </div>`;
    return;
  }

  listContainer.innerHTML = filtered.map(p => {
    const stock    = Number(p.stock_quantity) || 0;
    const alertQty = Number(p.min_alert_qty)  || 5;
    let badgeClass = 'in-stock', badgeLabel = 'in stock';
    if (stock === 0)          { badgeClass = 'out-of-stock'; badgeLabel = 'out of stock'; }
    else if (stock <= alertQty) { badgeClass = 'low-stock';   badgeLabel = 'low stock'; }

    return `
      <div class="inventory-list-row" id="prod-row-${p.id}">
        <div class="col-item">
          <span class="item-title" style="font-size:1.05rem; font-weight:700;">${escapeHtml(p.name)}</span>
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
  }).join('');
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
          <span class="item-title" style="font-size:1.02rem; font-weight:700;">${escapeHtml(p.name)}</span>
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

  if (mode === 'IN') {
    titleEl.textContent    = '📥 Add Shipment — Receive Items into Stock';
    subtitleEl.textContent = 'Enter how many units arrived for each item. Leave 0 to skip.';
    saveBtn.textContent    = '💾 Save Shipment & Update Stock';
    saveBtn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
  } else {
    titleEl.textContent    = '📤 Out for Distribution — Dispatch Items from Stock';
    subtitleEl.textContent = 'Enter how many units to dispatch for each item. Leave 0 to skip.';
    saveBtn.textContent    = '💾 Save Distribution & Update Stock';
    saveBtn.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
  }

  batchValues.clear();
  const searchInput = document.getElementById('batchModalSearch');
  if (searchInput) searchInput.value = '';
  document.getElementById('batchModalNote').value = '';

  renderBatchModalItems();
  document.getElementById('batchInOutModal').classList.add('active');
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
    return `
      <div class="batch-item-row ${isActive ? 'batch-row-active' : ''}" id="batch-row-${p.id}" data-product-id="${p.id}">
        <div class="batch-item-name">
          <span style="font-weight:700; font-size:0.97rem;">${escapeHtml(p.name)}</span>
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

// Search filter in modal
document.getElementById('batchModalSearch')?.addEventListener('input', () => {
  renderBatchModalItems();
});

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
  const noteText = note || (batchMode === 'IN' ? 'Shipment Arrival' : 'Dispatched for Distribution');

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
      movements.unshift({
        id:           'm-' + Date.now() + '-' + product.id,
        product_id:   product.id,
        product_name: product.name,
        type:         batchMode,
        quantity:     qty,
        note:         noteText,
        created_at:   new Date().toISOString(),
      });

      if (isLiveSupabase && supabase) {
        await supabase.from('products').update({
          stock_quantity: newStock,
          updated_at:     new Date().toISOString(),
        }).eq('id', product.id);

        await supabase.from('transactions').insert({
          product_id:   product.id,
          product_name: product.name,
          type:         batchMode === 'IN' ? 'SHIPMENT_IN' : 'SALE_OUT',
          quantity:     qty,
          notes:        noteText,
        });
      }
      highlightUpdatedRow(product.id);
    }

    saveDataToStorage();
    renderAll();

    const verb = batchMode === 'IN' ? 'Shipment saved' : 'Distribution recorded';
    showToast(`${verb} — ${updates.length} item(s) updated!`, 'success');
    playSuccessChime();
    triggerHaptic();

    // Close modal
    batchValues.clear();
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
  movements.unshift({
    id:           'm-' + Date.now(),
    product_id:   prod.id,
    product_name: prod.name,
    type:         activeAdjustAction === 'ADD' ? 'IN' : 'OUT',
    quantity:     qty,
    note:         activeAdjustAction === 'ADD' ? 'Shipment Arrival' : 'Dispatched for Distribution',
    created_at:   new Date().toISOString(),
  });
  saveDataToStorage();
  renderAll();
  highlightUpdatedRow(prod.id);

  if (isLiveSupabase && supabase) {
    try {
      await supabase.from('products').update({
        stock_quantity: newStock,
        updated_at:     new Date().toISOString(),
      }).eq('id', prod.id);

      await supabase.from('transactions').insert({
        product_id:   prod.id,
        product_name: prod.name,
        type:         activeAdjustAction === 'ADD' ? 'SHIPMENT_IN' : 'SALE_OUT',
        quantity:     qty,
        notes:        activeAdjustAction === 'ADD' ? 'Quick Stock Addition' : 'Quick Stock Deduction',
      });
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

// ── Add New Item Form (Page 1) ─────────────────────────────────────────────────
document.getElementById('directAddItemForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name  = document.getElementById('directItemName').value.trim();
  const stock = parseInt(document.getElementById('directItemStock').value, 10) || 0;
  if (!name) return;

  const newObj = { name, stock_quantity: stock, min_alert_qty: 5, updated_at: new Date().toISOString() };

  if (isLiveSupabase && supabase) {
    try {
      const { data, error } = await supabase.from('products').insert(newObj).select().single();
      if (error) throw error;
      if (data && !products.some(p => p.id === data.id)) {
        products.unshift(data);
        saveDataToStorage();
        renderAll();
        highlightUpdatedRow(data.id);
      }
      showToast(`Added "${name}" with ${stock} in stock!`, 'success');
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
    showToast(`Added "${name}" with ${stock} in stock!`, 'success');
    playSuccessChime();
  }

  document.getElementById('directItemName').value  = '';
  document.getElementById('directItemStock').value = '10';
  document.getElementById('directItemName').focus();
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

// ── Search (Page 1) ────────────────────────────────────────────────────────────
document.getElementById('inventorySearch')?.addEventListener('input', renderProducts);

// ── Tab Navigation ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.desktop-nav .nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.mobile-nav-bar .mobile-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.view-section').forEach(view => {
    view.classList.toggle('active', view.id === `view-${tabId}`);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
});

// ── Settings & Supabase ────────────────────────────────────────────────────────
const urlInput = document.getElementById('supabaseUrlInput');
const keyInput = document.getElementById('supabaseKeyInput');

if (urlInput) urlInput.value = localStorage.getItem('stockpulse_supabase_url') || envSupabaseUrl || '';
if (keyInput) keyInput.value = localStorage.getItem('stockpulse_supabase_key') || envSupabaseKey || '';

document.getElementById('supabaseConfigForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput?.value.trim();
  const key = keyInput?.value.trim();
  if (!url || !key) { showToast('Please enter both Supabase URL and Anon Key.', 'danger'); return; }
  localStorage.setItem('stockpulse_supabase_url', url);
  localStorage.setItem('stockpulse_supabase_key', key);
  showToast('Connecting to your Supabase project...', 'info');
  await initSupabaseClient();
});

document.getElementById('useDemoModeBtn')?.addEventListener('click', () => {
  localStorage.removeItem('stockpulse_supabase_url');
  localStorage.removeItem('stockpulse_supabase_key');
  if (urlInput) urlInput.value = '';
  if (keyInput) keyInput.value = '';
  initSupabaseClient();
  showToast('Switched to Local & Multi-window Sync mode.', 'info');
});

document.getElementById('copySqlBtn')?.addEventListener('click', async () => {
  try {
    const res = await fetch('/supabase_schema.sql');
    const sql = await res.text();
    await navigator.clipboard.writeText(sql);
    showToast('Copied turnkey SQL schema to clipboard!', 'success');
  } catch (_) {
    showToast('Open supabase_schema.sql in the project to copy manually.', 'danger');
  }
});

// ── PWA: Service Worker & Install Button ───────────────────────────────────────
let deferredPrompt = null;
const installBtn   = document.getElementById('installPwaBtn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (installBtn) installBtn.style.display = 'inline-flex';
});

installBtn?.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') showToast('App installed successfully!', 'success');
    deferredPrompt = null;
    installBtn.style.display = 'none';
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(
      (reg) => console.log('[PWA SW] Registered:', reg.scope),
      (err) => console.log('[PWA SW] Registration failed:', err)
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
