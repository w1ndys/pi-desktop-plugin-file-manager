# 需求文档：用 VSCode 打开 / 在浏览器打开仓库

Feature Name: open-in-editor-and-remote
Updated: 2026-10-12

## Introduction

本需求给「文件管理器」（插件 id `pi.file-manager`）增加两个**往外部程序递出去**的动作：

1. **用 VSCode 打开**——把当前项目、某个文件或某个目录交给本机的 VS Code（走它自己的命令行），用真正的 IDE 继续干活。
2. **在浏览器打开仓库**——把当前项目的 git 远程地址（`origin`）交给系统浏览器，直接落到那台托管服务的仓库首页。

两个动作都只做「把已经存在的东西指给另一个程序看」，不改动任何文件、不写入任何仓库状态、不自己发网络请求。它们与已有的「用默认应用打开」「在文件夹中显示」是同一类能力，区别只在于目标程序：那两个由**宿主**代为执行（`fs.openDefault` / `fs.reveal`），本需求这两个必须由**插件自己**完成——理由见设计与下方 Requirement 5。

本文件使用 EARS 模板（见 Glossary），规范关键词保留 `SHALL` 以保持可识别性，其余表述一律用中文。

## Glossary

- **文件管理器 / 系统**：本插件，`pi.file-manager`，运行在 PI-Desktop 右侧工作面板中的视图 + 它自己的主进程。
- **基点文件夹（base folder root）**：当前项目里被选中作为包含基点的那个本地文件夹。项目可以注册多个文件夹（`workspace.get` 的 `roots`），任一时刻只有**一个**是基点，路径校验一律相对基点文件夹解析。
- **项目根（project root）**：基点文件夹的目录本身（视图入口的 `""` 路径）。
- **条目（entry）**：文件列表里的一个文件或目录。
- **本地绝对路径**：操作系统层面的绝对路径（POSIX 以 `/` 开头；Windows 以盘符或 UNC 前缀开头）。
- **VS Code 命令行（`code`）**：VS Code 安装时随附的命令行入口。macOS / Linux 上是无扩展名的可执行脚本 `code`；Windows 上是批处理文件 `code.cmd`（因此必须经 `cmd.exe` 启动）。本插件**只在 `PATH` 上查找它**，不探测安装目录、不猜测安装路径。
- **origin 远程地址**：`git remote get-url origin` 给出的字符串。形态不唯一，可以是 `git@github.com:owner/repo.git`（scp 形态）、`ssh://…`、`https://…`、`git://…`，也可能是本地路径。
- **仓库首页**：把 origin 远程地址规范化成 `https://<host>/<owner>/<repo>` 之后的地址。
- **EARS 模式**：
  - **Ubiquitous（普遍）**：「系统 SHALL …」
  - **Event-Driven（事件驱动）**：「WHEN <触发>，系统 SHALL …」
  - **State-Driven（状态驱动）**：「WHILE <状态>，系统 SHALL …」
  - **Unwanted-Behavior（非期望行为）**：「IF <条件>，系统 SHALL 拒绝 / 提示 …」
  - **Complex（复合）**：「WHERE / WHILE / WHEN 组合，系统 SHALL …」

## Requirements

### Requirement 1：用 VSCode 打开目标

**User Story:** 作为正在面板里翻项目的用户，我想点一下就让 VS Code 打开我正在看的文件或整个项目，这样我不用手抄路径再切窗口。

#### Acceptance Criteria

1. WHEN 用户在文件或目录的右键菜单里选择「用 VSCode 打开」，系统 SHALL 以该条目的本地绝对路径启动 VS Code 命令行。
2. WHEN 用户在文件列表空白处选择「用 VSCode 打开项目」，系统 SHALL 以基点文件夹的本地绝对路径启动 VS Code 命令行。
3. WHEN 系统启动 VS Code 命令行，系统 SHALL 把目标路径作为**单独一个参数**传递：在 POSIX 平台上以参数数组、`shell: false` 启动可执行文件；在 Windows 上通过 `cmd.exe /d /s /c` 启动 `code.cmd`，并把可执行文件路径与目标路径各自用双引号包裹。
4. WHEN VS Code 命令行已成功启动，系统 SHALL 在 5 秒内返回成功响应，且 SHALL 不等待该进程结束。
5. WHEN 视图拿到的条目路径是相对基点文件夹的路径，系统 SHALL 在主进程内把它解析成相对基点文件夹的本地绝对路径。
6. IF 目标路径解析后落在基点文件夹之外，或者命中凭据类路径黑名单（`.env*`、`.ssh/`、`.aws/`、`*.pem`、`.git/**` 等既有名单），系统 SHALL 以失败响应拒绝该请求，且 SHALL 不启动任何进程。
7. IF 系统无法启动 VS Code 命令行，系统 SHALL 以失败响应把原因交回视图。

### Requirement 2：VS Code 命令行的 PATH 探测与缺失提示

**User Story:** 作为没装 VS Code、或装了但没把它的命令行加进 `PATH` 的用户，我希望这个入口明确告诉我 `PATH` 里缺什么，而不是点了没反应，也不是插件悄悄替我猜一个安装路径去打开别的东西。

#### Acceptance Criteria

1. WHEN 插件加载，系统 SHALL 在 `PATH` 环境变量列出的各个目录中探测 VS Code 命令行，并 SHALL 把探测结果放进首次握手响应（`fm.hello`）。
2. WHEN 系统探测到 VS Code 命令行，系统 SHALL 在本次插件进程生命周期内记住该可执行文件路径。
3. WHILE 探测结果表示未找到 VS Code 命令行，系统 SHALL 把「用 VSCode 打开」渲染为不可用状态，并 SHALL 给出可读的原因文案。
4. IF 视图在未找到命令行的情况下请求打开，系统 SHALL 以 `EDITOR_UNAVAILABLE` 失败响应拒绝，并 SHALL 附带原因文案。
5. IF 系统在 `PATH` 列出的各个目录中都没有找到可用的 VS Code 命令行，系统 SHALL 判定为未找到，并 SHALL 不尝试任何其它安装位置、不读取注册表或应用清单、不猜测安装路径。
6. WHEN 系统判定未找到，系统 SHALL 在原因文案中说明是 `PATH` 环境变量里没有 `code` 命令，并 SHALL 说明补救方式是把 VS Code 的命令行目录加入 `PATH`。
7. WHEN 系统在 Windows 上探测，系统 SHALL 查找 `code.cmd`，并 SHALL 通过 `cmd.exe /d /s /c` 启动它（`code.cmd` 是批处理文件，Windows 的 `CreateProcess` 不能直接执行）。

### Requirement 3：在浏览器打开仓库首页

**User Story:** 作为想看看这个仓库在 GitHub / GitLab 上长什么样的用户，我想在右键菜单里直接把仓库首页打开，而不是自己去翻 `.git/config`。

#### Acceptance Criteria

1. WHEN 用户在文件、目录或列表空白处选择「在浏览器打开仓库」，系统 SHALL 打开当前项目 origin 远程地址所对应的仓库首页。
2. WHEN 系统打开该地址，系统 SHALL 请求宿主代为执行（`shell.openExternal`），且 SHALL 只传递 `http://` 或 `https://` 形式的地址。
3. WHEN 打开成功，系统 SHALL 把实际打开的地址返回给视图，供提示使用。
4. WHEN 用户选择的条目是文件、目录或项目根中的任意一种，系统 SHALL 打开同一个仓库首页。
5. IF 宿主拒绝该地址（`DISALLOWED_EXTERNAL_URL`）或调用失败，系统 SHALL 以失败响应回传，且 SHALL 不向视图谎称已打开。

### Requirement 4：远程地址的取得与规范化

**User Story:** 作为仓库从 SSH 形态克隆的用户，我希望不管 remote 写成哪种形态，点一下都能落到正确的网页，而不是得到一条打不开的地址。

#### Acceptance Criteria

1. WHEN 系统需要 origin 远程地址，系统 SHALL 用只读的 git 子命令取得它，并 SHALL 不修改仓库状态。
2. WHEN 系统取得远程地址，系统 SHALL 按下表把它规范化成仓库首页：

   | 输入形态 | 例 | 结果 |
   |---|---|---|
   | scp 形态 | `git@github.com:owner/repo.git` | `https://github.com/owner/repo` |
   | `ssh://` | `ssh://git@gitlab.com/owner/repo.git` | `https://gitlab.com/owner/repo` |
   | `git://` | `git://github.com/owner/repo.git` | `https://github.com/owner/repo` |
   | `https://` | `https://github.com/owner/repo.git` | `https://github.com/owner/repo` |
   | `http://` | `http://git.internal/owner/repo.git` | `http://git.internal/owner/repo` |
   | 本地路径 / `file://` | `/Users/x/repo`、`file:///srv/repo` | 不可打开 |

3. WHEN 规范化远程地址，系统 SHALL 去掉结尾的 `.git` 后缀与结尾的 `/`。
4. WHEN 规范化采用 scp 形态或 `ssh://`、`git://` 形态，系统 SHALL 把协议替换为 `https://`，并 SHALL 丢弃其中的端口号（SSH 端口与 HTTPS 端口无关）。
5. WHEN 规范化采用 `http://` 或 `https://` 形态，系统 SHALL 保留原协议与端口。
6. IF 远程地址含有控制字符（`U+0000`–`U+001F`、`U+007F`），系统 SHALL 拒绝该地址。
7. IF 远程地址无法规范化成 `http://` 或 `https://` 形式的地址，系统 SHALL 以 `REMOTE_NOT_OPENABLE` 失败响应拒绝，并 SHALL 给出可读原因。
8. IF 基点文件夹不是 git 仓库，系统 SHALL 以 `NO_REPO` 失败响应拒绝。
9. IF 仓库没有配置 `origin`，系统 SHALL 以 `NO_REMOTE` 失败响应拒绝。
10. IF 系统在机器上找不到 git，系统 SHALL 以 `GIT_UNAVAILABLE` 失败响应拒绝，且 SHALL 不影响列目录与读写等其它功能。
11. WHEN `fm.list` 返回一个目录的内容，系统 SHALL 同时给出「当前基点文件夹能否打开仓库首页」的判定结果与不可用原因，供菜单渲染。

### Requirement 5：权限与安全边界

**User Story:** 作为安装这个插件的用户，我希望这两个新入口不多要任何一项用不着的权限，也不把仓库里那些不可信的字符串直接喂给系统程序。

#### Acceptance Criteria

1. WHEN 插件声明权限，系统 SHALL 只新增 `shell.openExternal` 一项，且 SHALL 继续沿用既有的 `ui.view` 与 `fs.read`。
2. WHILE 提供本需求的两个功能，系统 SHALL 保持不声明 `net.domains`，且 SHALL 不自行发起任何网络请求。
3. WHEN 系统启动 VS Code 命令行，系统 SHALL 只把校验通过的本地绝对路径作为目标传递；在 POSIX 平台上系统 SHALL 以参数数组送达（不经 shell 解释），在 Windows 上系统 SHALL 通过 `cmd.exe /d /s /c` 送达并把该路径用双引号包裹，且 SHALL 拒绝含有 `%` 的路径并 SHALL 不启动任何进程（`%VAR%` 在双引号内也会被展开）。
4. WHEN 系统调用 git 取得远程地址，系统 SHALL 沿用既有的只读约定：`GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_LITERAL_PATHSPECS=1`、5 秒超时、输出上限。
5. WHEN 系统把 origin 远程地址当作输入处理，系统 SHALL 把它视为不可信字符串，并 SHALL 在规范化过程中完成控制字符与协议两道校验。
6. WHEN 系统请求宿主打开网页地址，系统 SHALL 依赖宿主的协议白名单（仅 `http` / `https` / `mailto`）作为第二道闸。

### Requirement 6：入口与界面

**User Story:** 作为用键盘操作菜单的用户，我希望新入口和现有菜单项遵守同一套可达性规则，并且不能用的时候能直接看到原因。

#### Acceptance Criteria

1. WHEN 用户在文件或目录上打开右键菜单，系统 SHALL 在既有动作之后依次提供「用 VSCode 打开」与「在浏览器打开仓库」两项，并在两组动作之间保留分隔线。
2. WHEN 用户在列表空白处打开右键菜单，系统 SHALL 提供「用 VSCode 打开项目」与「在浏览器打开仓库」两项。
3. WHILE VS Code 命令行未找到，「用 VSCode 打开」这一项 SHALL 处于禁用状态，并通过悬停提示给出原因。
4. WHILE 当前基点文件夹无法打开仓库首页（不是仓库 / 没有 origin / 地址不可打开 / 没有 git），「在浏览器打开仓库」这一项 SHALL 处于禁用状态，并通过悬停提示给出对应原因。
5. WHEN 两个动作中的任意一个失败，系统 SHALL 通过宿主 Toast 给出该动作专属的失败文案，且 SHALL 不改变当前打开的文件与未保存状态。
6. WHEN 用户当前打开的文件有未保存改动，系统 SHALL 照旧执行这两个动作，且 SHALL 不弹出未保存确认框。
7. WHEN 系统新增界面文案，系统 SHALL 同时提供英文与中文两份，且两份的键集合 SHALL 一一对应。
8. WHEN 系统渲染新菜单项，系统 SHALL 沿用既有的菜单键盘规则（`↑` `↓` / `Home` / `End` / `Enter` / `Escape`、禁用项跳过焦点）。
