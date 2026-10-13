# 手机切换应用后页面重载修复

日期：2026-10-13。修复基于 GitHub `main` 的 `2f96047b`，先在 `dev` 分阶段提交，再合并到 `main`。

## 问题与触发链

用户在手机浏览器查看页面，特别是管理员查看其他用户对话时，切到别的应用再返回，会出现重新加载、展开状态消失或阅读位置改变。排查发现两条独立路径。

### 1. 前台同步引起页面数据重新加载

`useUserSettingsRefresh` 在 `focus` 和可见的 `visibilitychange` 时同步账户信息，并使用 30 秒间隔合并重复事件。这个同步本身需要保留，以便接收其他设备修改的设置。

问题发生在后续链路：

1. `refreshProfile()` 接收资料后写入新的 `user` 对象，即使语言未改变。
2. `AuthGate` 随之重新应用账户偏好。
3. 语言 store 无条件调用 `i18n.changeLanguage()`；相同语言仍会触发 `languageChanged`。
4. `react-i18next` 更新组件的 `t` 函数。
5. 将 `t` 列为加载 effect 依赖的页面再次请求数据，部分页面切换至 loading，卸载已有内容。

对管理员对话详情，这会再次请求对话、整棵消息树和用户列表，将本地查看的分支恢复为服务端的 `active_leaf_id`，并丢失消息子组件里的展开状态。这条路径属于组件数据重载，地址可以保持不变，并不一定发生整个文档刷新。

账户设置另有直接问题：依赖整个 `user` 对象的 effect 会将尚未保存的姓名输入覆盖为服务端姓名，不需要语言事件也能触发。

### 2. 待更新版本在后台主动刷新整页

`app-update.ts` 检测到部署版本变化后设置待更新状态。旧逻辑将页面隐藏视为安全时机，在 `visibilitychange` 进入 hidden 或在 hidden 时收到版本通知时直接执行 `location.reload()`。

手机切换应用通常会使页面隐藏。管理员只读页面没有生成或输入框阻止刷新，因此更容易直接满足旧的自动刷新条件。隐藏不代表阅读位置、展开状态和编辑草稿可以丢弃。

## 具体更改

| 文件 / 页面 | 更改 | 修复后的行为 |
| --- | --- | --- |
| `src/store/language.ts` | 仅在目标语言与当前 `i18n.language` 不同时调用 `changeLanguage` | 相同语言的前台同步不再触发翻译事件；仍同步 localStorage 和 HTML `lang`，显式语言选择仍写回账户设置 |
| `src/pages/settings/Account.tsx` | 根据账户 ID 和姓名、邮箱字段同步，记录前一份资料并判断本地输入是否已编辑 | 同一账户保留未保存姓名；未编辑字段接受服务端变化；切换账户重新初始化输入 |
| `AdminUserConversation.tsx` | 加载 effect 用稳定的 `i18n` 实例翻译错误，不依赖变化的 `t` | 同步或切换语言保持本地分支、消息节点和展开状态；切换对话 ID 仍正常加载 |
| `AdminUserConversations.tsx` | 同样解除翻译函数与数据加载的关系 | 保留列表；用户 ID、嵌入模式和重试 key 仍触发加载；兼容旧服务端模型标签逻辑保持可用 |
| `AdminUserLibrary.tsx` | 初次加载不依赖 `t` | 语言更新保留已加载的后续图片和知识库展开内容 |
| `AdminModelEdit.tsx` | 模型初始化不依赖 `t` | 语言更新不再重新初始化模型草稿；切换模型 ID 仍加载新模型 |
| `model-quota-editor.tsx` | 配额加载不依赖 `t`，忽略已取消加载的错误提示 | 同页配额草稿也能保留，避免父页面修好后子组件仍覆盖输入 |
| `src/pages/files/UserFiles.tsx` | 文件请求 callback 使用稳定 `i18n` 实例处理错误 | 语言更新不再重取列表；搜索、筛选、排序、分页仍正常请求 |
| `src/lib/app-update.ts` / `src/App.tsx` | 更新只能在文档可见且发生路由导航时应用 | 切到后台、回到前台、后台检测及其他标签页广播均不主动刷新当前页；前台继续检测版本 |
| `src/components/chat/message-row.tsx` | 有分支浏览 callback 时显示分支按钮，包括只读模式 | 管理员可以在完整消息树中本地浏览其他分支；编辑、删除、重新生成等操作仍由只读限制控制 |

数据加载的错误提示使用带命名空间的 `i18n.t()`，在请求失败时获取当前语言的提示。界面仍使用 `useTranslation` 的 `t`，所以语言改变能够即时更新可见文字。

自动更新仍检查生成流和 reload blockers，保留上传、录音、未发送输入等保护、桌面 bridge 跳过逻辑、跨标签页版本通知、30 秒检测节流、15 分钟可见页面检测及 5 分钟重复版本刷新退避。代价是停留在同一页面的标签页会等到下一次可见路由导航才应用新版本。

## 分阶段提交

1. `0e871b42` — `fix(settings): preserve page state during foreground profile sync`
   - 相同语言幂等同步，保护账户姓名草稿。
   - 新增语言和账户页 7 项回归；补齐已有账户同步测试缺失的 `invalidateAccountRequests` mock。
2. `3aa209fe` — `fix(pages): decouple data loading from language changes`
   - 修复对话详情、列表、资料库、模型编辑、配额编辑及文件列表的加载依赖。
   - 新增 8 项认证入口与页面联动回归。
3. `0acf0acd` — `fix(updates): preserve mobile pages across app switching`
   - 移除后台自动刷新，限制到可见路由导航。
   - 新增 10 项版本更新生命周期回归。
4. `e9643f95` — `fix(admin): retain read-only conversation branch inspection`
   - 修复真实只读消息组件的分支浏览按钮。
   - 页面回归直接使用真实 `MessageRow`、`ReasoningTrace`。
   - 新增生产构建浏览器回归入口 `npm run test:foreground`。
5. 文档提交记录本次根因、实现、验证结果、基线问题和复测步骤。

## 验证结果

### 相关回归

6 个相关测试文件共 **31 项通过**，其中本次新增 25 项，另有 6 项已有前台 hook / 账户设置同步测试：

```sh
npm test -- \
  tests/frontend/store/language-refresh.test.ts \
  tests/frontend/pages/settings-account-refresh.test.tsx \
  tests/frontend/hooks/use-user-settings-refresh.test.tsx \
  tests/frontend/store/auth-settings-refresh.test.ts \
  tests/frontend/pages/admin/foreground-page-state.test.tsx \
  tests/frontend/lib/app-update.test.ts
```

页面联动测试使用真实 `AuthGate`、auth store 的 `refreshProfile()`、前台同步 hook、i18next、消息组件和思考展开组件；API 使用本地 mock。覆盖：

- 重复前台事件合并，接收相同或不同云端语言时保留分支和展开状态。
- 新对话、新用户导航仍加载正确数据，旧路由请求晚返回不能覆盖新页面。
- 嵌入式对话列表失败后可重试。
- 图片追加分页及知识库展开内容保留。
- 模型标签和配额限额草稿保留，切换模型重新加载。
- 文件语言更新不重取列表，搜索变更正常请求。
- 同语言重复应用不产生翻译事件，显式选择仍持久化。
- 账户未保存姓名保护和账户身份切换。
- 后台检测、跨标签页通知、更新保护、节流、刷新退避及桌面/开发环境跳过。

### 生产构建浏览器回归

```sh
NODE_OPTIONS=--max-old-space-size=4096 npm run build
FOREGROUND_OUTPUT=/private/tmp/aivory-foreground-results npm run test:foreground
```

使用 Edge `155.0.4283.45`，在 **390×844 移动触控视口**和 **1280×900 桌面视口**均通过。测试运行完整生产应用，后端请求由本地测试服务器提供固定数据，未连接线上账户。

两个场景均确认：

- 对话详情与消息树各加载 1 次；三轮模拟后台/前台切换不增加这两类请求。
- 每轮时间推进 31 秒，`focus` 和 `visibilitychange` 合并为 1 次资料同步，总计 3 次。
- 选中分支 B 后，真实消息 DOM 节点保持一致，思考过程继续展开。
- 相同语言返回时滚动位置保持 **220px**；云端语言改为英文后界面语言更新且消息状态保留。
- 已知新部署版本时，后台/前台切换不刷新文档。
- 点击返回列表后应用待更新版本；使用文档启动标识变化和第 2 次 session 初始化确认恰好 1 次整页重载。
- 无浏览器运行时异常。

浏览器回归模拟页面可见性和经过时间。未使用 iOS Safari / Android 手机真机，不涵盖操作系统因内存压力回收标签页后进行的恢复加载。

### 全量检查和既有基线问题

- `npm run typecheck`：通过。
- 生产构建：通过；默认 Node 堆约 2 GiB 首次构建内存不足，使用上面的 4 GiB 堆参数后通过。保留原有大 chunk 和混合动态/静态导入提示。
- 本次改动的源文件及前端测试 ESLint：通过。
- `git diff --check`：通过。
- 全量前端测试：**1071 / 1077 通过，6 项失败**。以下 6 项在修复前 GitHub `main` 基线 `2f96047b` 独立检出后同样复现，未因本次改动新增失败：

| 既有测试 | 失败原因 |
| --- | --- |
| `auth-hydrate.test.ts`（1 项） | API client mock 缺少账户请求失效接口 |
| `auth-passkey-login.test.ts`（2 项） | 同类 mock 缺失导致成功流程或账户切换异常 |
| `panel-fallback.test.tsx`（1 项） | 屏幕加载界面已改为启动画面，断言仍要求旧旋转动画类名 |
| `admin-audit-logs.test.tsx`（1 项） | 断言要求原始 action 字符串，实际列表渲染翻译标签 |
| `admin-typography.test.ts`（1 项） | 既有 `AdminToolLogs.tsx` 中出现低于 12px 的文字 |

全量 `npm run lint`：基线和修复版本均为 **1 个错误、9 个警告**。错误位于 `vite.config.ts` 的既有 ESLint 解析配置，无法解析 `type Container`。本次未修改这些非前台刷新相关的实现或断言。

## 手机复测步骤

1. 管理员打开其他用户的对话详情，切到另一个回答分支，展开思考过程并向下滚动。
2. 切到其他应用后返回浏览器，分别测试短时间返回和超过资料同步间隔后的返回，多次重复。
3. 确认没有重新显示整页 loading；分支、展开状态和阅读位置保留。
4. 打开账户或模型编辑，修改输入但先不保存，切到其他应用再返回，确认输入保留。
5. 在另一设备修改账户语言，再返回当前页面，确认文字更新且上述局部状态保留。
6. 有新前端版本时重复切换应用，确认不自动刷新；随后点击其他页面，在无生成和无 reload blocker 时应完成更新。

## 分支处理

原工作目录的本地 `dev` / `main` 与 GitHub 历史存在较大分叉。本次使用独立本地检出，基于实际 GitHub refs 工作，保留原工作目录和原有本地提交。

开始时远端 `dev` 为 `7e0ad449`，是 `main` 的祖先且落后 25 个提交。因此先将修复检出的 `dev` 快进到 `main` 的 `2f96047b`，再进行上述阶段提交。推送前重新获取远端 refs；合并使用正常 merge 并保留 merge commit，不使用 force push。
