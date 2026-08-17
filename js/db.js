// 本地持久化：全部数据存在 localStorage，离线可用，无需后端。
const KEYS = {
  products: "qp_products",
  settings: "qp_settings",
  quotes: "qp_quotes",
  draft: "qp_draft",
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error("读取本地数据失败", key, e);
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const DEFAULT_SETTINGS = {
  companyName: "我的公司",
  companyContact: "",
  entity: "LB",
  baseCurrency: "CNY",
  currencies: [
    { code: "CNY", symbol: "¥", rate: 1 },
    { code: "USD", symbol: "$", rate: 0.14 },
  ],
};

export const db = {
  // ---- products ----
  getProducts() {
    return read(KEYS.products, []);
  },
  saveProduct(product) {
    const list = db.getProducts();
    if (!product.id) product.id = uid();
    const idx = list.findIndex((p) => p.id === product.id);
    if (idx >= 0) list[idx] = product;
    else list.push(product);
    write(KEYS.products, list);
    return product;
  },
  deleteProduct(id) {
    write(
      KEYS.products,
      db.getProducts().filter((p) => p.id !== id)
    );
  },
  replaceProducts(list) {
    write(KEYS.products, list);
  },

  // ---- settings ----
  getSettings() {
    return { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) };
  },
  saveSettings(settings) {
    write(KEYS.settings, settings);
    return settings;
  },

  // ---- quotes (history) ----
  getQuotes() {
    return read(KEYS.quotes, []).sort((a, b) => b.createdAt - a.createdAt);
  },
  saveQuote(quote) {
    const list = read(KEYS.quotes, []);
    if (!quote.id) {
      quote.id = uid();
      quote.createdAt = Date.now();
    }
    const idx = list.findIndex((q) => q.id === quote.id);
    if (idx >= 0) list[idx] = quote;
    else list.push(quote);
    write(KEYS.quotes, list);
    return quote;
  },
  deleteQuote(id) {
    write(
      KEYS.quotes,
      read(KEYS.quotes, []).filter((q) => q.id !== id)
    );
  },

  // ---- backup / restore ----
  exportAll() {
    return {
      products: db.getProducts(),
      settings: db.getSettings(),
      quotes: read(KEYS.quotes, []),
      exportedAt: new Date().toISOString(),
    };
  },
  importAll(data) {
    if (data.products) write(KEYS.products, data.products);
    if (data.settings) write(KEYS.settings, data.settings);
    if (data.quotes) write(KEYS.quotes, data.quotes);
  },

  // ---- in-progress quote draft (survives accidental reload) ----
  getDraft() {
    return read(KEYS.draft, null);
  },
  saveDraft(draft) {
    write(KEYS.draft, draft);
  },
  clearDraft() {
    localStorage.removeItem(KEYS.draft);
  },

  uid,
};
