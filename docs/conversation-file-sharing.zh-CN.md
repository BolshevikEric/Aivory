# 会话文件分享

会话菜单的「分享」支持链接、图片、PDF、JSON 和 TXT。文件分享先进入消息选择模式，再生成预览，最后保存文件；设备支持文件分享时，预览页也会显示系统分享按钮。桌面端与移动端使用相同流程。

## 选择与导出范围

- 四种文件格式共用选择结果，切换格式和画质时保留选中消息。
- 「全选」会先补齐当前会话的历史消息，再选择可导出的用户和助手消息。
- 导出按当前会话分支中的消息顺序排列，排除未选消息、系统消息、生成中的消息和本地临时消息。
- 思考过程、工具调用内部状态、计费、模型及供应商配置不进入分享快照。
- JSON/TXT 中的附件是文件名等元信息，产物保留 URL；附件二进制不打包，也不改变原文件访问权限。
- 取消、切换账号、切换工作空间、权限变化及离开会话会中止当前操作并释放预览 URL。账号和工作空间变化也会清空生成文件缓存。
- 文件分享需要 `allow_sharing` 与 `allow_conversation_export`，工作空间访客不显示文件分享入口。原有链接分享接口继续独立工作。

## 图片生成优化

图片由消息数据生成专用静态 DOM，不再遍历聊天页面的操作按钮、思考面板、滚动容器和其他交互结构。Markdown、代码、表格和数学公式在此 DOM 中排版；生成式 UI 的图表等转成静态内容，隔离的 HTML 交互内容显示提示。

`html-to-image` 使用固定的样式属性列表，避免为每个节点复制浏览器所有计算样式。主题 CSS 变量只在根节点复制一次。字体按实际使用的字体族准备；已嵌入的字体 CSS 有最多 12 项的内存缓存。

默认使用「标准 · 更快」，短图最多 1.5 倍像素；「高清」最多 2 倍像素。相同版式下标准画质的画布像素比高清减少约 44%。长图会继续降低倍率以满足上限，保持单张完整图片：

| 项目 | 限制 |
| --- | --- |
| 排版宽度 | 760 CSS px |
| 排版高度、输出图片单边 | 最大 16,384 px |
| 画布像素 | 最大 16,000,000 |
| 超出可读单张图片容量 | 明确提示减少选择，不静默裁切 |
| 资源并发 | 最多 4 个图片请求/解码 |
| 单次资源准备 | 最多 8 秒 |
| 单张远程图片 | 最大 10 MiB |
| 前端生成总超时 | 60 秒 |
| 生成文件内存缓存 | 最多 2 项，每项最大 24 MiB |

图片先转换为内嵌资源，同源 `/api/` 图片带现有请求认证，外部图片不携带账号凭据。加载失败的图片显示带文件名的提示，字体准备失败使用系统后备字体。缓存键包含选中内容、附件图片引用、账号/工作空间/会话、格式、画质、语言和主题；相同内容重新生成时可直接打开已生成文件。

浏览器派发 `aivory:conversation-export` 事件，只包含格式和各阶段耗时，不包含消息内容。图片事件有 `layout`、`resources`、`fonts`、`capture`、`total`，PDF 有 `prepare`、`print`、`total`。这些耗时从生成库开始计算，不代表用户点击到弹窗出现的完整耗时，也不包含等待全选历史消息的网络时间。

## PDF

PDF 使用专用静态文档和服务端 Chromium 的原生分页打印，保留文本层、公式与代码排版，支持选择和复制文本。预览使用已有 PDF.js 阅读器，可以翻页和缩放。

接口为 `POST /api/conversations/:id/export/pdf`，请求 JSON 的 `html` 字段包含自足文档。请求通过现有会话认证及 HMAC 完整请求签名；服务端检查会话分享管理权限及两个用户组能力后才开始打印。该路由的签名读取上限与处理器均为 16 MiB，普通 JSON 接口仍使用原限制。

服务端复用一个延迟启动的浏览器，每次打印创建独立浏览器上下文，并在结束后销毁。脚本执行、网络和文件 URL 访问被禁用；CSP 只允许内嵌样式和 data 图片/字体。不会将用户会话 Cookie 或请求凭据传给打印浏览器。

| 项目 | 行为 |
| --- | --- |
| 打印版式 | A4、浅色背景、分页与页码 |
| 同一 API 进程并发 | 最多 2 个，满载返回 429 |
| 接口限流 | 每 IP 每分钟 12 次 |
| 单次打印超时 | 40 秒，另有首次浏览器启动时间 |
| 输出大小 | 最大 32 MiB |
| 响应 | `application/pdf`、附件下载、`Cache-Control: no-store` |
| 未配置可执行浏览器 | 503 / `pdf_renderer_unavailable`，界面给出明确提示 |
| 浏览器进程退出 | 下次请求重新启动；API 正常退出时关闭浏览器 |

Web、桌面壳和移动端均使用这个认证接口。桌面客户端不额外调用本地打印浏览器。

### 部署

`deploy/Dockerfile.app` 的运行镜像已包含 `chromium` 与 `fonts-noto-cjk`，个人版和完整版均使用该镜像。新增依赖会增加镜像体积；升级时需部署重新构建的 app 镜像。

直接运行 Go API 时，可通过 `AIVORY_PDF_CHROME_PATH` 指定服务端已有的 Chromium 兼容可执行文件。没有设置时使用 chromedp 的可执行文件发现。缺少打印浏览器只影响 PDF，图片/JSON/TXT 在前端生成。中文字体应安装在 API 所在的服务端环境。

浏览器验证脚本使用 `puppeteer-core`，只查找已存在的浏览器，不下载浏览器。可用 `CHROME_PATH` 指向现有 Microsoft Edge；服务端集成验证则使用 `AIVORY_PDF_CHROME_PATH`。这些变量不要求在用户的个人电脑上安装 Chrome。

## JSON v1 与 TXT

JSON 保留 Markdown 原文，外层包含固定 `format: "aivory-conversation-share"`、`version: 1`、`title`、ISO 8601 的 `exported_at` 和 `messages`。每条消息包含：

```json
{
  "id": "message-id",
  "role": "assistant",
  "content": "Markdown content",
  "created_at": 1780000000000,
  "attachments": [{ "name": "报告.pdf", "kind": "pdf" }],
  "artifacts": [{ "filename": "chart.png", "url": "/api/artifacts/...", "mime_type": "image/png" }],
  "citations": [{ "index": 1, "title": "来源", "url": "https://example.com" }]
}
```

`created_at` 为 Unix 毫秒时间戳。附件删除标志为可选 `deleted: true`。JSON 使用 `application/json;charset=utf-8`，TXT 使用 `text/plain;charset=utf-8`。TXT 将标题、角色、列表、表格、链接、代码和公式源转换为可读文本；代码保留内容，去掉 Markdown 围栏。文本预览最多显示 200,000 字节，保存的文件保留完整内容。

## 验证

```sh
npm run typecheck
npm test -- --run tests/frontend/lib/conversation-share.test.ts tests/frontend/lib/conversation-image.test.ts tests/frontend/lib/conversation-capture.test.ts tests/frontend/api/binary-response.test.ts
npm run test:conversation-share
```

浏览器用例覆盖桌面/移动分享菜单、选择顺序及排除项、失败重试、真实 PNG 像素及 Logo、长图尾部、代码和公式、静态图表/表单、四种文件下载、PDF.js 提取中英文文本、生成缓存、输入草稿保留、账号切换，以及五种语言的深浅主题布局。脚本将截图、PDF 渲染页和文件写入 `node_modules/.cache/aivory-conversation-share`；可通过 `AIVORY_SHARE_TEST_OUTPUT_DIR` 指定输出目录。

```sh
cd server
go test ./internal/api -run 'TestConversationPDF|TestCreateShare'
AIVORY_PDF_CHROME_PATH=/path/to/existing/browser go test ./internal/pdfexport -count=1
go vet ./...
go build ./...
```

真实打印器集成用例覆盖多页 PDF、可搜索字体映射、禁用脚本和外部请求、独立上下文、浏览器复用、并发上限和取消。未指定 `AIVORY_PDF_CHROME_PATH` 时跳过真实浏览器集成用例，其余单元测试仍运行。

### 本次验证记录（2026-10-16）

- 分享/图片/二进制 API 单元测试 13 项及资源准备测试 4 项通过，修改文件的 ESLint 检查通过。
- Edge 浏览器完整场景通过；实际检查了浅色 PDF 页面、四页服务端 PDF 的首尾页、深色图表与移动端预览。服务端 PDF 保留末段文本与页码，恶意脚本未执行、外部请求数为零。
- TypeScript 与生产构建通过，Go 专项测试、`go vet ./...` 和 `go build ./...` 通过。未执行完整 Docker 镜像构建，也未自动操作系统原生文件分享弹窗。
- 完整前端测试执行结果为 1091 项通过、6 项失败；失败来自认证测试 mock、启动占位组件和管理后台既有断言，在改动前基线 `4c421255` 上复现相同 6 项失败。之后新增的 4 项资源准备测试单独通过。
- 全仓 ESLint 的 `vite.config.ts` 解析错误也在同一基线上复现；另有 9 条既有 warning。本次修改文件检查无错误或 warning。
- 后端完整 API 包测试遇到 WAV 时长、非 WAV 转写计费、语音权限撤销相关测试失败；在基线 `4c421255` 上复现相同失败。本次未修改音频功能。

一次本地 Edge 运行的生成库阶段耗时：标准画质短对话约 60 ms，深色图表约 108 ms，180 段长图约 2.1 s。重复运行时长图约 1.4-2.1 s。PDF 前端准备加测试打印约 349 ms（浏览器测试使用拦截接口调用同一浏览器打印，不代表线上 Go 接口延迟）；真实 Go 打印器另有集成测试。数字随设备、内容、字体及资源缓存变化，不作为线上耗时保证。重复生成相同图片时断言未发生新的捕获。
