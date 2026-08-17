import { db } from "./db.js";
import { tierPrice, convert, formatMoney, describeTiers } from "./pricing.js";
import { exportQuotePdf } from "./pdf.js";
import { requestQuoteNumber, requestRevisionNumber } from "./numbering.js";

function emptyQuote(baseCurrency) {
  return {
    id: null,
    number: null,
    baseNumber: null,
    customer: { name: "", company: "", contact: "" },
    currency: baseCurrency || "CNY",
    items: [],
    note: "",
    total: 0,
  };
}

// 保存/导出时确保报价单有正式编号；离线或接口异常时不阻塞本地保存，留到历史记录里手动重试。
async function ensureQuoteNumber(quote) {
  if (quote.number) return quote;
  try {
    const number = await requestQuoteNumber(state.settings.entity || "LB");
    quote.number = number;
    quote.baseNumber = number;
  } catch (err) {
    console.error(err);
    toast("暂时无法获取正式编号（可能未联网），可稍后在历史记录里重试");
  }
  return quote;
}

const initialSettings = db.getSettings();
const initialDraft = db.getDraft();

const state = {
  tab: "quote",
  settings: initialSettings,
  products: db.getProducts(),
  quotes: db.getQuotes(),
  currentQuote: initialDraft || emptyQuote(initialSettings.baseCurrency),
  editingQuoteId: initialDraft ? initialDraft.id || null : null,
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function persistDraft() {
  db.saveDraft(state.currentQuote);
}

function recomputeQuote() {
  const q = state.currentQuote;
  q.currencies = state.settings.currencies;
  for (const item of q.items) {
    const product = state.products.find((p) => p.id === item.productId);
    if (!product) continue;
    const base = tierPrice(product, item.qty);
    item.unitPrice = convert(base, state.settings.currencies, q.currency);
    item.subtotal = item.unitPrice * item.qty;
  }
  q.total = q.items.reduce((sum, it) => sum + it.subtotal, 0);
  persistDraft();
}

// ---------------- modal ----------------
const modalBackdrop = document.getElementById("modal-backdrop");
const modalCard = document.getElementById("modal-card");

function openModal(html) {
  modalCard.innerHTML = html;
  modalBackdrop.classList.add("open");
}
function closeModal() {
  modalBackdrop.classList.remove("open");
  modalCard.innerHTML = "";
}
modalBackdrop.addEventListener("click", (e) => {
  if (e.target === modalBackdrop) closeModal();
});

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 1800);
}

// ---------------- tabs ----------------
const appContent = document.getElementById("app-content");

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabbar button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  render();
}

function render() {
  if (state.tab === "quote") renderQuoteTab();
  else if (state.tab === "products") renderProductsTab();
  else if (state.tab === "history") renderHistoryTab();
  else if (state.tab === "settings") renderSettingsTab();
}

// ================= QUOTE TAB =================
function renderQuoteTab() {
  const q = state.currentQuote;
  recomputeQuote();
  const currencyOptions = state.settings.currencies
    .map(
      (c) =>
        `<option value="${c.code}" ${c.code === q.currency ? "selected" : ""}>${c.code} ${c.symbol}</option>`
    )
    .join("");

  const itemsHtml = q.items.length
    ? q.items
        .map(
          (it, i) => `
      <div class="item-row">
        <div class="item-main">
          <div class="item-name">${esc(it.name)}</div>
          <div class="item-sub">${esc(it.unit || "")} · 单价 ${formatMoney(
            it.unitPrice,
            state.settings.currencies,
            q.currency
          )}</div>
        </div>
        <div class="item-qty">
          <button data-action="qty-dec" data-index="${i}">−</button>
          <input type="number" min="1" value="${it.qty}" data-action="qty-set" data-index="${i}" />
          <button data-action="qty-inc" data-index="${i}">＋</button>
        </div>
        <div class="item-subtotal">${formatMoney(it.subtotal, state.settings.currencies, q.currency)}</div>
        <button class="icon-btn danger" data-action="item-remove" data-index="${i}" aria-label="删除">✕</button>
      </div>`
        )
        .join("")
    : `<div class="empty-hint">还没有添加商品，点击下方「+ 添加商品」开始</div>`;

  appContent.innerHTML = `
    <section class="panel">
      ${
        state.editingQuoteId
          ? `<div class="banner">正在编辑历史报价单 <button class="link" data-action="quote-new">新建一份</button></div>`
          : ""
      }
      ${q.number ? `<div class="banner">编号 ${esc(q.number)}</div>` : ""}
      <div class="field-row">
        <label>币种</label>
        <select data-action="currency-change">${currencyOptions}</select>
      </div>
      <div class="field-row two">
        <input placeholder="客户 / 公司名称" value="${esc(q.customer.company)}" data-action="cust-company" />
        <input placeholder="联系人" value="${esc(q.customer.name)}" data-action="cust-name" />
      </div>
      <div class="field-row">
        <input placeholder="联系方式（电话/微信）" value="${esc(q.customer.contact)}" data-action="cust-contact" />
      </div>
    </section>

    <section class="panel">
      <div class="panel-title">商品明细</div>
      <div class="item-list">${itemsHtml}</div>
      <button class="btn btn-outline full" data-action="open-picker">＋ 添加商品</button>
    </section>

    <section class="panel">
      <textarea placeholder="备注（可选）" data-action="quote-note">${esc(q.note)}</textarea>
    </section>

    <div class="total-bar">
      <div class="total-amount">合计 ${formatMoney(q.total, state.settings.currencies, q.currency)}</div>
      <div class="total-actions">
        <button class="btn btn-outline" data-action="quote-save">保存</button>
        <button class="btn btn-primary" data-action="quote-export">导出 PDF</button>
      </div>
    </div>
  `;

  appContent.querySelectorAll('[data-action="qty-set"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const i = +e.target.dataset.index;
      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      state.currentQuote.items[i].qty = v;
      renderQuoteTab();
    });
  });
  appContent.querySelector('[data-action="currency-change"]').addEventListener("change", (e) => {
    state.currentQuote.currency = e.target.value;
    renderQuoteTab();
  });
  bindTextInput("cust-company", (v) => (state.currentQuote.customer.company = v));
  bindTextInput("cust-name", (v) => (state.currentQuote.customer.name = v));
  bindTextInput("cust-contact", (v) => (state.currentQuote.customer.contact = v));
  const noteEl = appContent.querySelector('[data-action="quote-note"]');
  if (noteEl) noteEl.addEventListener("input", (e) => {
    state.currentQuote.note = e.target.value;
    persistDraft();
  });
}

function bindTextInput(action, onChange) {
  const el = appContent.querySelector(`[data-action="${action}"]`);
  if (!el) return;
  el.addEventListener("input", (e) => {
    onChange(e.target.value);
    persistDraft();
  });
}

function openProductPicker() {
  const render = (filter = "") => {
    const f = filter.trim().toLowerCase();
    const list = state.products.filter((p) => !f || p.name.toLowerCase().includes(f));
    return `
      <div class="modal-header">
        <h3>选择商品</h3>
        <button data-action="close-modal" class="icon-btn">✕</button>
      </div>
      <input class="modal-search" placeholder="搜索商品名称" id="picker-search" value="${esc(filter)}" />
      <div class="picker-list">
        ${
          list.length
            ? list
                .map(
                  (p) => `
          <div class="picker-item" data-action="picker-pick" data-id="${p.id}">
            <div class="item-name">${esc(p.name)}</div>
            <div class="item-sub">${esc(describeTiers(p, state.settings.currencies, state.settings.baseCurrency))}</div>
          </div>`
                )
                .join("")
            : `<div class="empty-hint">${
                state.products.length ? "没有匹配的商品" : "还没有商品，先去「价目表」新增"
              }</div>`
        }
      </div>
    `;
  };
  openModal(render());
  const searchInput = document.getElementById("picker-search");
  searchInput.focus();
  searchInput.addEventListener("input", (e) => {
    const html = render(e.target.value);
    modalCard.innerHTML = html;
    document.getElementById("picker-search").focus();
    document.getElementById("picker-search").selectionStart = e.target.value.length;
    bindPickerClicks();
  });
  bindPickerClicks();

  function bindPickerClicks() {
    modalCard.querySelectorAll('[data-action="picker-pick"]').forEach((el) => {
      el.addEventListener("click", () => {
        addProductToQuote(el.dataset.id);
        closeModal();
      });
    });
  }
}

function addProductToQuote(productId) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  const q = state.currentQuote;
  const existing = q.items.find((it) => it.productId === productId);
  if (existing) {
    existing.qty += 1;
  } else {
    q.items.push({
      productId,
      name: product.name,
      unit: product.unit,
      qty: 1,
      unitPrice: 0,
      subtotal: 0,
    });
  }
  renderQuoteTab();
}

// ================= PRODUCTS TAB =================
function renderProductsTab() {
  const list = state.products;
  appContent.innerHTML = `
    <section class="panel">
      <div class="panel-title-row">
        <div class="panel-title">商品价目表</div>
        <button class="btn btn-primary small" data-action="product-new">＋ 新增商品</button>
      </div>
      <div class="product-list">
        ${
          list.length
            ? list
                .map(
                  (p) => `
          <div class="product-card">
            <div class="product-card-main">
              <div class="item-name">${esc(p.name)}</div>
              <div class="item-sub">${esc(
                describeTiers(p, state.settings.currencies, state.settings.baseCurrency)
              )}</div>
              ${p.sku ? `<div class="item-sub muted">SKU: ${esc(p.sku)}</div>` : ""}
            </div>
            <div class="product-card-actions">
              <button class="icon-btn" data-action="product-edit" data-id="${p.id}">编辑</button>
              <button class="icon-btn danger" data-action="product-delete" data-id="${p.id}">删除</button>
            </div>
          </div>`
                )
                .join("")
            : `<div class="empty-hint">还没有商品，点击右上角新增</div>`
        }
      </div>
    </section>
  `;

  appContent.querySelector('[data-action="product-new"]').addEventListener("click", () => openProductForm());
  appContent.querySelectorAll('[data-action="product-edit"]').forEach((btn) =>
    btn.addEventListener("click", () =>
      openProductForm(state.products.find((p) => p.id === btn.dataset.id))
    )
  );
  appContent.querySelectorAll('[data-action="product-delete"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("确认删除该商品？")) {
        db.deleteProduct(btn.dataset.id);
        state.products = db.getProducts();
        renderProductsTab();
        toast("已删除");
      }
    })
  );
}

function openProductForm(product) {
  let tierRows = product?.tiers?.length ? product.tiers.map((t) => ({ ...t })) : [{ minQty: 1, price: 0 }];

  function tiersHtml() {
    return tierRows
      .map(
        (t, i) => `
      <div class="tier-row">
        <span class="tier-label">数量 ≥</span>
        <input type="number" min="1" value="${t.minQty}" data-tier="minQty" data-row="${i}" />
        <span class="tier-label">单价</span>
        <input type="number" min="0" step="0.01" value="${t.price}" data-tier="price" data-row="${i}" />
        <button class="icon-btn danger" data-action="tier-remove" data-row="${i}" ${
          tierRows.length <= 1 ? "disabled" : ""
        }>✕</button>
      </div>`
      )
      .join("");
  }

  function formHtml() {
    return `
      <div class="modal-header">
        <h3>${product ? "编辑商品" : "新增商品"}</h3>
        <button data-action="close-modal" class="icon-btn">✕</button>
      </div>
      <div class="form-body">
        <label>商品名称 *</label>
        <input id="f-name" value="${esc(product?.name || "")}" placeholder="例如：便携香薰机" />
        <div class="field-row two">
          <div>
            <label>单位</label>
            <input id="f-unit" value="${esc(product?.unit || "件")}" placeholder="件 / 箱 / 套" />
          </div>
          <div>
            <label>SKU（可选）</label>
            <input id="f-sku" value="${esc(product?.sku || "")}" placeholder="内部编码" />
          </div>
        </div>
        <label>阶梯价（以基准币种 ${esc(state.settings.baseCurrency)} 填写）</label>
        <div id="tier-rows">${tiersHtml()}</div>
        <button class="btn btn-outline small" data-action="tier-add">＋ 加一档</button>
        <label>备注（可选）</label>
        <textarea id="f-note" placeholder="供货说明等">${esc(product?.note || "")}</textarea>
        <button class="btn btn-primary full" data-action="product-save">保存商品</button>
      </div>
    `;
  }

  openModal(formHtml());
  bindFormEvents();

  function bindFormEvents() {
    modalCard.querySelectorAll("[data-tier]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const row = +e.target.dataset.row;
        const field = e.target.dataset.tier;
        tierRows[row][field] = field === "minQty" ? parseInt(e.target.value, 10) || 0 : parseFloat(e.target.value) || 0;
      });
    });
    modalCard.querySelectorAll('[data-action="tier-remove"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        tierRows.splice(+btn.dataset.row, 1);
        refreshTiers();
      })
    );
    const addBtn = modalCard.querySelector('[data-action="tier-add"]');
    if (addBtn)
      addBtn.addEventListener("click", () => {
        tierRows.push({ minQty: 1, price: 0 });
        refreshTiers();
      });
    modalCard.querySelector('[data-action="product-save"]').addEventListener("click", () => {
      const name = modalCard.querySelector("#f-name").value.trim();
      if (!name) {
        toast("请填写商品名称");
        return;
      }
      const cleanTiers = tierRows
        .filter((t) => t.minQty > 0)
        .sort((a, b) => a.minQty - b.minQty);
      if (!cleanTiers.length) {
        toast("至少需要一档价格");
        return;
      }
      const saved = db.saveProduct({
        id: product?.id,
        name,
        unit: modalCard.querySelector("#f-unit").value.trim() || "件",
        sku: modalCard.querySelector("#f-sku").value.trim(),
        note: modalCard.querySelector("#f-note").value.trim(),
        tiers: cleanTiers,
      });
      state.products = db.getProducts();
      closeModal();
      renderProductsTab();
      toast(product ? "已更新" : "已新增");
    });
  }

  function refreshTiers() {
    const el = modalCard.querySelector("#tier-rows");
    el.innerHTML = tiersHtml();
    modalCard.querySelectorAll("[data-tier]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const row = +e.target.dataset.row;
        const field = e.target.dataset.tier;
        tierRows[row][field] = field === "minQty" ? parseInt(e.target.value, 10) || 0 : parseFloat(e.target.value) || 0;
      });
    });
    modalCard.querySelectorAll('[data-action="tier-remove"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        tierRows.splice(+btn.dataset.row, 1);
        refreshTiers();
      })
    );
  }
}

// ================= HISTORY TAB =================
function renderHistoryTab() {
  const list = state.quotes;
  appContent.innerHTML = `
    <section class="panel">
      <div class="panel-title">历史报价单</div>
      <div class="history-list">
        ${
          list.length
            ? list
                .map((q) => {
                  const dateStr = new Date(q.createdAt).toLocaleString("zh-CN", {
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  return `
          <div class="history-card">
            <div class="history-main" data-action="history-open" data-id="${q.id}">
              <div class="item-name">${esc(q.customer.company || q.customer.name || "未命名客户")}</div>
              <div class="item-sub">${q.number ? esc(q.number) + " · " : ""}${dateStr} · ${esc(q.items.length)} 项商品</div>
            </div>
            <div class="history-amount">${formatMoney(q.total, q.currencies || state.settings.currencies, q.currency)}</div>
            ${
              q.number
                ? `<button class="icon-btn" title="生成修订版" data-action="history-revise" data-id="${q.id}">R+</button>`
                : `<button class="icon-btn" title="重新获取编号" data-action="history-get-number" data-id="${q.id}">编号</button>`
            }
            <button class="icon-btn danger" data-action="history-delete" data-id="${q.id}">✕</button>
          </div>`;
                })
                .join("")
            : `<div class="empty-hint">还没有保存过报价单</div>`
        }
      </div>
    </section>
  `;

  appContent.querySelectorAll('[data-action="history-open"]').forEach((el) =>
    el.addEventListener("click", () => {
      const q = state.quotes.find((x) => x.id === el.dataset.id);
      state.currentQuote = JSON.parse(JSON.stringify(q));
      state.editingQuoteId = q.id;
      persistDraft();
      switchTab("quote");
    })
  );
  appContent.querySelectorAll('[data-action="history-delete"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      if (confirm("确认删除该历史报价单？")) {
        db.deleteQuote(btn.dataset.id);
        state.quotes = db.getQuotes();
        renderHistoryTab();
        toast("已删除");
      }
    })
  );
  appContent.querySelectorAll('[data-action="history-get-number"]').forEach((btn) =>
    btn.addEventListener("click", async () => {
      const q = state.quotes.find((x) => x.id === btn.dataset.id);
      if (!q) return;
      await ensureQuoteNumber(q);
      if (q.number) {
        db.saveQuote(q);
        state.quotes = db.getQuotes();
        renderHistoryTab();
        toast("已获取编号 " + q.number);
      }
    })
  );
  appContent.querySelectorAll('[data-action="history-revise"]').forEach((btn) =>
    btn.addEventListener("click", async () => {
      const q = state.quotes.find((x) => x.id === btn.dataset.id);
      if (!q || !q.baseNumber) return;
      try {
        q.number = await requestRevisionNumber(q.baseNumber);
        db.saveQuote(q);
        state.quotes = db.getQuotes();
        renderHistoryTab();
        toast("已生成修订版 " + q.number);
      } catch (err) {
        console.error(err);
        toast("生成修订版失败，请检查网络");
      }
    })
  );
}

// ================= SETTINGS TAB =================
function renderSettingsTab() {
  const s = state.settings;
  appContent.innerHTML = `
    <section class="panel">
      <div class="panel-title">公司信息（显示在 PDF 上）</div>
      <label>公司 / 门店名称</label>
      <input id="s-company" value="${esc(s.companyName)}" />
      <label>联系方式</label>
      <input id="s-contact" value="${esc(s.companyContact)}" />
      <label>报价单编号主体</label>
      <select id="s-entity">
        <option value="LB" ${s.entity === "LB" ? "selected" : ""}>LB</option>
        <option value="NC" ${s.entity === "NC" ? "selected" : ""}>NC</option>
      </select>
      <p class="hint-text">决定生成的正式编号前缀（如 LB-QT2608001），保存/导出报价单时自动向服务器申请。</p>
    </section>

    <section class="panel">
      <div class="panel-title-row">
        <div class="panel-title">币种管理</div>
        <button class="btn btn-outline small" data-action="currency-add">＋ 添加币种</button>
      </div>
      <div class="currency-list">
        ${s.currencies
          .map(
            (c) => `
          <div class="currency-row">
            <div class="currency-code">${esc(c.code)} ${esc(c.symbol)} ${
              c.code === s.baseCurrency ? '<span class="badge">基准</span>' : ""
            }</div>
            <div class="currency-rate">
              ${
                c.code === s.baseCurrency
                  ? `<span class="muted">1（基准）</span>`
                  : `<input type="number" step="0.0001" min="0" value="${c.rate}" data-action="currency-rate" data-code="${c.code}" />`
              }
            </div>
            ${
              c.code === s.baseCurrency
                ? ""
                : `<button class="icon-btn danger" data-action="currency-delete" data-code="${c.code}">✕</button>`
            }
          </div>`
          )
          .join("")}
      </div>
      <p class="hint-text">汇率含义：1 基准币种 = 该数值 × 目标币种。商品价目表中的价格以基准币种（${esc(
        s.baseCurrency
      )}）填写，修改基准币种不会自动换算已录入的商品价格。</p>
    </section>

    <section class="panel">
      <div class="panel-title">数据备份</div>
      <div class="field-row two">
        <button class="btn btn-outline" data-action="export-all">导出全部数据</button>
        <button class="btn btn-outline" data-action="import-all">导入数据</button>
      </div>
      <input type="file" id="import-file" accept="application/json" style="display:none" />
      <p class="hint-text">导出为 JSON 文件，可用于在展会现场换设备、或防止清除浏览器缓存导致数据丢失。导入会覆盖当前商品、报价单与设置。</p>
    </section>
  `;

  document.getElementById("s-company").addEventListener("change", (e) => {
    state.settings = db.saveSettings({ ...state.settings, companyName: e.target.value });
  });
  document.getElementById("s-contact").addEventListener("change", (e) => {
    state.settings = db.saveSettings({ ...state.settings, companyContact: e.target.value });
  });
  document.getElementById("s-entity").addEventListener("change", (e) => {
    state.settings = db.saveSettings({ ...state.settings, entity: e.target.value });
  });

  appContent.querySelectorAll('[data-action="currency-rate"]').forEach((input) =>
    input.addEventListener("change", (e) => {
      const code = e.target.dataset.code;
      const rate = parseFloat(e.target.value) || 0;
      const currencies = state.settings.currencies.map((c) => (c.code === code ? { ...c, rate } : c));
      state.settings = db.saveSettings({ ...state.settings, currencies });
    })
  );
  appContent.querySelectorAll('[data-action="currency-delete"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      const currencies = state.settings.currencies.filter((c) => c.code !== btn.dataset.code);
      state.settings = db.saveSettings({ ...state.settings, currencies });
      renderSettingsTab();
    })
  );
  appContent.querySelector('[data-action="currency-add"]').addEventListener("click", openCurrencyForm);
  appContent.querySelector('[data-action="export-all"]').addEventListener("click", exportAllData);
  appContent.querySelector('[data-action="import-all"]').addEventListener("click", () => {
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", handleImportFile);
}

function openCurrencyForm() {
  openModal(`
    <div class="modal-header">
      <h3>添加币种</h3>
      <button data-action="close-modal" class="icon-btn">✕</button>
    </div>
    <div class="form-body">
      <label>币种代码（如 USD）</label>
      <input id="c-code" maxlength="6" placeholder="USD" />
      <label>符号（如 $）</label>
      <input id="c-symbol" maxlength="4" placeholder="$" />
      <label>汇率（1 ${esc(state.settings.baseCurrency)} = ? 该币种）</label>
      <input id="c-rate" type="number" step="0.0001" min="0" placeholder="0.14" />
      <button class="btn btn-primary full" data-action="currency-save">保存</button>
    </div>
  `);
  modalCard.querySelector('[data-action="currency-save"]').addEventListener("click", () => {
    const code = modalCard.querySelector("#c-code").value.trim().toUpperCase();
    const symbol = modalCard.querySelector("#c-symbol").value.trim();
    const rate = parseFloat(modalCard.querySelector("#c-rate").value) || 0;
    if (!code || !symbol || rate <= 0) {
      toast("请完整填写币种信息");
      return;
    }
    if (state.settings.currencies.some((c) => c.code === code)) {
      toast("该币种已存在");
      return;
    }
    const currencies = [...state.settings.currencies, { code, symbol, rate }];
    state.settings = db.saveSettings({ ...state.settings, currencies });
    closeModal();
    renderSettingsTab();
    toast("已添加");
  });
}

function exportAllData() {
  const data = db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `报价数据备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!confirm("导入将覆盖当前所有商品、报价单与设置，确认继续？")) return;
      db.importAll(data);
      state.settings = db.getSettings();
      state.products = db.getProducts();
      state.quotes = db.getQuotes();
      renderSettingsTab();
      toast("导入成功");
    } catch (err) {
      toast("文件格式不正确");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
}

// ================= global click delegation =================
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case "close-modal":
      closeModal();
      break;
    case "open-picker":
      openProductPicker();
      break;
    case "qty-inc": {
      const i = +el.dataset.index;
      state.currentQuote.items[i].qty += 1;
      renderQuoteTab();
      break;
    }
    case "qty-dec": {
      const i = +el.dataset.index;
      const item = state.currentQuote.items[i];
      if (item.qty > 1) item.qty -= 1;
      renderQuoteTab();
      break;
    }
    case "item-remove": {
      const i = +el.dataset.index;
      state.currentQuote.items.splice(i, 1);
      renderQuoteTab();
      break;
    }
    case "quote-new": {
      if (state.currentQuote.items.length && !confirm("放弃当前未保存的更改并新建？")) return;
      state.currentQuote = emptyQuote(state.settings.baseCurrency);
      state.editingQuoteId = null;
      db.clearDraft();
      renderQuoteTab();
      break;
    }
    case "quote-save": {
      const q = state.currentQuote;
      if (!q.items.length) {
        toast("请先添加商品");
        return;
      }
      await ensureQuoteNumber(q);
      const saved = db.saveQuote({ ...q, id: state.editingQuoteId });
      state.editingQuoteId = saved.id;
      state.currentQuote.id = saved.id;
      state.currentQuote.createdAt = saved.createdAt;
      state.quotes = db.getQuotes();
      persistDraft();
      toast("报价单已保存");
      renderQuoteTab();
      break;
    }
    case "quote-export": {
      const q = state.currentQuote;
      if (!q.items.length) {
        toast("请先添加商品");
        return;
      }
      await ensureQuoteNumber(q);
      if (!q.id) {
        const saved = db.saveQuote({ ...q });
        state.editingQuoteId = saved.id;
        state.currentQuote.id = saved.id;
        state.currentQuote.createdAt = saved.createdAt;
        state.quotes = db.getQuotes();
        persistDraft();
      } else {
        db.saveQuote({ ...q, id: state.editingQuoteId });
        state.quotes = db.getQuotes();
      }
      renderQuoteTab();
      exportQuotePdf(state.currentQuote, state.settings)
        .then(() => toast("PDF 已导出"))
        .catch((err) => {
          console.error(err);
          toast("导出失败，请重试");
        });
      break;
    }
  }
});

// ---------------- tab bar wiring ----------------
document.querySelectorAll(".tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ---------------- online status ----------------
function updateOnlineStatus() {
  const el = document.getElementById("online-status");
  el.textContent = navigator.onLine ? "在线" : "离线可用";
}
window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);
updateOnlineStatus();

// ---------------- service worker ----------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.error("SW registration failed", err);
    });
  });
}

render();
