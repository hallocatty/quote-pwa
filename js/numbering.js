// 报价单编号生成：调用部署在阿里云上的 quote-pwa-api（独立服务，见该仓库 README）。
// 展会现场可能没有网络，调用失败时把错误抛给调用方处理（通常是提示"稍后重新获取"，不阻塞本地保存/导出）。
const API_BASE = "https://quote-api.labeaustudio.com";

async function callApi(path, options) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `编号服务返回 ${res.status}`);
  return data;
}

export async function requestQuoteNumber(entity) {
  const data = await callApi("/api/numbers", {
    method: "POST",
    body: JSON.stringify({ entity }),
  });
  return data.number;
}

export async function requestRevisionNumber(baseNumber) {
  const data = await callApi(`/api/numbers/${encodeURIComponent(baseNumber)}/revisions`, {
    method: "POST",
  });
  return data.number;
}
