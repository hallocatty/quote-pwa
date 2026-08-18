// 报价单导出 Excel（SheetJS，纯前端离线生成，不依赖后端）。懒加载，只有第一次点导出 Excel 才会去下载库文件，
// 之后由 service worker 缓存离线可用。
import { formatMoney, describeItemSpec } from "./pricing.js";

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

export async function exportQuoteExcel(quote, settings, products = []) {
  await loadXlsxScript();

  const dateStr = new Date(quote.createdAt || Date.now()).toLocaleDateString("zh-CN");
  const rows = [
    [settings.companyName || ""],
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
  window.XLSX.utils.book_append_sheet(wb, ws, "Quotation");

  const fileName = `报价单-${quote.number ? quote.number + "-" : ""}${(
    quote.customer.company || quote.customer.name || "客户"
  ).replace(/[\\/:*?"<>|]/g, "_")}-${new Date(quote.createdAt || Date.now()).toISOString().slice(0, 10)}.xlsx`;
  window.XLSX.writeFile(wb, fileName);
}
