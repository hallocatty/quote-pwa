// 名片拍照识别：纯前端离线 OCR（Tesseract.js + 本地 vendor 的中英文识别模型），
// 识别引擎懒加载——只有用户第一次点"拍摄名片"才会去下载/初始化，之后由 service worker 缓存离线可用。
// 结构化字段提取（公司/姓名/电话/邮箱/地址/网址）是正则启发式，不保证准确，仅用于减少手动输入，需人工核对。

// 用 import.meta.url 算绝对路径——Tesseract 的 worker 是独立线程，里面的相对路径是相对
// worker 脚本自己的位置解析的（不是相对页面），用相对路径会在 worker 内被解析错并叠加出重复
// 的 /vendor/tesseract/vendor/tesseract/... 从而 404，导致识别一直卡住没有任何结果。
const TESSERACT_DIR = new URL("../vendor/tesseract/", import.meta.url).href;
const TESSDATA_DIR = new URL("../vendor/tessdata/", import.meta.url).href;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let scriptLoadPromise = null;
function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TESSERACT_DIR + "tesseract.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("识别引擎加载失败，请检查网络"));
    document.head.appendChild(script);
  });
  return withTimeout(scriptLoadPromise, 30000, "识别引擎下载超时，请检查网络后重试");
}

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = loadTesseractScript().then(() =>
      withTimeout(
        window.Tesseract.createWorker("chi_sim+eng", 1, {
          workerPath: TESSERACT_DIR + "worker.min.js",
          // corePath 必须是目录，Tesseract 内部会在这个目录下按能力自动挑
          // tesseract-core.wasm.js 或 tesseract-core-simd.wasm.js，两个都得放在这（官方文档明确说明，
          // 指向具体文件是不支持的用法）。
          corePath: TESSERACT_DIR.replace(/\/$/, ""),
          langPath: TESSDATA_DIR.replace(/\/$/, ""),
        }),
        60000,
        "识别模型加载超时（首次使用需下载约 9MB，请检查网络后重试）"
      )
    );
    // 初始化失败就把缓存清掉，下次调用能重新尝试，而不是一直卡在同一个失败的 promise 上
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

export async function recognizeCardText(file) {
  const worker = await getWorker();
  const {
    data: { text },
  } = await withTimeout(worker.recognize(file), 60000, "识别超时，请重试");
  return text;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const MOBILE_RE = /1[3-9]\d{9}/;
const PHONE_RE = /(\+?\d[\d\-\s()]{6,14}\d)/;
const WEBSITE_RE = /\b((https?:\/\/)?(www\.)?[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\.[a-zA-Z]{2,})?(\/[^\s]*)?)\b/;
const COMPANY_RE = /(公司|集团|企业|厂|工作室|co\.,?\s*ltd\.?|inc\.?|corp\.?|llc|limited)/i;
const HAS_CJK_RE = /[一-龥]/;
const CN_ADDRESS_RE = /(省|市|区|县|路|街|号|大厦|广场)/;
const EN_ADDRESS_RE = /(\d+\s*号|no\.?\s*\d+|road|street|\bave\b|building)/i;
// 名片上姓名旁边常有二维码/logo，被 OCR 成同一行行尾的乱码，所以只锚定行首，
// 后面允许有一大段空白 + 其它噪声，不要求整行都是干净的姓名
const CHINESE_NAME_RE = /^([一-龥]{2,4})(?:\s{2,}|$)/;
const WESTERN_NAME_RE = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})(?:\s{2,}|$)/;

// 行尾如果跟着一大段空白后又有内容，通常是同一行右侧的二维码/图标被识别成了乱码，
// 只保留空白前的部分
function stripTrailingNoise(line) {
  return line.replace(/\s{2,}.*$/, "").trim();
}

// 从 OCR 原始文本里启发式提取结构化字段。只在对应字段为空时才会被上层用来自动填充，
// 宁可少填/不填，也不覆盖用户已经手动输入或识别错误的内容。
export function parseCardText(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const email = text.match(EMAIL_RE)?.[0] || "";
  const mobile = text.match(MOBILE_RE)?.[0] || "";
  const phone = mobile || text.match(PHONE_RE)?.[0]?.trim() || "";

  let website = "";
  const websiteMatch = text.match(WEBSITE_RE);
  if (websiteMatch && !(email && email.includes(websiteMatch[0]))) {
    website = websiteMatch[0];
  }

  const usedLines = new Set();
  let company = "";
  let address = "";

  const companyLine = lines.find((l) => COMPANY_RE.test(l));
  if (companyLine) {
    company = stripTrailingNoise(companyLine);
    usedLines.add(companyLine);
  }

  // 地址：中文卡片优先找带省市区路号等信号、且不是公司名的行；没有再退到英文地址信号
  const addressLine =
    lines.find(
      (l) => !usedLines.has(l) && HAS_CJK_RE.test(l) && CN_ADDRESS_RE.test(l) && !COMPANY_RE.test(l)
    ) || lines.find((l) => !usedLines.has(l) && EN_ADDRESS_RE.test(l));
  if (addressLine) {
    address = stripTrailingNoise(addressLine);
    usedLines.add(addressLine);
  }

  const isNoise = (l) =>
    usedLines.has(l) ||
    (email && l.includes(email)) ||
    (phone && l.includes(phone)) ||
    (website && l.includes(website));

  // 姓名：优先找行首 2-4 个汉字，找不到再退到"First Last"这种西式姓名，都找不到就不猜
  let name = "";
  const chineseNameLine = lines.find((l) => !isNoise(l) && CHINESE_NAME_RE.test(l));
  if (chineseNameLine) {
    name = chineseNameLine.match(CHINESE_NAME_RE)[1];
  } else {
    const westernNameLine = lines.find((l) => !isNoise(l) && WESTERN_NAME_RE.test(l));
    if (westernNameLine) name = westernNameLine.match(WESTERN_NAME_RE)[1];
  }

  return { company, name, phone, email, address, website };
}
