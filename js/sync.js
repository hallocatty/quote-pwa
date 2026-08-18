// 图片云同步：本地 IndexedDB 里标记为 pending 的图片，联网后传到 OSS（走服务器签发的短期签名 URL，
// 前端从不持有 AccessKey）。同步成功只是"多一份云端备份 + 允许本地释放空间"，本地 blob 默认还在，
// 真正腾空间是 imagestore.js 的 LRU 清理负责的（只清已同步过的）。
import { getPendingImages, markSynced, setCloudResolver } from "./imagestore.js";

const API_BASE = "https://quote-api.labeaustudio.com";

async function requestUploadUrl(imageId, contentType) {
  const res = await fetch(`${API_BASE}/api/images/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageId, contentType }),
  });
  if (!res.ok) throw new Error(`获取上传地址失败 ${res.status}`);
  return res.json();
}

async function requestDownloadUrl(objectKey) {
  const res = await fetch(`${API_BASE}/api/images/download-url?key=${encodeURIComponent(objectKey)}`);
  if (!res.ok) throw new Error(`获取访问地址失败 ${res.status}`);
  const { url } = await res.json();
  return url;
}

// imagestore 本地没有 blob（被 LRU 清过）但已同步过云端时，靠这个 resolver 换一张新的签名 GET 链接来显示。
setCloudResolver(requestDownloadUrl);

let syncing = false;

// 把所有还没同步的图片依次传到 OSS；单张失败不影响其它张，失败的留着 pending 状态，下次再触发时重试。
export async function syncPendingImages() {
  if (syncing || !navigator.onLine) return { uploaded: 0, failed: 0 };
  syncing = true;
  let uploaded = 0;
  let failed = 0;
  try {
    const pending = await getPendingImages();
    for (const record of pending) {
      if (!record.buffer) continue; // 没有本地数据可传（理论上不会出现：LRU 只清已同步的）
      try {
        const contentType = record.mimeType || "image/jpeg";
        const { uploadUrl, objectKey } = await requestUploadUrl(record.id, contentType);
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": contentType },
          body: new Blob([record.buffer], { type: contentType }),
        });
        if (!putRes.ok) throw new Error(`上传失败 ${putRes.status}`);
        await markSynced(record.id, objectKey);
        uploaded++;
      } catch (err) {
        console.error("图片同步失败", record.id, err);
        failed++;
      }
    }
  } finally {
    syncing = false;
  }
  return { uploaded, failed };
}
