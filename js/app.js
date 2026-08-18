import { db } from "./db.js";
import { tierPrice, convert, formatMoney, describeTiers, skuLabel, describeItemSpec } from "./pricing.js";
import { exportQuotePdf, buildQuoteHtml } from "./pdf.js";
import { requestQuoteNumber, requestRevisionNumber } from "./numbering.js";
import { recognizeCardText, parseCardText } from "./ocr.js";
import { exportQuoteExcel, downloadProductTemplate, parseProductExcelFile } from "./excel.js";
import {
  putImage,
  getImageURL,
  resolveImageURLs,
  deleteImage,
  getStorageEstimate,
  enforceProductImageLRU,
  getPendingImages,
} from "./imagestore.js";
import { syncPendingImages } from "./sync.js";

const INCOTERM_OPTIONS = ["EXW", "FOB", "DDP", "CIF", "含税含运费", "裸价"];

function emptyQuote(baseCurrency) {
  return {
    id: null,
    number: null,
    baseNumber: null,
    docType: "QT",
    incoterm: "",
    customer: {
      name: "",
      company: "",
      contact: "",
      phone: "",
      email: "",
      address: "",
      website: "",
      cardImageId: null,
      cardText: null,
    },
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
    const number = await requestQuoteNumber(state.settings.entity || "LB", quote.docType || "QT");
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
  historyFilter: "QT",
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
async function renderQuoteTab() {
  const q = state.currentQuote;
  recomputeQuote();
  const cardImageUrl = q.customer.cardImageId ? await getImageURL(q.customer.cardImageId) : null;
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
          ${describeItemSpec(it) ? `<div class="item-sub muted">${esc(describeItemSpec(it))}</div>` : ""}
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
      <div class="doctype-toggle">
        <button type="button" class="${q.docType !== "EQ" ? "active" : ""}" data-action="doctype-set" data-type="QT" ${q.number ? "disabled" : ""}>报价 Quotation</button>
        <button type="button" class="${q.docType === "EQ" ? "active" : ""}" data-action="doctype-set" data-type="EQ" ${q.number ? "disabled" : ""}>询价 Enquiry</button>
      </div>
      <div class="field-row two">
        <div>
          <label>币种</label>
          <select data-action="currency-change">${currencyOptions}</select>
        </div>
        <div>
          <label>贸易术语 Incoterms</label>
          <select data-action="incoterm-change">
            <option value="">不指定</option>
            ${INCOTERM_OPTIONS.map(
              (t) => `<option value="${t}" ${q.incoterm === t ? "selected" : ""}>${t}</option>`
            ).join("")}
          </select>
        </div>
      </div>
      <div class="field-row two">
        <input placeholder="客户 / 公司名称" value="${esc(q.customer.company)}" data-action="cust-company" />
        <input placeholder="联系人" value="${esc(q.customer.name)}" data-action="cust-name" />
      </div>
      <div class="field-row two">
        <input placeholder="手机" value="${esc(q.customer.phone || "")}" data-action="cust-phone" />
        <input placeholder="邮箱" value="${esc(q.customer.email || "")}" data-action="cust-email" />
      </div>
      <div class="field-row">
        <input placeholder="地址" value="${esc(q.customer.address || "")}" data-action="cust-address" />
      </div>
      <div class="field-row two">
        <input placeholder="网址" value="${esc(q.customer.website || "")}" data-action="cust-website" />
        <input placeholder="微信 / 其他联系方式" value="${esc(q.customer.contact)}" data-action="cust-contact" />
      </div>
      <div class="photo-field">
        ${
          cardImageUrl
            ? `<img class="photo-preview clickable" src="${cardImageUrl}" data-action="card-photo-view" />`
            : `<div class="photo-preview empty">名片</div>`
        }
        <div class="photo-field-actions">
          <button type="button" class="btn btn-outline small" data-action="card-scan">${
            cardImageUrl ? "重新拍摄识别" : "拍摄名片自动识别"
          }</button>
          ${
            cardImageUrl
              ? `<button type="button" class="icon-btn danger" data-action="card-clear">删除名片</button>`
              : ""
          }
          ${
            q.customer.cardText
              ? `<button type="button" class="icon-btn" data-action="card-text-view">查看识别原文</button>`
              : ""
          }
        </div>
        <input type="file" id="card-photo-input" accept="image/*" style="display:none" />
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
        <button class="btn btn-primary" data-action="quote-export">预览 / 导出</button>
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
  appContent.querySelector('[data-action="incoterm-change"]').addEventListener("change", (e) => {
    state.currentQuote.incoterm = e.target.value;
    persistDraft();
  });
  appContent.querySelectorAll('[data-action="doctype-set"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      state.currentQuote.docType = btn.dataset.type;
      persistDraft();
      renderQuoteTab();
    })
  );
  bindTextInput("cust-company", (v) => (state.currentQuote.customer.company = v));
  bindTextInput("cust-name", (v) => (state.currentQuote.customer.name = v));
  bindTextInput("cust-contact", (v) => (state.currentQuote.customer.contact = v));
  bindTextInput("cust-phone", (v) => (state.currentQuote.customer.phone = v));
  bindTextInput("cust-email", (v) => (state.currentQuote.customer.email = v));
  bindTextInput("cust-address", (v) => (state.currentQuote.customer.address = v));
  bindTextInput("cust-website", (v) => (state.currentQuote.customer.website = v));

  const cardInput = appContent.querySelector("#card-photo-input");
  appContent.querySelector('[data-action="card-scan"]').addEventListener("click", () => cardInput.click());
  appContent.querySelector('[data-action="card-photo-view"]')?.addEventListener("click", () => {
    openImageViewer(cardImageUrl);
  });
  appContent.querySelector('[data-action="card-text-view"]')?.addEventListener("click", () => {
    openModal(`
      <div class="modal-header">
        <h3>识别原文</h3>
        <button data-action="close-modal" class="icon-btn">✕</button>
      </div>
      <p class="hint-text" style="margin-top:0">OCR 逐行原始结果，供核对/手动补填参考：</p>
      <pre class="ocr-raw-text">${esc(state.currentQuote.customer.cardText || "")}</pre>
    `);
  });
  appContent.querySelector('[data-action="card-clear"]')?.addEventListener("click", async () => {
    if (state.currentQuote.customer.cardImageId) await deleteImage(state.currentQuote.customer.cardImageId);
    state.currentQuote.customer.cardImageId = null;
    state.currentQuote.customer.cardText = null;
    persistDraft();
    renderQuoteTab();
  });
  cardInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const scanBtn = appContent.querySelector('[data-action="card-scan"]');
    scanBtn.disabled = true;
    scanBtn.textContent = "识别中…";
    try {
      const cardDataUrl = await compressImageFile(file, 1000, 0.75);
      if (state.currentQuote.customer.cardImageId) await deleteImage(state.currentQuote.customer.cardImageId);
      state.currentQuote.customer.cardImageId = await putImage(cardDataUrl, {
        kind: "card",
        ownerId: state.currentQuote.id,
      });
      const text = await recognizeCardText(file);
      state.currentQuote.customer.cardText = text;
      const fields = parseCardText(text);
      const c = state.currentQuote.customer;
      if (!c.company && fields.company) c.company = fields.company;
      if (!c.name && fields.name) c.name = fields.name;
      if (!c.phone && fields.phone) c.phone = fields.phone;
      if (!c.email && fields.email) c.email = fields.email;
      if (!c.address && fields.address) c.address = fields.address;
      if (!c.website && fields.website) c.website = fields.website;
      persistDraft();
      renderQuoteTab();
      toast("名片识别完成，请核对信息是否准确");
    } catch (err) {
      console.error(err);
      persistDraft();
      renderQuoteTab();
      openModal(`
        <div class="modal-header">
          <h3>识别失败</h3>
          <button data-action="close-modal" class="icon-btn">✕</button>
        </div>
        <p class="hint-text" style="margin-top:0">名片照片已保存，可手动填写信息。具体报错（方便反馈）：</p>
        <pre class="ocr-raw-text">${esc(err?.stack || err?.message || String(err))}</pre>
      `);
    }
  });

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

async function openProductPicker() {
  const imageMap = await resolveImageURLs(state.products.map((p) => p.imageId));
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
            ${
              imageMap.get(p.imageId)
                ? `<img class="product-thumb" src="${imageMap.get(p.imageId)}" />`
                : `<div class="product-thumb empty"></div>`
            }
            <div class="item-main">
              <div class="item-name">${esc(p.name)}</div>
              <div class="item-sub">${esc(describeTiers(p, state.settings.currencies, state.settings.baseCurrency))}</div>
              ${p.skuOptions?.length ? `<div class="item-sub muted">${p.skuOptions.length} 种规格，选择后可指定</div>` : ""}
            </div>
          </div>`
                )
                .join("")
            : `<div class="empty-hint">${
                state.products.length ? "没有匹配的商品" : "还没有商品，先去「商品表」新增"
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
        const product = state.products.find((p) => p.id === el.dataset.id);
        if (product?.skuOptions?.length) {
          openSkuPicker(product);
        } else {
          addProductToQuote(product.id);
          closeModal();
        }
      });
    });
  }
}

async function openQuotePreview() {
  const html = await buildQuoteHtml(state.currentQuote, state.settings, state.products);
  openModal(`
    <div class="modal-header">
      <h3>预览</h3>
      <button data-action="close-modal" class="icon-btn">✕</button>
    </div>
    <div class="pdf-preview-wrap">${html}</div>
    <div class="field-row two">
      <button class="btn btn-outline" data-action="preview-export-excel">导出 Excel</button>
      <button class="btn btn-primary" data-action="preview-confirm-export">确认导出 PDF</button>
    </div>
  `);
  const wrap = modalCard.querySelector(".pdf-preview-wrap");
  const page = wrap.querySelector(".pdf-page");
  requestAnimationFrame(() => {
    const scale = wrap.clientWidth / page.offsetWidth;
    page.style.transform = `scale(${scale})`;
    wrap.style.height = `${page.offsetHeight * scale}px`;
  });
  modalCard.querySelector('[data-action="preview-confirm-export"]').addEventListener("click", () => {
    closeModal();
    exportQuotePdf(state.currentQuote, state.settings, state.products)
      .then(() => toast("PDF 已导出"))
      .catch((err) => {
        console.error(err);
        toast("导出失败，请重试");
      });
  });
  modalCard.querySelector('[data-action="preview-export-excel"]').addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      await exportQuoteExcel(state.currentQuote, state.settings, state.products);
      toast("Excel 已导出");
    } catch (err) {
      console.error(err);
      toast("导出失败，请重试");
    } finally {
      btn.disabled = false;
      btn.textContent = "导出 Excel";
    }
  });
}

function openImageViewer(url) {
  if (!url) return;
  openModal(`
    <div class="modal-header">
      <h3>查看图片</h3>
      <button data-action="close-modal" class="icon-btn">✕</button>
    </div>
    <img class="image-viewer-full" src="${url}" />
  `);
}

function openSkuPicker(product) {
  openModal(`
    <div class="modal-header">
      <h3>选择规格 · ${esc(product.name)}</h3>
      <button data-action="close-modal" class="icon-btn">✕</button>
    </div>
    ${product.formula ? `<p class="hint-text" style="margin-top:0">成分/配方：${esc(product.formula)}</p>` : ""}
    <div class="picker-list">
      ${product.skuOptions
        .map(
          (s, i) => `
        <div class="picker-item" data-action="sku-pick" data-index="${i}">
          <div class="item-main">
            <div class="item-name">${esc(skuLabel(s) || `规格 ${i + 1}`)}</div>
          </div>
        </div>`
        )
        .join("")}
    </div>
  `);
  modalCard.querySelectorAll('[data-action="sku-pick"]').forEach((el) => {
    el.addEventListener("click", () => {
      addProductToQuote(product.id, product.skuOptions[+el.dataset.index]);
      closeModal();
    });
  });
}

function addProductToQuote(productId, sku) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;
  const q = state.currentQuote;
  const skuKey = sku ? skuLabel(sku) : null;
  const existing = q.items.find((it) => it.productId === productId && skuLabel(it.sku) === (skuKey || ""));
  if (existing) {
    existing.qty += 1;
  } else {
    q.items.push({
      productId,
      name: product.name,
      unit: product.unit,
      formula: product.formula || "",
      sku: sku || null,
      qty: 1,
      unitPrice: 0,
      subtotal: 0,
    });
  }
  renderQuoteTab();
}

// ================= PRODUCTS TAB =================
async function renderProductsTab() {
  const list = state.products;
  const imageMap = await resolveImageURLs(list.map((p) => p.imageId));
  appContent.innerHTML = `
    <section class="panel">
      <div class="panel-title-row">
        <div class="panel-title">商品表</div>
        <button class="btn btn-primary small" data-action="product-new">＋ 新增商品</button>
      </div>
      <div class="field-row two">
        <button class="btn btn-outline small" data-action="product-template">下载导入模板</button>
        <button class="btn btn-outline small" data-action="product-import">导入 Excel</button>
      </div>
      <input type="file" id="product-import-input" accept=".xlsx,.xls,.csv" style="display:none" />
      <div class="product-list">
        ${
          list.length
            ? list
                .map(
                  (p) => `
          <div class="product-card">
            ${
              imageMap.get(p.imageId)
                ? `<img class="product-thumb clickable" src="${imageMap.get(p.imageId)}" data-action="product-photo-view" data-url="${imageMap.get(p.imageId)}" />`
                : `<div class="product-thumb empty"></div>`
            }
            <div class="product-card-main">
              <div class="item-name">${esc(p.name)}</div>
              <div class="item-sub">${esc(
                describeTiers(p, state.settings.currencies, state.settings.baseCurrency)
              )}</div>
              ${p.sku ? `<div class="item-sub muted">编码: ${esc(p.sku)}</div>` : ""}
              ${p.formula ? `<div class="item-sub muted">配方: ${esc(p.formula)}</div>` : ""}
              ${p.skuOptions?.length ? `<div class="item-sub muted">${p.skuOptions.length} 种规格</div>` : ""}
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
  appContent.querySelectorAll('[data-action="product-photo-view"]').forEach((img) =>
    img.addEventListener("click", () => openImageViewer(img.dataset.url))
  );
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

  appContent.querySelector('[data-action="product-template"]').addEventListener("click", async () => {
    try {
      await downloadProductTemplate();
    } catch (err) {
      console.error(err);
      toast("模板下载失败，请重试");
    }
  });
  const importInput = appContent.querySelector("#product-import-input");
  const importBtn = appContent.querySelector('[data-action="product-import"]');
  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    importBtn.disabled = true;
    importBtn.textContent = "导入中…";
    try {
      const { products, skipped } = await parseProductExcelFile(file);
      let created = 0;
      let updated = 0;
      for (const p of products) {
        const existing = state.products.find((x) => x.name === p.name);
        db.saveProduct(existing ? { ...p, id: existing.id, imageId: existing.imageId } : p);
        if (existing) updated++;
        else created++;
      }
      state.products = db.getProducts();
      renderProductsTab();
      toast(`导入完成：新增 ${created} 个，更新 ${updated} 个${skipped ? `，跳过 ${skipped} 行（缺名称/单价）` : ""}`);
    } catch (err) {
      console.error(err);
      toast("导入失败，请检查文件格式");
      importBtn.disabled = false;
      importBtn.textContent = "导入 Excel";
    } finally {
      importInput.value = "";
    }
  });
}

// 拍照/选图后压缩到合理体积再存 localStorage（原图直接存会很快把配额吃满）。
function compressImageFile(file, maxDim = 640, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function openProductForm(product) {
  let tierRows = product?.tiers?.length ? product.tiers.map((t) => ({ ...t })) : [{ minQty: 1, price: 0 }];
  let skuRows = product?.skuOptions?.length ? product.skuOptions.map((s) => ({ ...s })) : [];
  const existingImageId = product?.imageId || null;
  let photoPreviewUrl = existingImageId ? await getImageURL(existingImageId) : null;
  let newPhotoDataUrl = null;
  let photoCleared = false;

  function photoHtml() {
    return `
      <div class="photo-field">
        ${
          photoPreviewUrl
            ? `<img class="photo-preview" src="${photoPreviewUrl}" />`
            : `<div class="photo-preview empty">无图</div>`
        }
        <div class="photo-field-actions">
          <button type="button" class="btn btn-outline small" data-action="photo-pick">${
            photoPreviewUrl ? "更换照片" : "拍照 / 选图"
          }</button>
          ${photoPreviewUrl ? `<button type="button" class="icon-btn danger" data-action="photo-clear">删除</button>` : ""}
        </div>
      </div>
      <input type="file" id="f-photo-input" accept="image/*" style="display:none" />
    `;
  }

  function skuRowsHtml() {
    if (!skuRows.length) {
      return `<div class="empty-hint" style="padding:10px 4px">未设置 SKU 选项，报价时按商品直接下单</div>`;
    }
    return skuRows
      .map(
        (s, i) => `
      <div class="sku-option-card">
        <div class="sku-option-card-header">
          <span>规格 ${i + 1}</span>
          <button type="button" class="icon-btn danger" data-action="sku-remove" data-row="${i}">✕</button>
        </div>
        <div class="sku-option-grid">
          <input placeholder="颜色" value="${esc(s.color || "")}" data-sku="color" data-row="${i}" />
          <input placeholder="克重/容量" value="${esc(s.weight || "")}" data-sku="weight" data-row="${i}" />
          <input type="number" min="1" placeholder="MOQ" value="${esc(s.moq || "")}" data-sku="moq" data-row="${i}" />
        </div>
      </div>`
      )
      .join("");
  }

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
        <label>商品照片（可选）</label>
        <div id="photo-area">${photoHtml()}</div>
        <div class="field-row two">
          <div>
            <label>单位</label>
            <input id="f-unit" value="${esc(product?.unit || "件")}" placeholder="件 / 箱 / 套" />
          </div>
          <div>
            <label>商品编码（可选）</label>
            <input id="f-sku" value="${esc(product?.sku || "")}" placeholder="内部编码" />
          </div>
        </div>
        <label>成分/配方（可选，同一商品各规格通用）</label>
        <input id="f-formula" value="${esc(product?.formula || "")}" placeholder="例如：无硅油配方" />
        <label>阶梯价（以基准币种 ${esc(state.settings.baseCurrency)} 填写）</label>
        <div id="tier-rows">${tiersHtml()}</div>
        <button class="btn btn-outline small" data-action="tier-add">＋ 加一档</button>
        <label>SKU 选项（可选，比如颜色 / 克重容量 / MOQ 不同的规格）</label>
        <div id="sku-rows">${skuRowsHtml()}</div>
        <button class="btn btn-outline small" data-action="sku-add">＋ 添加规格</button>
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

    modalCard.querySelectorAll("[data-sku]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const row = +e.target.dataset.row;
        const field = e.target.dataset.sku;
        skuRows[row][field] = e.target.value;
      });
    });
    modalCard.querySelectorAll('[data-action="sku-remove"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        skuRows.splice(+btn.dataset.row, 1);
        refreshSku();
      })
    );
    const skuAddBtn = modalCard.querySelector('[data-action="sku-add"]');
    if (skuAddBtn)
      skuAddBtn.addEventListener("click", () => {
        skuRows.push({ color: "", weight: "", moq: "" });
        refreshSku();
      });

    bindPhotoEvents();

    modalCard.querySelector('[data-action="product-save"]').addEventListener("click", async () => {
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
      const cleanSku = skuRows.filter((s) => s.color || s.weight || s.moq);

      let finalImageId = existingImageId;
      if (photoCleared) {
        if (existingImageId) await deleteImage(existingImageId);
        finalImageId = null;
      } else if (newPhotoDataUrl) {
        if (existingImageId) await deleteImage(existingImageId);
        finalImageId = await putImage(newPhotoDataUrl, { kind: "product", ownerId: product?.id || null });
      }

      const saved = db.saveProduct({
        id: product?.id,
        name,
        imageId: finalImageId,
        unit: modalCard.querySelector("#f-unit").value.trim() || "件",
        sku: modalCard.querySelector("#f-sku").value.trim(),
        formula: modalCard.querySelector("#f-formula").value.trim(),
        note: modalCard.querySelector("#f-note").value.trim(),
        tiers: cleanTiers,
        skuOptions: cleanSku,
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

  function refreshSku() {
    const el = modalCard.querySelector("#sku-rows");
    el.innerHTML = skuRowsHtml();
    modalCard.querySelectorAll("[data-sku]").forEach((input) => {
      input.addEventListener("input", (e) => {
        const row = +e.target.dataset.row;
        const field = e.target.dataset.sku;
        skuRows[row][field] = e.target.value;
      });
    });
    modalCard.querySelectorAll('[data-action="sku-remove"]').forEach((btn) =>
      btn.addEventListener("click", () => {
        skuRows.splice(+btn.dataset.row, 1);
        refreshSku();
      })
    );
  }

  function refreshPhoto() {
    const el = modalCard.querySelector("#photo-area");
    el.innerHTML = photoHtml();
    bindPhotoEvents();
  }

  function bindPhotoEvents() {
    const fileInput = modalCard.querySelector("#f-photo-input");
    modalCard.querySelector('[data-action="photo-pick"]')?.addEventListener("click", () => fileInput.click());
    modalCard.querySelector('[data-action="photo-clear"]')?.addEventListener("click", () => {
      newPhotoDataUrl = null;
      photoPreviewUrl = null;
      photoCleared = true;
      refreshPhoto();
    });
    fileInput?.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        newPhotoDataUrl = await compressImageFile(file);
        photoPreviewUrl = newPhotoDataUrl;
        photoCleared = false;
        refreshPhoto();
      } catch (err) {
        console.error(err);
        toast("图片处理失败，请重试");
      }
    });
  }
}

// ================= HISTORY TAB =================
function renderHistoryTab() {
  const filter = state.historyFilter || "QT";
  const list = state.quotes.filter((q) => (q.docType || "QT") === filter);
  appContent.innerHTML = `
    <div class="doctype-toggle">
      <button type="button" class="${filter !== "EQ" ? "active" : ""}" data-action="history-filter-set" data-type="QT">报价 Quotation</button>
      <button type="button" class="${filter === "EQ" ? "active" : ""}" data-action="history-filter-set" data-type="EQ">询价 Enquiry</button>
    </div>
    <section class="panel">
      <div class="panel-title">${filter === "EQ" ? "历史询价单" : "历史报价单"}</div>
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
            : `<div class="empty-hint">${filter === "EQ" ? "还没有保存过询价单" : "还没有保存过报价单"}</div>`
        }
      </div>
    </section>
  `;

  appContent.querySelectorAll('[data-action="history-filter-set"]').forEach((btn) =>
    btn.addEventListener("click", () => {
      state.historyFilter = btn.dataset.type;
      renderHistoryTab();
    })
  );
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
function formatBytes(n) {
  if (!n) return "0 MB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

async function renderSettingsTab() {
  const s = state.settings;
  const storage = await getStorageEstimate();
  const pendingImages = await getPendingImages();
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
      <p class="hint-text">汇率含义：1 基准币种 = 该数值 × 目标币种。商品表中的价格以基准币种（${esc(
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

    <section class="panel">
      <div class="panel-title">本地存储用量</div>
      ${
        storage
          ? `
        <div class="storage-bar">
          <div class="storage-bar-fill" style="width:${Math.min(100, storage.percent * 100).toFixed(1)}%"></div>
        </div>
        <p class="hint-text" style="margin-top:6px">已用 ${formatBytes(storage.usage)} / 约 ${formatBytes(
              storage.quota
            )}（${(storage.percent * 100).toFixed(1)}%）。图片存在 IndexedDB 里，配额比 localStorage 大得多，接近上限时建议清理。</p>
      `
          : `<p class="hint-text">当前浏览器不支持查询存储用量。</p>`
      }
      <button class="btn btn-outline full" data-action="clear-image-cache">清理旧图片本地缓存（只保留最近 200 个商品）</button>
    </section>

    <section class="panel">
      <div class="panel-title">图片云端同步</div>
      <p class="hint-text" style="margin-top:0">${
        pendingImages.length
          ? `还有 ${pendingImages.length} 张图片待同步到云端${navigator.onLine ? "" : "（当前离线，联网后会自动同步）"}`
          : "所有图片已同步到云端"
      }</p>
      <button class="btn btn-outline full" data-action="sync-now" ${
        pendingImages.length && navigator.onLine ? "" : "disabled"
      }>立即同步</button>
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
  appContent.querySelector('[data-action="clear-image-cache"]').addEventListener("click", async () => {
    const count = await enforceProductImageLRU(200);
    renderSettingsTab();
    toast(count ? `已清理 ${count} 张较久未查看的商品图片本地缓存` : "没有可清理的图片（未同步云端的图片不会被清）");
  });
  const syncBtn = appContent.querySelector('[data-action="sync-now"]');
  syncBtn?.addEventListener("click", async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "同步中…";
    const { uploaded, failed } = await syncPendingImages();
    renderSettingsTab();
    toast(failed ? `同步完成：成功 ${uploaded} 张，失败 ${failed} 张` : `同步完成：${uploaded} 张`);
  });
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
      openQuotePreview();
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

// 联网时把还没同步的图片传到云端（离线时 syncPendingImages 内部直接跳过）
window.addEventListener("online", () => syncPendingImages().catch((err) => console.error("图片同步失败", err)));

// ---------------- service worker ----------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.error("SW registration failed", err);
    });
  });
}

// 旧版本把图片直接存成 base64 塞进 localStorage 的商品/报价单记录里，第一次用新版本打开时
// 把它们搬进 IndexedDB，localStorage 里只留一个 imageId 引用（不然 localStorage 配额很快就爆）。
async function migrateLegacyImages() {
  let changed = false;
  for (const p of db.getProducts()) {
    if (typeof p.image === "string" && p.image.startsWith("data:")) {
      const imageId = await putImage(p.image, { kind: "product", ownerId: p.id });
      const { image, ...rest } = p;
      db.saveProduct({ ...rest, imageId });
      changed = true;
    }
  }
  for (const q of db.getQuotes()) {
    if (typeof q.customer?.cardImage === "string" && q.customer.cardImage.startsWith("data:")) {
      const imageId = await putImage(q.customer.cardImage, { kind: "card", ownerId: q.id });
      const { cardImage, ...restCustomer } = q.customer;
      db.saveQuote({ ...q, customer: { ...restCustomer, cardImageId: imageId } });
      changed = true;
    }
  }
  if (changed) {
    state.products = db.getProducts();
    state.quotes = db.getQuotes();
  }
}

async function checkStorageUsage() {
  const estimate = await getStorageEstimate();
  if (estimate && estimate.percent > 0.8) {
    toast("本地存储空间快用完了，建议去「设置」清理旧图片缓存");
  }
}

migrateLegacyImages()
  .then(render)
  .catch((err) => {
    console.error("图片迁移失败", err);
    render();
  });
enforceProductImageLRU(200).catch((err) => console.error("LRU 清理失败", err));
checkStorageUsage().catch((err) => console.error("存储用量检查失败", err));
syncPendingImages().catch((err) => console.error("图片同步失败", err));
