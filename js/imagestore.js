// 图片改存 IndexedDB（配额比 localStorage 大得多），localStorage 里的商品/报价单记录只存一个
// imageId 引用。渲染层用"先批量解析出 objectURL 再同步渲染模板"的方式，避免把整个 app.js 的
// 模板渲染函数都改成到处 await。
//
// 存的是 ArrayBuffer 而不是 Blob——部分 WebKit/Safari 版本直接把 Blob 存进 IndexedDB 会报
// "Error preparing Blob/File data to be stored in object store"，ArrayBuffer 兼容性没有这个问题，
// 展示/上传时再在内存里现造一个 Blob。
//
// 每条记录：{ id, buffer, mimeType, kind: 'product'|'card', ownerId, createdAt, lastAccessed, syncStatus: 'pending'|'synced', cloudUrl }
// syncStatus/cloudUrl 是留给云存储同步用的（见 sync.js）：本地一律先存 buffer 标记 pending；
// 联网上传成功后 markSynced() 记下 cloudUrl，LRU 清理时才允许清掉本地 buffer（没同步过的绝不清，防丢图）。

const DB_NAME = "quote_pwa_images";
const DB_VERSION = 1;
const STORE = "images";

let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("lastAccessed", "lastAccessed");
        store.createIndex("kind", "kind");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(mode) {
  const db = await openDB();
  return db.transaction(STORE, mode).objectStore(STORE);
}

function uid() {
  return "img_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function toBlob(dataUrlOrBlob) {
  if (typeof dataUrlOrBlob === "string") return (await fetch(dataUrlOrBlob)).blob();
  return dataUrlOrBlob;
}

// 存一张新图片（接受 dataURL 字符串或 Blob），返回 imageId 供业务对象（商品/报价单）保存引用。
export async function putImage(dataUrlOrBlob, { kind = "product", ownerId = null } = {}) {
  const blob = await toBlob(dataUrlOrBlob);
  const buffer = await blob.arrayBuffer();
  const id = uid();
  const s = await store("readwrite");
  await reqToPromise(
    s.put({
      id,
      buffer,
      mimeType: blob.type || "image/jpeg",
      kind,
      ownerId,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      syncStatus: "pending",
      cloudUrl: null,
    })
  );
  return id;
}

const urlCache = new Map(); // imageId -> objectURL/云端签名URL，避免重复读库、重复创建 objectURL

// Bucket 是私有的，本地 blob 被 LRU 清掉之后，展示图片得靠这个外部注入的函数问服务器
// 换一张新的签名 GET 链接（避免 imagestore.js 直接依赖 sync.js 造成循环 import）。
let cloudResolver = null;
export function setCloudResolver(fn) {
  cloudResolver = fn;
}

// 单张图片的可展示 URL；命中内存缓存直接返回，否则读 IndexedDB（顺带更新访问时间，供 LRU 用）。
// 本地没有 blob 但已同步过云端（cloudUrl 存的其实是 OSS object key）时，问 cloudResolver 换取签名 URL。
export async function getImageURL(imageId) {
  if (!imageId) return null;
  if (urlCache.has(imageId)) return urlCache.get(imageId);
  const s = await store("readonly");
  const record = await reqToPromise(s.get(imageId));
  if (!record) return null;
  let url = null;
  if (record.buffer) {
    url = URL.createObjectURL(new Blob([record.buffer], { type: record.mimeType || "image/jpeg" }));
  } else if (record.cloudUrl && cloudResolver) {
    try {
      url = await cloudResolver(record.cloudUrl);
    } catch (e) {
      console.error("获取云端图片地址失败", e);
    }
  }
  if (!url) return null;
  urlCache.set(imageId, url);
  touchAccess(imageId);
  return url;
}

async function touchAccess(imageId) {
  try {
    const s = await store("readwrite");
    const record = await reqToPromise(s.get(imageId));
    if (record) {
      record.lastAccessed = Date.now();
      s.put(record);
    }
  } catch (e) {
    console.error("更新图片访问时间失败", e);
  }
}

// 渲染一批卡片/表格前先调这个，拿到 Map<imageId, url> 后模板里直接同步查表，
// 不用把每个渲染函数都改成 async 到处 await。
export async function resolveImageURLs(imageIds) {
  const map = new Map();
  const unique = [...new Set(imageIds.filter(Boolean))];
  await Promise.all(
    unique.map(async (id) => {
      const url = await getImageURL(id);
      if (url) map.set(id, url);
    })
  );
  return map;
}

export async function deleteImage(imageId) {
  if (!imageId) return;
  const cached = urlCache.get(imageId);
  if (cached?.startsWith("blob:")) URL.revokeObjectURL(cached);
  urlCache.delete(imageId);
  const s = await store("readwrite");
  await reqToPromise(s.delete(imageId));
}

// ---- 存储用量监控 ----
export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota, percent: quota ? usage / quota : 0 };
}

// ---- LRU 清理：商品主图只保留最近访问的 keepCount 张本地数据，超出的部分——
// 仅当已经同步过云端（syncStatus==='synced' 且有 cloudUrl）才清掉本地 buffer 释放空间，
// 之后展示时会自动 fallback 用 cloudUrl；没同步过的图绝不清，防止清丢用户还没上传成功的照片。
export async function enforceProductImageLRU(keepCount = 200) {
  const s = await store("readonly");
  const idx = s.index("kind");
  const all = await reqToPromise(idx.getAll("product"));
  const sorted = all.sort((a, b) => b.lastAccessed - a.lastAccessed);
  const evictable = sorted.slice(keepCount).filter((r) => r.buffer && r.syncStatus === "synced" && r.cloudUrl);
  if (!evictable.length) return 0;
  const ws = await store("readwrite");
  for (const r of evictable) {
    r.buffer = null;
    ws.put(r);
    const cached = urlCache.get(r.id);
    if (cached?.startsWith("blob:")) URL.revokeObjectURL(cached);
    urlCache.delete(r.id);
  }
  return evictable.length;
}

export async function markSynced(imageId, cloudUrl) {
  const s = await store("readwrite");
  const record = await reqToPromise(s.get(imageId));
  if (record) {
    record.syncStatus = "synced";
    record.cloudUrl = cloudUrl;
    s.put(record);
  }
}

export async function getPendingImages(kind) {
  const s = await store("readonly");
  const all = await reqToPromise(s.getAll());
  return all.filter((r) => r.syncStatus !== "synced" && (!kind || r.kind === kind));
}

export async function getAllImageMeta() {
  const s = await store("readonly");
  const all = await reqToPromise(s.getAll());
  return all.map(({ buffer, ...meta }) => ({ ...meta, hasLocalBuffer: !!buffer }));
}
