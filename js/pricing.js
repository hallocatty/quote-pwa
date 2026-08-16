// 阶梯价与多币种换算逻辑

// 根据数量在阶梯表中找到适用单价（阶梯表存的是产品基准币种下的价格）
export function tierPrice(product, qty) {
  const tiers = [...(product.tiers || [])].sort((a, b) => a.minQty - b.minQty);
  if (tiers.length === 0) return 0;
  let applicable = tiers[0];
  for (const t of tiers) {
    if (qty >= t.minQty) applicable = t;
    else break;
  }
  return applicable.price;
}

// 将基准币种金额换算为目标币种。currencies[].rate 定义为「1 基准币种 = rate 个该币种」，基准币种自身 rate = 1。
export function convert(amount, currencies, toCode) {
  const target = currencies.find((c) => c.code === toCode);
  if (!target) return amount;
  return amount * target.rate;
}

export function formatMoney(amount, currencies, code) {
  const c = currencies.find((c) => c.code === code);
  const symbol = c ? c.symbol : "";
  const rounded = Math.round(amount * 100) / 100;
  return `${symbol}${rounded.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function describeTiers(product, currencies, code) {
  const tiers = [...(product.tiers || [])].sort((a, b) => a.minQty - b.minQty);
  return tiers
    .map((t, i) => {
      const next = tiers[i + 1];
      const range = next ? `${t.minQty}-${next.minQty - 1}` : `${t.minQty}+`;
      const price = code
        ? formatMoney(convert(t.price, currencies, code), currencies, code)
        : t.price;
      return `${range}${product.unit || ""} ${price}`;
    })
    .join(" / ");
}
