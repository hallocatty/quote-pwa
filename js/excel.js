// 报价单导出 Excel（SheetJS，纯前端离线生成，不依赖后端）。懒加载，只有第一次点导出 Excel 才会去下载库文件，
// 之后由 service worker 缓存离线可用。
import { formatMoney, describeItemSpec, docTypeName } from "./pricing.js";

const XLSX_URL = new URL("../vendor/xlsx.full.min.js", import.meta.url).href;

let scriptLoadPromise = null;
function loadXlsxScript() {
  if (window.XLSX) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = XLSX_URL;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Excel 导出组件加载失败，请检查网络"));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

// ---------------- 商品表 Excel 导入/模板 ----------------
// 同一个商品名称可以出现多行（比如不同颜色/克重的规格），会自动合并成一个商品、多条 SKU 规格；
// 单价只按第一行生效（简单单价，不支持一次性导入阶梯价，导入后可在表单里手动加档）。
const PRODUCT_TEMPLATE_HEADERS = ["商品名称 Name", "单位 Unit", "商品编码 Code", "成分配方 Formula", "颜色 Color", "克重容量 Weight", "单价 Price", "备注 Note"];

export async function downloadProductTemplate() {
  await loadXlsxScript();
  const rows = [
    PRODUCT_TEMPLATE_HEADERS,
    ["便携香薰机", "件", "AR-001", "无硅油配方", "白色", "50g", 39.9, "示例行，可删除"],
    ["便携香薰机", "件", "AR-001", "无硅油配方", "粉色", "50g", 39.9, "同名多行=同一商品的不同规格"],
  ];
  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 20 }, { wch: 8 }, { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 20 }];
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Products");
  window.XLSX.writeFile(wb, "商品表导入模板-Product Import Template.xlsx");
}

function pickField(row, ...keys) {
  for (const key of keys) {
    for (const k of Object.keys(row)) {
      if (k.trim().toLowerCase().startsWith(key.toLowerCase())) {
        const v = String(row[k] ?? "").trim();
        if (v) return v;
      }
    }
  }
  return "";
}

// 解析 Excel 文件，按「商品名称」分组合并成商品数组（每个商品含 tiers/skuOptions），
// 交给上层去 db.saveProduct（按名称匹配已有商品做更新，否则新增）。
export async function parseProductExcelFile(file) {
  await loadXlsxScript();
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rawRows = window.XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const grouped = new Map();
  let skipped = 0;
  for (const row of rawRows) {
    const name = pickField(row, "商品名称", "name");
    const priceStr = pickField(row, "单价", "price");
    const price = parseFloat(priceStr);
    if (!name || !Number.isFinite(price)) {
      skipped++;
      continue;
    }
    const unit = pickField(row, "单位", "unit") || "件";
    const code = pickField(row, "商品编码", "编码", "code");
    const formula = pickField(row, "成分配方", "成分", "配方", "formula");
    const note = pickField(row, "备注", "note");
    const color = pickField(row, "颜色", "color");
    const weight = pickField(row, "克重容量", "克重", "容量", "weight");

    if (!grouped.has(name)) {
      grouped.set(name, { name, unit, sku: code, formula, note, tiers: [{ minQty: 1, price }], skuOptions: [] });
    }
    const product = grouped.get(name);
    if (color || weight) {
      const exists = product.skuOptions.some((s) => s.color === color && s.weight === weight);
      if (!exists) product.skuOptions.push({ color, weight });
    }
  }

  return { products: [...grouped.values()], skipped };
}

export async function exportQuoteExcel(quote, settings, products = []) {
  await loadXlsxScript();

  const dateStr = new Date(quote.createdAt || Date.now()).toLocaleDateString("zh-CN");
  const docName = docTypeName(quote.docType);
  const rows = [
    [settings.companyName || ""],
    [`${docName.zh} ${docName.en}`],
    [quote.number ? `编号 / No.: ${quote.number}` : ""],
    [`客户/公司 Client: ${quote.customer.company || ""}`],
    [
      `联系人 Contact: ${quote.customer.name || ""}`,
      "",
      `手机 Phone: ${quote.customer.phone || ""}`,
      "",
      `微信/其他 WeChat/Other: ${quote.customer.contact || ""}`,
    ],
    [`邮箱 Email: ${quote.customer.email || ""}`, "", `网址 Website: ${quote.customer.website || ""}`],
    [`地址 Address: ${quote.customer.address || ""}`],
    [`日期 Date: ${dateStr}`, "", `币种 Currency: ${quote.currency}`],
    [],
    ["#", "商品名称 Item", "规格 Spec", "单位 Unit", "数量 Qty", "单价 Unit Price", "小计 Subtotal"],
    ...quote.items.map((it, i) => [
      i + 1,
      it.name,
      describeItemSpec(it),
      it.unit || "",
      it.qty,
      formatMoney(it.unitPrice, quote.currencies || settings.currencies, quote.currency),
      formatMoney(it.subtotal, quote.currencies || settings.currencies, quote.currency),
    ]),
    [],
    ["", "", "", "", "", "合计 Total", formatMoney(quote.total, quote.currencies || settings.currencies, quote.currency)],
  ];
  if (quote.note) rows.push([], [`备注 Note: ${quote.note}`]);

  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 4 },
    { wch: 26 },
    { wch: 20 },
    { wch: 10 },
    { wch: 8 },
    { wch: 14 },
    { wch: 14 },
  ];

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, docName.en);

  const fileName = `${docName.zh}-${quote.number ? quote.number + "-" : ""}${(
    quote.customer.company || quote.customer.name || "客户"
  ).replace(/[\\/:*?"<>|]/g, "_")}-${new Date(quote.createdAt || Date.now()).toISOString().slice(0, 10)}.xlsx`;
  window.XLSX.writeFile(wb, fileName);
}
