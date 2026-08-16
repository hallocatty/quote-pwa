# 展会报价单 PWA

展会现场离线报价工具。纯前端静态 PWA，数据存在浏览器本地（localStorage），无后端、无构建工具依赖。

## 在线地址

https://hallocatty.github.io/quote-pwa/

手机浏览器打开后可"添加到主屏幕"，安装后离线也能用。

## 功能

- **报价**：选客户信息、从价目表挑商品、改数量、切换币种，自动算合计
- **价目表**：商品支持阶梯价（按数量分档定价）
- **历史**：保存过的报价单可查看、继续编辑、删除
- **设置**：公司信息（显示在导出的 PDF 上）、多币种汇率、整站数据导出/导入（JSON 备份）
- **PDF 导出**：html2canvas 截图报价单模板 + jsPDF 拼页（规避中文字体问题）
- **离线**：service worker 预缓存全部资源，弱网/无网环境可用

## 本地开发

无需 npm/构建工具，任意静态服务器即可：

```bash
python3 -m http.server 8811
# 打开 http://127.0.0.1:8811
```

## 更新部署

改完文件后：

```bash
git add -A
git commit -m "说明改了什么"
git push
```

GitHub Pages 会自动重新构建，通常 1 分钟内生效（`main` 分支根目录直接发布，已在仓库 Pages 设置中配置）。

## 目录结构

```
index.html              # 入口，四个 tab（报价/价目表/历史/设置）
css/style.css           # 样式
js/
├── app.js              # 页面渲染与交互逻辑
├── db.js               # localStorage 读写封装
├── pricing.js          # 阶梯价 / 多币种换算
└── pdf.js              # PDF 导出（html2canvas + jsPDF）
vendor/                 # 第三方库本地化（离线可用，不依赖 CDN）
icons/                  # PWA 图标
manifest.webmanifest    # PWA 清单
service-worker.js       # 离线缓存
```
