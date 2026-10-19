# 安装说明（另一台电脑）

本包是 DeepSeek Harness（DSH）的插件包：宿主端 4 个工具 + 聊天导图卡片 +
**右侧文件预览器直接打开 `.xmind`**。零运行时依赖，不需要联网安装 npm 包。

## 1. 前置条件

- 已安装 DeepSeek Harness 0.2.x（桌面版或 `dsh web` 均可）。
- Node.js ≥ 20（DSH 桌面版自带 Node；也可以用系统 Node）。
- 目标机器上至少有一个已初始化的 profile，例如：
  - Windows 默认：`%USERPROFILE%\.dsh\profiles\desktop`
  - 若设置了 `DSH_HOME`：`%DSH_HOME%\profiles\desktop`
  - 本机示例：`D:\DSH_Data\Home\profiles\desktop`

## 2. 解压

把 `dsh-xmind-mindmap-0.2.0.zip` 解压到一个**固定目录**，例如：

```text
D:\DSH-Plugins\dsh-xmind-mindmap\
```

> 安装脚本默认用目录链接把该目录挂进 profile，所以不要解压到临时目录后再移动；
> 移动后重新执行一次 `apply` 即可。

## 3. 安装（推荐：脚本）

在解压后的目录里打开 PowerShell / 终端：

```powershell
# 1) 自检包完整性
node scripts/install-profile.mjs verify

# 2) 安装到当前 profile（自动找 DSH_PROFILE_DIR / DSH_HOME）
node scripts/install-profile.mjs apply

# 如果自动找不到 profile，显式指定：
node scripts/install-profile.mjs apply --profile-dir "C:\Users\你\.dsh\profiles\desktop"
# 或者按名字（$DSH_HOME/profiles/<name>）：
node scripts/install-profile.mjs apply --profile web
```

脚本只做三件事，并且会先备份 profile 的 `package.json`：

1. 在 `<profile>\node_modules\dsh-xmind-mindmap` 建立指向本目录的链接（Windows 为 junction，macOS/Linux 为 symlink）；
2. 在 profile `package.json` 的 `dependencies` 里加 `"dsh-xmind-mindmap": "link:<本目录>"`；
3. 把 `dsh-xmind-mindmap` 追加进 `dsh.profile.bundles`。

**然后重启一次 DeepSeek Harness**（关闭再打开，或在应用菜单退出后重开）。重启后：

- 左侧「插件」页应能看到 **XMind 导图**；
- 右侧文件树里点开任意 `.xmind`，右侧面板直接显示导图；
- 聊天里出现 4 个工具：`view_xmind`、`markdown_to_mindmap`、`edit_mindmap_node`、`xmind_to_markdown`。

## 4. 安装（有插件管理器的机器）

如果目标机器的 DSH 暴露了 `plugin_manager`（或在设置里能安装本地目录）：

1. 把本目录作为 bundle/本地插件安装；
2. 确认插件列表里 `dsh-xmind-mindmap` 已启用；
3. 重启或让配置 HMR 重载后即可。

也可以使用 CLI（若该机器提供 `dsh` 命令）：

```sh
dsh plugin --profile <profile> add <本目录绝对路径>
```

安装后仍需确认 `dsh.profile.bundles` 里包含 `dsh-xmind-mindmap`（插件管理器会自动做；
仅 `pnpm add` 不会）。不确定时直接运行 `node scripts/install-profile.mjs apply`。

## 5. 使用

- **右侧预览**：文件树/文件标签里点开 `.xmind`；多 Sheet 文件顶部有下拉切换；
  工具栏支持导图/大纲、适应、缩放、展开/收起；点节点看备注/链接/标签。只读。
- **聊天**：
  - `查看 D:\...\a.xmind`
  - `把这个 md 转成导图并保存为 a.xmind`
  - `把 a.xmind 里“Roadmap”节点改名为“路线图”`
  - `把 a.xmind 转成 Markdown 保存到 a.md`
- 右侧预览随文件版本自动刷新；编辑仍走 `edit_mindmap_node`，不在预览画布上拖拽编辑。

## 6. 卸载 / 回滚

```powershell
# 回滚到最近一次安装前的 profile 清单（并移除链接）
node scripts/install-profile.mjs restore

# 或直接卸载（移除链接 + bundles/dependencies 条目）
node scripts/install-profile.mjs uninstall

# 查看状态（安装位置、是否已挂载、备份列表）
node scripts/install-profile.mjs status
```

之后重启一次 DSH。备份默认在：

```text
<profile>\.dsh-xmind-mindmap-backups\backup-<时间戳>\
```

## 7. 自检（可选）

在插件目录运行：

```powershell
node --test test/*.test.js
```

应为 **183 项全部通过**，其中包括：Markdown↔树映射、ZIP/XML 双格式解析、
编辑语义、路径/覆盖安全、聊天卡片渲染、右侧预览注册与浏览器端解析（与宿主解析器逐层比对）。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| `profile manifest not found` | `--profile-dir` 指到包含 `package.json` 的 `profiles\<名字>` 目录 |
| 重启后插件页没有 XMind 导图 | 检查 profile `package.json` 的 `dsh.profile.bundles` 是否含 `dsh-xmind-mindmap`；重新 `apply` |
| 右侧仍显示“该格式文件暂时无法预览” | 先按 `Ctrl+R` 刷新界面；仍不行则重启 DSH（客户端模块在页面启动时加载） |
| 聊天里没有 4 个工具 | 重启 DSH；确认插件行已启用 |
| 移动了解压目录 | 重新执行 `apply`（旧链接会指向旧位置） |
| 多 Sheet 的 `.xmind` 无法编辑 | 这是安全限制：编辑多 Sheet 会丢失其他 Sheet，当前明确拒绝；查看/切换 Sheet 正常 |

## 9. 兼容性与安全

- 不依赖 Mermaid 渲染器：聊天卡片与右侧预览都用内置 SVG 绘制，同时保留 Mermaid 源码。
- 若部署环境无法 `import '@deepseek-ai/dsh-tools'`，插件自动使用内置的等价编译器；
  其 schema 输出与真实 `defineTool` 逐字节一致（有对照测试）。
- 所有工具只接受绝对路径、拒绝 `..` 穿越；输出文件已存在且内容不同会拒绝覆盖；
  原地编辑先读后写，文件被外部改动会拒绝写入；遵守 `exec.signal` 取消。
- 不保留文件句柄；工具注册不包 `ctx.effect`，卸载/热重载后无残留。
