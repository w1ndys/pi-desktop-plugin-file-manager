# 需求实施计划：用 VSCode 打开 / 在浏览器打开仓库

Feature Name: open-in-editor-and-remote

> 说明：本次实施**执行全部任务**（含测试与校验），子任务均无 `*` 标记。任务 1–3 完成 VSCode 一侧，5–6 完成仓库一侧，8–10 接界面；4、7、11 是检查点，做完停下等确认，不自动串到下一段。测试与校验沿用仓库既有惯例（`views-src/verify-*.mjs` + 桩宿主驱动真实 `main.js`），新脚本必须挂进 `pnpm verify` 串联命令。

- [x] 1. 扩展通道契约与类型（`views-src/src/lib/rpc.ts`）
  - 在 `channels`（L379）追加 `editorOpen: "fm.editor.open"` 与 `remoteOpen: "fm.remote.open"`；本文件是通道契约的唯一真相来源，任何一侧改字段都从这里开始。
  - 新增 `EditorOpenRequest` / `EditorOpenResponse`、`RemoteOpenResponse`，失败分支复用既有的 `Failure`（L108）形状。
  - `HelloResponse`（L151）追加 `editor: EditorCapability`（`binary: string | null`）；`ListResponse` 追加 `remote: RemoteCapability`，并定义 `RemoteReason = "noRepo" | "noRemote" | "notOpenable" | "noGit"`。
  - 覆盖 Requirement 1、3.3、2.1、4.11；`RemoteCapability` 的可用分支带 `url` 与 `host`，不可用分支带 `reason`。

- [x] 2. manifest 的权限、版本与元数据（`manifest.json`）
  - `permissions`（L35）在 `ui.view`、`fs.read` 之后追加 `shell.openExternal`；`fs` 段（L36）保持不动，不新增 `net.domains`。覆盖 Requirement 5.1、5.2。
  - `version`（L5）由 `0.8.2` 改为 `0.9.0`（新增用户可见能力，走 minor）。
  - `i18n` 的 `en`/`zh-CN` 两份 `description` 与 `safetyNotes` 各补一段：VSCode 由插件进程自己启动、只传经根内包含校验与凭据黑名单的绝对路径（POSIX 上参数数组直传 + `shell: false`；Windows 上 `code.cmd` 必须经 `cmd.exe`，改用显式构造的双引号命令串、`/d` 关 AutoRun、不传 `/v`，并拒绝含 `%` 的路径）；浏览器打开走宿主 `shell.openExternal` 并为此新增该权限、宿主另有 http/https/mailto 白名单作为第二道闸、只送规范化后的 `http(s)` 地址；两项都不写文件、不写仓库、插件自己不发起网络请求。覆盖 Requirement 5.1–5.6。

- [x] 3. 主进程：VS Code 命令行的探测与启动（`main.js`）
  - [x] 3.1 实现 `resolveEditorBinary()`：只在 `PATH` 上查找
    - 取 `process.env.PATH`，按平台分隔符（POSIX `:`、Windows `;`）切分，逐个目录查找可执行文件。
    - **不做任何兜底**：不写死 `/Applications/Visual Studio Code.app/…`、`/opt/homebrew/bin/code`、`/snap/bin/code` 这类安装路径，不读注册表或应用清单。找不到就是找不到。覆盖 Requirement 2.1、2.5。
    - 命中判定：POSIX 用 `fs.access(binary, X_OK)`；Windows 上 `code.cmd` 没有执行位，`fs.stat` 判存在且是文件即可。**不真正启动进程**去问 `--version`。
    - Windows 上找的是 **`code.cmd`**（大小写不敏感）；仅存在 `Code.exe` 而 `PATH` 上没有 `code.cmd` 时判为未找到。覆盖 Requirement 2.7。
    - 探测结果（命中路径或 `null`）按插件进程缓存一次：进程的 `PATH` 生命周期内不变，改 `PATH` 需重新加载插件。覆盖 Requirement 2.2。

  - [x] 3.2 新增 `spawnDetached(binary, target)` 与两个可单测的纯函数
    - POSIX：`spawn(binary, [target], { detached: true, stdio: "ignore", windowsHide: true, shell: false })` 后 `child.unref()`；参数是数组、不经 shell，路径里的空格、`$(…)`、反引号、换行都只是普通字符。覆盖 Requirement 1.3、5.3。
    - Windows：`code.cmd` 是批处理文件，`CreateProcess` 不能直接执行它（`shell: false` 直接 spawn 会以 `EINVAL` 失败），必须 `spawn(comSpecPath(), ["/d", "/s", "/c", windowsCommandLine(binary, target)], …)`；`ComSpec` 优先、回退 `<SystemRoot>\System32\cmd.exe`，两者都拿不到时按 `EDITOR_UNAVAILABLE` 失败，不猜别的解释器。覆盖 Requirement 1.3、2.7。
    - 两个纯函数：`windowsCommandLine(codeCmd, target)` 拼命令串（两个路径各自双引号包裹），`isUnsafeForCmd(target)` 判 `%`。它们导出到 `internals`，好在任何平台上单测。覆盖 Requirement 5.3。
    - 两种分支都保留 `shell: false` 在 spawn 调用上（不让 Node 从参数数组拼命令串）；`/d` 关掉 AutoRun、不传 `/v` 保持延迟展开关闭（`!` 是字面量）。覆盖 Requirement 5.3。
    - 5 秒超时兜底：超时判失败但**不 kill**（进程已交给系统）。覆盖 Requirement 1.4。
    - spawn 用惰性 require 拿（照 `gitSpawnFn` L745 的降级写法），拿不到时返回可识别的失败而不是抛出未捕获异常。

  - [x] 3.3 新增 `handleEditorOpen(payload)`
    - `payload.path` 省略或为空串时按基点文件夹自身处理（`path: ""`）；路径一律经 `resolveInsideRoot`（L261）并传 `allowRoot: true`，复用它的根内包含、凭据黑名单与 realpath 逃逸校验。覆盖 Requirement 1.1、1.2、1.5、1.6。
    - `PATH` 上没有可执行文件时抛 `EDITOR_UNAVAILABLE`，message 要点名 `PATH` 与 `code`（如 `the code command is not on PATH`），不要只说「找不到 VS Code」；启动失败（ENOENT / EACCES）折算成同一 code；两者都不允许静默成功。覆盖 Requirement 1.7、2.4、2.6。
    - Windows 分支：目标路径含 `%` 时抛 `EDITOR_UNSUPPORTED_PATH` 且不 spawn（`%VAR%` 会被 `cmd.exe` 展开，双引号屏蔽不掉）。覆盖 Requirement 5.3。
    - 成功返回 `{ ok: true, path: abs, binary }`。

  - [x] 3.4 在 `views-src/verify-remote.mjs` 中建立脚本骨架与门禁接线，并补上探测相关的判定用例
    - 新建 `views-src/verify-remote.mjs`，沿用 `verify-git.mjs` 的 `check(label, condition, detail)` 与退出码约定；在 `views-src/package.json` 的 `scripts` 里增加 `"verify:remote"` 并把 `node verify-remote.mjs` 挂进既有的 `verify` 串联命令末尾。
    - 端到端需要换探测结果时，先 `delete require.cache[require.resolve(pluginMain)]` 再重新 `require`：`editorBinary` 是进程级缓存，同一次加载里改不了。
    - 观测 spawn 的做法：在临时目录写一个可执行的假 `code` 脚本（把 `process.argv.slice(2)` 逐行追加到日志文件），把该目录放在 `PATH` 最前之后 `onLoad`；断言改为读日志文件。**不需要**为测试在 `main.js` 里加专用钩子。Windows 上假脚本要命名为 `code.cmd`（批处理文件），断言的是 `cmd.exe` 收到的 `argv[3]` 恰为 `windowsCommandLine` 的输出；这条只在 Windows 上跑。
    - 用例（一）命中：PATH 最前放假的 `code` 脚本时 `fm.hello` 的 `editor.binary` 非空。
    - 用例（二）未命中：把 `PATH` 指向一个不含 `code` 的空目录时 `editor.binary === null`、`fm.hello` 照旧成功返回，且 `fm.editor.open` 返回 `EDITOR_UNAVAILABLE`，其 message 里出现 `PATH`。覆盖 Requirement 2.1、2.3、2.4、2.6。
    - 用例（三）不做兜底：在机器确实装了 VS Code 的前提下清空 `PATH`，断言仍判为未找到——证明插件没有绕过 `PATH` 去猜安装位置。覆盖 Requirement 2.5。

  - [x] 3.5 端到端用例：参数安全与项目根
    - 建一个名字含空格、`;`、`$()`、反引号的目录，请求打开它，断言假 `code` 收到的参数与该名字**逐字节相等**。覆盖 Requirement 1.3、5.3。
    - 断言 `fm.editor.open` 不传 `path` 时，目标是基点文件夹的本地绝对路径。覆盖 Requirement 1.2。
    - 断言传 `../outside.txt`、`.env`、`.ssh/id_rsa` 与指向根外的符号链接时全部被拒，且日志文件**没有新增行**（证明未发生 spawn）。覆盖 Requirement 1.6。
    - 含 `%` 的路径：POSIX 上照常打开（`%` 只是普通字符），Windows 上由 3.3 拒绝——后者用 `isUnsafeForCmd` 的纯函数断言覆盖。覆盖 Requirement 5.3。

  - [x] 3.6 性质测试：通道只接受基点内的路径（对应 Correctness Property 1）
    - 对随机生成的越界路径 / 凭据名字 / 逃逸链接，断言 `handleEditorOpen` 一律拒绝且不产生 spawn 记录。覆盖 Requirement 1.6。
    - 顺带钉住输入面：**绝对路径一律被 `ABSOLUTE_PATH` 拒掉**（含「绝对路径形式的基点自身」）。这条通道只接受基点相对路径，是有意的窄契约，不是遗漏——理由是 Requirement 1.5，且它会启动外部程序，输入面越窄越好。**不要**为了让绝对路径能通过而去改 `main.js`。

  - [x] 3.7 性质测试：参数不经 shell（对应 Correctness Property 2）
    - 对随机生成的合法条目名（含各种 shell 元字符与不可打印字符），断言假 `code` 收到的参数与原名逐字节相等，即元字符从未被解释。覆盖 Requirement 1.3、5.3。
    - Windows 侧改成断言纯函数 `windowsCommandLine` 的输出：两个路径各自被一对双引号包裹、输出里除这两对引号外不再出现别的引号（引号跳不出去）；并断言含 `%` 的路径被 `isUnsafeForCmd` 拦下。覆盖 Requirement 5.3。

- [ ] 4. 检查点 - 确保所有测试通过,如有疑问请询问用户
  - 此时 VSCode 一侧应已可独立工作：`pnpm typecheck` 通过，`pnpm verify:remote` 通过，既有 `pnpm verify` 不回归。

- [ ] 5. 主进程：origin 地址规范化（`main.js`）
  - [ ] 5.1 实现纯函数 `normalizeRemoteUrl(raw)`
    - 返回 `{ ok: true, url }` 或 `{ ok: false, reason: "notOpenable" }`，不联网、不查 host 属于哪家托管服务，只做形态归一。
    - 处理顺序：① 含控制字符（`U+0000`–`U+001F`、`U+007F`）直接拒绝；② scp 形态 `user@host:path` 换成 `https://host/path`（与 `http://host:port` 的区分：`://` 之前不含 `/` 且冒号后不是纯数字）；③ `ssh://` / `git://` 换协议为 `https://` 并丢弃端口；④ `http://` / `https://` 保留原协议与端口；⑤ `file://` 与裸本地路径（`/`、盘符、UNC 开头）拒绝；⑥ 去掉结尾的 `/` 与结尾的 `.git`；⑦ 结果必须是可解析的 `http(s)` URL 且 host 非空。
    - 多级路径（如 `group/sub/repo`）原样保留；丢弃查询串与锚点。覆盖 Requirement 4.2–4.7、5.5。

  - [ ] 5.2 纯函数夹具
    - 覆盖设计文档列出的全部形态：`git@github.com:owner/repo.git`、`ssh://git@gitlab.com:2222/owner/repo.git`（端口丢弃）、`git://…`、`https://…`、`http://git.internal:8080/owner/repo.git`（协议与端口都保留）、自建 GitLab 的多级路径、结尾有无 `.git` 与 `/` 的各种组合、本地路径与 `file://`、含控制字符、空串、无 host、带查询串与锚点。覆盖 Requirement 4.2–4.7。

  - [ ] 5.3 性质测试：只产出 `http(s)` 绝对地址（对应 Correctness Property 3）
    - 对随机生成的输入串，断言输出要么被拒绝，要么是可解析的 `http(s)` URL 且 host 非空——不可能出现其它协议。覆盖 Requirement 4.7、5.5、5.6。

- [ ] 6. 主进程：打开仓库、列表判定与通道路由（`main.js`）
  - [ ] 6.1 实现 `remoteUrlFor(rootPath)`
    - 用既有的 `runGitCommand`（L834）跑只读的 `git remote get-url origin`（`maxBytes: 4096`），沿用 `GIT_OPTIONAL_LOCKS=0` / `GIT_TERMINAL_PROMPT=0` / `GIT_LITERAL_PATHSPECS=1` 与 5 秒超时。覆盖 Requirement 4.1、5.4。
    - 非仓库抛 `NO_REPO`、无 origin 抛 `NO_REMOTE`、git 缺失抛既有的 `GIT_UNAVAILABLE`、地址不可规范化抛 `REMOTE_NOT_OPENABLE`。覆盖 Requirement 4.8–4.10。

  - [ ] 6.2 实现 `remoteCapabilityFor(rootPath, snapshot)` 与其缓存
    - 复用 `handleList` 已经取到的 `snapshot`，不在同一次调用里再跑第二个 git 进程；「取 origin」这一步只在 `snapshot !== null` 时发起。
    - `snapshot === null` 时用 `gitBinary === null` 区分「机器上没有 git」（`noGit`）与「这个文件夹不是仓库」（`noRepo`）——这两种成因对应两句不同的用户提示。覆盖 Requirement 4.11。
    - origin 与规范化结果随 git 快照一起缓存（同一 TTL 2s），并随既有的 `invalidateGitSnapshots()` 一起作废。

  - [ ] 6.3 实现 `handleRemoteOpen()`
    - 无项目时抛 `NO_WORKSPACE`；经 `remoteUrlFor` 得到地址后只调 `pi.shell.openExternal(url)`，成功返回 `{ ok: true, url }`。
    - 宿主拒绝（`DISALLOWED_EXTERNAL_URL`）或任何异常一律由既有的 `toFailure` 折算成 `{ ok: false, code, message }`，绝不返回成功。覆盖 Requirement 3.1–3.3、3.5。

  - [ ] 6.4 `handleList`（L1518）追加 `remote` 字段
    - 在返回对象里追加 `remote: await remoteCapabilityFor(rootPath, snapshot)`，与既有的 `git: snapshot ? summarizeGit(snapshot) : { available: false }` 并列。覆盖 Requirement 4.11。
  - [ ] 6.5 注册通道与导出纯函数
    - `CHANNELS`（L2601）增加 `"fm.editor.open": handleEditorOpen` 与 `"fm.remote.open": handleRemoteOpen`。
    - `internals`（L2660）导出 `normalizeRemoteUrl`、`windowsCommandLine`、`isUnsafeForCmd`，供 `verify-remote.mjs` 直接断言；沿用既有「纯解析函数可以被单测」的注释约定。覆盖 Requirement 1、3、5.3。

  - [ ] 6.6 端到端用例：真实仓库的四种判定
    - 临时仓库加 `origin` → `fm.list` 的 `remote.available === true` 且 url 正确；改 `origin` 为本地路径 → `available: false, reason: "notOpenable"`；删掉 `origin` → `noRemote`；非仓库目录 → `noRepo`。覆盖 Requirement 4.8–4.11。

  - [ ] 6.7 端到端用例：宿主调用与拒绝
    - 桩宿主记录 `shell.openExternal` 收到的 URL，断言它等于规范化结果、且只被调用一次；桩宿主拒绝时断言 `fm.remote.open` 返回 `{ ok: false }` 而不是 `{ ok: true }`。覆盖 Requirement 3.2、3.3、3.5。

  - [ ] 6.8 性质测试：两个动作全程只读（对应 Correctness Property 4）
    - 对随机路径组合反复调用两条通道，断言仓库的 `.git` 内容与工作区文件在调用前后逐字节不变，且调用过的 git 子命令只有 `remote get-url`。覆盖 Requirement 4.1、5.4。

- [ ] 7. 检查点 - 确保所有测试通过,如有疑问请询问用户
  - 此时主进程一侧应已全部可测：`pnpm verify:remote` 通过，既有七个校验脚本不回归。

- [ ] 8. 视图调用层（`views-src/src/lib/`）
  - [ ] 8.1 `hostActions.ts` 追加 `openInEditor(path?)`
    - 既有两条（`openWithDefaultApp` / `revealInFileManager`）保持不动；复用同一个错误折算惯例（`{ ok: false }` 与异常统一抛错），调用方只写一个 `catch`。覆盖 Requirement 1.1、2.4。
  - [ ] 8.2 新增 `remoteOpen.ts`，导出 `openRepoInBrowser()`
    - 单独成文件而不是塞进 `hostActions.ts`：后者的注释把「由宿主代为执行、受 `manifest.fs.read` 约束、只对文件有效」这份契约写死了，而本通道不受 `manifest.fs` 约束、也不只对文件有效。覆盖 Requirement 3.1。
  - [ ] 8.3 修掉两处因新增 `shell.openExternal` 权限而变成假话的既有注释
    - `views-src/src/lib/linkSafety.ts` 的文件头注释写着「本插件没有申报 shell.openExternal 权限」，`views-src/src/App.tsx` 的 `onLink` 上方注释（约 L976-977）同样这么写——任务 2 给 manifest 加上该权限之后，这两句话直接变成假话。行为不用改（`onLink` 仍只弹 toast），但理由必须重写：改成「本插件申报了 shell.openExternal，但预览里的链接仍不导航——视图一旦离开插件页面就回不来，所以点击的语义是把地址告诉用户」。
    - 顺带在 `App.tsx` 里搜一遍是否还有别处引用「没有 shell.openExternal」这个理由，一并改掉。

- [ ] 9. 视图菜单与状态（`views-src/src/App.tsx`）
  - [ ] 9.1 新增 `editorAvailable` 与 `remote` 两个状态
    - `editorAvailable` 从 `fm.hello` 的 `editor.binary` 推导，写在既有 `setWatchAvailable(hello.watch.available)`（L311）同一处。
    - `remote` 从 `fm.list` 响应取（`setRemote(response.remote)`），与既有的 `setGitSummary(response.git)`（L370）同构、放在同一个 `useCallback` 里。覆盖 Requirement 4.11、6.3、6.4。
  - [ ] 9.2 新增 `runEditorOpen(path?)` 与 `runRemoteOpen()`
    - 放在既有 `runHostAction`（L990）旁；失败走 `ui.showToast`，用各自专属的失败文案，不占用插件的错误横幅。覆盖 Requirement 6.5。
    - 两者都不得触碰当前打开的文件与未保存状态，也不得弹未保存确认框。覆盖 Requirement 6.6。
  - [ ] 9.3 `menuEntries`（L1016）追加一组分隔线与两个菜单项
    - 标签随目标切换（文件/目录为成员动作，空白处为项目动作）；`disabled` 分别跟 `editorAvailable` 与 `remote.available` 走，`hint` 在不可用时给出对应原因、可用时给出将打开的 host。覆盖 Requirement 6.1–6.4。
    - 文件 / 目录送**基点相对路径**，也就是树里那个 `target.path` 原样送出去（与 `fm.read` / `fm.delete` 送 `entry.path` 完全一致）；空白处右键时不传 `path`，交由主进程的 `currentRoot()` 解析成基点文件夹自身。**不要**用 `lib/roots.ts` 的 `hostActionPath`：那是给宿主代为执行的 `fs.openDefault` / `fs.reveal` 用的（宿主只收工作区相对路径、按主文件夹解析，所以基点不是主文件夹时必须送绝对路径）；本通道由插件自己解析路径，`resolveInsideRoot` 会以 `ABSOLUTE_PATH` 拒掉绝对路径（已实测）。覆盖 Requirement 1.2、1.5。
    - 两项都沿用既有菜单的键盘规则（`↑↓` / `Home` / `End` / `Enter` / `Escape`、禁用项跳过焦点），不需要改 `ContextMenu.tsx`。覆盖 Requirement 6.8。
  - [ ] 9.4 视图判定用例
    - 断言 `editor.binary === null` 与 `remote.reason` 的四种取值下，两个菜单项的 `disabled` 与 `hint` 文案正确；可用时不再禁用且给出 host。覆盖 Requirement 6.3、6.4。
    - 断言「空白处右键不带 path」与「文件右键送绝对路径」两条分支各自送出的参数。覆盖 Requirement 6.1、6.2。

- [ ] 10. 界面文案（`views-src/src/i18n.ts`）
  - [ ] 10.1 在 `COPY_TABLES`（L10）的 `en` 与 `zh` 两份里各追加 12 个键
    - `openInVSCode`、`openProjectInVSCode`、`editorUnavailable`、`editorOpenError`、`editorUnsupportedPath`、`openRemote`、`openRemoteHint`（带 `{host}` 占位）、`remoteNoRepo`、`remoteNoRemote`、`remoteNotOpenable`、`remoteNoGit`、`remoteOpenError`；文案逐条取设计文档 4.4 节的表（以该表为准，不要少键）。覆盖 Requirement 6.7。
  - [ ] 10.2 把新增键纳入既有的键位对齐断言
    - 在 `verify-remote.mjs` 里断言 en / zh 两份键集合完全一致，并断言上述 12 个键两种语言都有——沿用 `verify-git.mjs` 第 6 节既有的做法与理由（少一个中文键，界面上会突然冒一句英文，而 tsc 抓不到）。覆盖 Requirement 6.7。

- [ ] 11. 检查点 - 确保所有测试通过,如有疑问请询问用户
  - 此时功能应已完整：`pnpm typecheck` 与 `pnpm verify`（七个既有 + `verify:remote`）全部通过。

- [ ] 12. 回归核对与元数据同步
  - [ ] 12.1 核对既有校验脚本对 `fm.list` 新形状的断言
    - `verify-jail.mjs` 与 `verify-git.mjs` 里所有读 `fm.list` 响应的地方过一遍；新增字段是纯追加，不应有脚本失败，但若某个断言对响应对象做了整体比对就需要跟着更新。覆盖 Requirement 4.11 的回归面。
  - [ ] 12.2 降级不牵连的回归用例（对应 Correctness Property 7）
    - 断言 `editor.binary === null`、无 git、非仓库、无 origin 这四种降级各自发生时，列目录、读写、保存、删除、搜索与 `fm.watch` 的行为与改动前一致。覆盖 Correctness Property 7。
  - [ ] 12.3 同步 README 与 CHANGELOG
    - `README.md` 的「功能」一节补两个入口、「数据与安全」一节补 `shell.openExternal` 这次权限新增与两项动作的边界、「已知限制」一节写清三条：① 浏览器打开只落到仓库首页，不定位到具体文件；② 「用 VSCode 打开」要求 `code` 命令在 `PATH` 上，插件**不做安装位置兜底**（找不到就提示补 `PATH`，改了 `PATH` 需重新加载插件）；③ Windows 上插件调用的是 `code.cmd`，因此要经过 `cmd.exe`，含 `%` 的路径无法打开（`%VAR%` 会被展开）。
    - `CHANGELOG.md` 与 `manifest.json` 的 `changelog` 字段按仓库既有格式追加本版条目。

  - [ ] 12.4 重新构建视图产物并把 `views/` 一起提交
    - `views/` 是**入库的构建产物**（README「开发」一节：产物输出到 `../views`，宿主加载 `views/index.html`），不是临时目录。任务 1、8、9、10 改的都是 `views-src/src/` 的源码，不重新构建的话宿主加载的仍是旧产物，面板里根本看不到新菜单项——功能等于没做。
    - 在 `views-src` 下跑 `pnpm build`（`vite build`，输出到 `../views`，`emptyOutDir: true` 会先清空），然后确认 `views/assets/index.js` 与 `views/index.html` 的变化一并提交。
    - 验证产物确实包含新代码：在 `views/assets/index.js` 里搜 `fm.editor.open` 与 `fm.remote.open` 两个字符串，必须命中。
