// 用 html2canvas 把报价单模板截图，再用 jsPDF 拼成 A4 PDF（多页自动分页）。
// 用截图而非纯文字方式，是因为 jsPDF 内置字体不支持中文，截图方式直接复用浏览器自身的中文字体渲染。
import { formatMoney, describeItemSpec } from "./pricing.js";

export function buildQuoteHtml(quote, settings, products = []) {
  const rows = quote.items
    .map((it, i) => {
      const product = products.find((p) => p.id === it.productId);
      return `
      <tr>
        <td>${i + 1}</td>
        <td class="pdf-item-cell">
          ${product?.image ? `<img class="pdf-thumb" src="${product.image}" />` : ""}
          <div>
            <div>${escapeHtml(it.name)}</div>
            ${describeItemSpec(it) ? `<div class="pdf-sku">${escapeHtml(describeItemSpec(it))}</div>` : ""}
          </div>
        </td>
        <td>${escapeHtml(it.unit || "")}</td>
        <td class="num">${it.qty}</td>
        <td class="num">${formatMoney(it.unitPrice, quote.currencies, quote.currency)}</td>
        <td class="num">${formatMoney(it.subtotal, quote.currencies, quote.currency)}</td>
      </tr>`;
    })
    .join("");

  const dateStr = new Date(quote.createdAt || Date.now()).toLocaleDateString("zh-CN");

  return `
    <div class="pdf-page">
      <div class="pdf-header">
        <div class="pdf-company">${escapeHtml(settings.companyName || "")}</div>
        <div class="pdf-title">报价单 QUOTATION</div>
      </div>
      <div class="pdf-meta">
        ${quote.number ? `<div>编号 No.：${escapeHtml(quote.number)}</div>` : ""}
        <div>客户 / 公司 Client：${escapeHtml(quote.customer.company || "")}</div>
        <div>联系人 Contact：${escapeHtml(quote.customer.name || "")}　手机 Phone：${escapeHtml(
    quote.customer.phone || ""
  )}　微信/其他 WeChat/Other：${escapeHtml(quote.customer.contact || "")}</div>
        ${
          quote.customer.email
            ? `<div>邮箱 Email：${escapeHtml(quote.customer.email)}</div>`
            : ""
        }
        ${
          quote.customer.address
            ? `<div>地址 Address：${escapeHtml(quote.customer.address)}</div>`
            : ""
        }
        ${
          quote.customer.website
            ? `<div>网址 Website：${escapeHtml(quote.customer.website)}</div>`
            : ""
        }
        <div>日期 Date：${dateStr}　币种 Currency：${quote.currency}</div>
      </div>
      <table class="pdf-table">
        <thead>
          <tr><th>#</th><th>商品名称 Item</th><th>单位 Unit</th><th>数量 Qty</th><th>单价 Unit Price</th><th>小计 Subtotal</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pdf-total">合计 Total：${formatMoney(quote.total, quote.currencies, quote.currency)}</div>
      ${quote.note ? `<div class="pdf-note">备注 Note：${escapeHtml(quote.note)}</div>` : ""}
      <div class="pdf-footer">${escapeHtml(settings.companyContact || "")}</div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

export async function exportQuotePdf(quote, settings, products = []) {
  const host = document.getElementById("pdf-render-host");
  host.innerHTML = buildQuoteHtml(quote, settings, products);
  const pageEl = host.querySelector(".pdf-page");

  // 等待布局稳定
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const canvas = await window.html2canvas(pageEl, {
    scale: 2,
    backgroundColor: "#ffffff",
    useCORS: true,
  });

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();

  const imgWidth = pageWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  const imgData = canvas.toDataURL("image/jpeg", 0.95);

  if (imgHeight <= pageHeight) {
    pdf.addImage(imgData, "JPEG", 0, 0, imgWidth, imgHeight);
  } else {
    // 内容超过一页：按页高切割画布，分页添加
    let renderedHeightPx = 0;
    const pageHeightPx = (pageHeight * canvas.width) / imgWidth;
    while (renderedHeightPx < canvas.height) {
      const sliceHeightPx = Math.min(pageHeightPx, canvas.height - renderedHeightPx);
      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeightPx;
      const ctx = sliceCanvas.getContext("2d");
      ctx.drawImage(
        canvas,
        0,
        renderedHeightPx,
        canvas.width,
        sliceHeightPx,
        0,
        0,
        canvas.width,
        sliceHeightPx
      );
      const sliceData = sliceCanvas.toDataURL("image/jpeg", 0.95);
      const sliceHeightMm = (sliceHeightPx * imgWidth) / canvas.width;
      if (renderedHeightPx > 0) pdf.addPage();
      pdf.addImage(sliceData, "JPEG", 0, 0, imgWidth, sliceHeightMm);
      renderedHeightPx += sliceHeightPx;
    }
  }

  host.innerHTML = "";

  const fileName = `报价单-${quote.number ? quote.number + "-" : ""}${(
    quote.customer.company || quote.customer.name || "客户"
  ).replace(/[\\/:*?"<>|]/g, "_")}-${new Date(quote.createdAt || Date.now()).toISOString().slice(0, 10)}.pdf`;
  pdf.save(fileName);
}
