/**
 * 用 VS Code 打开（0.9.0）：`code` 探测、启动参数与路径守卫的离线校验。
 *
 * 四组，对应 tasklist 的 3.4 / 3.5 / 3.6 / 3.7：
 *   ① 探测：只认 PATH——命中（PATH 最前放一个假的 code 命令行）、未命中（PATH 指向一个
 *      不含 code 的空目录）、不做安装位置兜底（本机装了 VS Code 也照样判未找到）。
 *   ② 参数安全与项目根：根内路径逐字节送达假脚本；省略 path 落到基点文件夹；
 *      越界 / 凭据 / 符号链接逃逸在 spawn 之前就被拒。
 *   ③ 性质：通道只接受基点内的路径（design.md Correctness Property 1）。
 *   ④ 性质：参数不经 shell（design.md Correctness Property 2），Windows 侧的命令串
 *      用纯函数断言。
 *
 * 观测手法：临时目录里写一个假的可执行脚本，它把自己收到的每个参数逐行追加到日志
 * 文件；把该目录放在 PATH 最前再加载 main.js，`resolveEditorBinary` 命中的就是它，
 * 绝不会真的启动 VS Code。日志是**异步**写的（spawnDetached 在子进程的 'spawn'
 * 事件上就返回），所以每次调用之后都要轮询日志直到长出新内容，不能调用完立刻断言。
 *
 * **硬闸（两个平台都要有，见 loadGuardedPlugin）**：假脚本的名字必须与
 * `resolveEditorBinary` 在**本平台**找的那个名字一致——POSIX 上是 `code`，Windows 上是
 * `code.cmd`。名字一旦对不上，探测就会落空，后面的调用会沿 PATH 命中用户机器上**真实的**
 * code 命令，在跑测试的人机器上真的打开 VS Code，而脚本自己不会因此停下。所以每个会走到
 * spawn 的小节开头都先核对 `fm.hello` 报的 `editor.binary` 是不是我们亲手造的那个假脚本；
 * 不是就整节跳过并打印 SKIP，**绝不**继续调用 `fm.editor.open`。
 *
 * 跳过要看得见：每一处 SKIP 都会打印，最后的汇总行带上跳过数（例如
 * `REMOTE VERIFY PASSED (skipped 2)`）。平台差异导致的跳过不算失败、不改退出码，
 * 但静默跳过等于那一项零覆盖，必须能一眼看见。
 *
 * 用法：pnpm verify:remote
 */

import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginMain = join(here, "..", "main.js");
const require = createRequire(pluginMain);

/** 断言失败的条数：只有 0 才让脚本以退出码 0 结束。 */
let failures = 0;
/** 跳过的条数：只进汇总行，不影响退出码（平台差异是合法的）。 */
let skips = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label} ${detail}`);
}

/**
 * 记一次跳过。
 *
 * 跳过是合法的平台差异（建不了符号链接、机器没装 VS Code、Windows 不允许某个条目名），
 * 但静默跳过等于那一项在 CI 上零覆盖，所以每一处都要打印，并且进汇总行的计数。
 */
function skip(label) {
  skips += 1;
  console.log(`  SKIP ${label}`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 纯函数断言用第一份加载的实例；端到端部分每次换 PATH 都会重新加载，见 loadPlugin。 */
const { internals } = require(pluginMain);

/** 本次校验自己的临时目录：假脚本、假脚本日志、临时项目都住在它下面。 */
const base = mkdtempSync(join(tmpdir(), "pifm-remote-"));
/** 假脚本所在的目录：唯一被塞到 PATH 最前的目录。 */
const fakeDir = join(base, "fake-bin");
/**
 * 宿主原本的 PATH：模块加载时抄下来，此刻还没有任何代码碰过 process.env.PATH。
 * 两个用途——① 接在假目录之后，否则脚本里用到的工具会失效；② hasRealVsCodeCli 扫的就是它
 * （「本机装没装 VS Code 命令行」必须看真实 PATH，不能看后来被换成假目录的那一份）。
 */
const realPath = String(process.env.PATH ?? "");
/** 不含 code 的空目录：用来造「PATH 上没有 code」这一幕。 */
const emptyDir = join(base, "empty-bin");
/** 临时项目目录：桩宿主报给插件的基点文件夹。 */
const project = join(base, "project");
/** 项目之外的一个真实文件：越界与符号链接逃逸的目标。 */
const outsideFile = join(base, "outside.txt");
/** 假脚本的参数日志；这个绝对路径会被写死在假脚本里（见 makeFakeCode）。 */
const logPath = join(fakeDir, "code-args.log");
/** 假脚本的绝对路径：makeFakeCode 里赋值，硬闸与「参数逐字节送达」都要拿它比。 */
let fakeCodePath = "";
/** 符号链接建成功了吗：第二组建，第三组也要用同一条拒绝用例，所以标记放在模块级。 */
let symlinkOk = false;

/*
 * 拒绝类用例的固定清单。
 *
 * 每一条都带上规格定下的原因码（requirements.md Requirement 1.6 与 design.md 的错误
 * 处理表）：只查 `ok === false` 是守不住黑名单的——`.git/config`、`.ssh/id_rsa` 这些即
 * 便把凭据黑名单整个删掉，也会因为父目录不存在被 NOT_FOUND 拒掉，断言照样绿。
 *
 * 用固定清单而不是真随机：失败要能复现，用例要能一眼看懂。node_modules 刻意不在这里
 * ——read 模式下它不在黑名单里（只有写模式拒），而且它本来就在基点内，不属于「越界 /
 * 凭据」这一类，单独一条断言它。
 */

/** 越界类：含 `..` 段往上跑的判 ESCAPE，绝对路径判 ABSOLUTE_PATH。 */
const OUT_OF_ROOT_CASES = [
  { label: "越界被拒：../outside.txt", path: "../outside.txt", code: "ESCAPE" },
  { label: "越界被拒：../../outside.txt", path: "../../outside.txt", code: "ESCAPE" },
  { label: "越界被拒：../../../etc/passwd", path: "../../../etc/passwd", code: "ESCAPE" },
  { label: "越界被拒：sub/../../outside.txt", path: "sub/../../outside.txt", code: "ESCAPE" },
  { label: "越界被拒：sub/./../../outside.txt", path: "sub/./../../outside.txt", code: "ESCAPE" },
  { label: "越界被拒：..\\outside.txt", path: "..\\outside.txt", code: "ESCAPE" },
  { label: "绝对路径被拒：/etc/passwd", path: "/etc/passwd", code: "ABSOLUTE_PATH" },
  { label: "绝对路径被拒：/", path: "/", code: "ABSOLUTE_PATH" },
  { label: "绝对路径被拒：/tmp", path: "/tmp", code: "ABSOLUTE_PATH" },
  // 基点文件夹自身的绝对路径也要拒：这条通道只收基点相对路径（Requirement 1.5），
  // 「绝对路径恰好是基点」不是例外。
  { label: "绝对路径被拒：基点文件夹自身的绝对路径", path: project, code: "ABSOLUTE_PATH" },
];

/** 凭据类：原因码一律 DENIED_PATH（黑名单在父目录存在性检查之前生效）。 */
const CREDENTIAL_CASES = [
  ".env",
  ".env.local",
  ".env.production",
  ".git/config",
  ".git/HEAD",
  ".ssh/id_rsa",
  "keys/id_rsa",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  "server.pem",
  "private.key",
  ".aws/credentials",
  ".netrc",
  ".npmrc",
  ".gnupg/secring.gpg",
];

/** 合法条目名的固定清单：shell 元字符、不可打印字符、非 ASCII 各来几个。POSIX 上逐字节断言；
 *  Windows 上哪些名字没法用批处理记账断言，见 cmdBookkeepingBlocker。 */
const SHELL_META_NAMES = [
  "plain",
  "with space",
  "semi;colon",
  "sub$(whoami)",
  "back`tick`",
  "amp&ersand",
  "pipe|char",
  "redirect>out",
  "input<in",
  "bang!mark",
  "caret^char",
  "percent%char",
  "quote'dir",
  'double"quote',
  "new\nline",
  "中文目录",
  "hash#tag",
  "star*glob",
  "question?mark",
  "..hidden",
  "-",
  "&&",
];

/**
 * Windows 上这个条目名能不能靠批处理记账（`%~1` + `echo` 逐行写日志）逐字节断言？
 * 返回 null = 能，照常断言；返回字符串 = 不能，字符串就是原因，调用处据此单条 SKIP。
 *
 * 为什么会有损：假 `code.cmd` 的记账方式是「`%~1` 展开后整条 `echo` 进日志」，
 *   `^` 在 echo 里是转义符，会把紧跟的那个字符吃掉；
 *   `&`、`|`、`>`、`<` 在 `%~1` 替换之后仍被 cmd.exe 当命令分隔符 / 重定向符，根本到不了 echo；
 *   `%` 会被 cmd.exe 当变量引用展开（与第 2 节跳过「含 % 的路径」同源：main.js 的
 *   isUnsafeForCmd 在 Windows 上直接把含 `%` 的目标拒掉，那条断言不可能绿）；
 *   名字含换行会把一条 echo 拆成两行，日志的行结构跟预期对不上。
 * 这些都是「记账方式有损」，不是「平台不支持」：没法据它断言，所以只 SKIP、不放松断言。
 * POSIX 上假脚本走 /bin/sh 的 `printf '%s\n'`，不存在这层失真，这些名字全部照常逐字节断言。
 * `"`、`*`、`?` 刻意不列在这里：它们是 Windows 文件名非法字符，上面 mkdirSync 那一步就会
 * 失败并单条 SKIP，理由更贴切（「这个平台不允许的条目名」）。
 */
function cmdBookkeepingBlocker(name) {
  // 只有 Windows 走批处理记账；POSIX 上任何名字都没有这层失真，一律返回 null。
  if (process.platform !== "win32") return null;
  // 换行会让 `echo %~1` 变成两条日志行，"一行一个参数" 这个比对前提就不成立了。
  if (name.includes("\n") || name.includes("\r")) return "名字含换行，一条 echo 会被拆成两行";
  // `^` 是 cmd 的转义符：`echo caret^char` 会把紧跟的那个字符吃掉。
  if (name.includes("^")) return "`^` 在 echo 里是转义符，会吃掉紧跟的字符";
  // `&`、`|`、`>`、`<` 在 `%~1` 替换之后仍会被 cmd 当分隔符或重定向符。
  if (/[&|<>]/.test(name)) return "`&` `|` `>` `<` 在 %~1 替换之后仍被 cmd 当分隔符或重定向符";
  // 含 `%` 的名字会被 cmd.exe 展开成变量值；Windows 上含 `%` 的路径还被 isUnsafeForCmd 按设计
  // 拒掉，所以「能打开」这条断言在 Windows 上两条路都走不通（与第 2 节跳过「含 % 的路径」同源）。
  if (name.includes("%")) return "`%` 被 cmd.exe 展开、Windows 上按设计拒掉，断不了「能打开」（与第 2 节同源）";
  // 其余名字（普通名、含空格、`-`、中文目录、`..hidden`、`hash#tag`、`quote'dir`、`semi;colon`
  // 等不含上面这些字符的）在 Windows 上照样逐字节断言。
  return null;
}

/**
 * 造一个假的 code 命令行脚本，返回它的绝对路径。
 *
 * 脚本名跟着平台走，必须与 `resolveEditorBinary` 找的那个名字一致：非 Windows 叫 `code`，
 * Windows 叫 `code.cmd`（Windows 上探的是 `code.cmd`，写成 `code` 探测必然落空，接着
 * 就会命中用户机器上真实的 code 命令——这就是硬闸拦的那件事）。
 *
 * Windows 分支写的是批处理文件：`%~1` 取第一个参数（参数自带的外层引号被它去掉），
 * `shift` 逐个后移，`if "%~1"==""` 判参数取完，`echo` 负责在每行末尾补一个换行。
 * POSIX 分支写 `/bin/sh` 脚本，每个参数单独一行。
 *
 * 日志的绝对路径直接写死在脚本里，不用环境变量传：子进程的环境是从插件进程继承的，
 * 写死可以排除「环境没传对」这个变量，也让脚本本身能独立跑起来看出问题。
 */
function makeFakeCode() {
  // 平台同时决定脚本名与脚本格式，这两件事必须成对，否则硬闸必红。
  const isWindows = process.platform === "win32";
  const scriptPath = join(fakeDir, isWindows ? "code.cmd" : "code");
  // 批处理的行尾用 CRLF：cmd.exe 对纯 LF 的标签跳转不可靠。
  const eol = isWindows ? "\r\n" : "\n";
  const lines = [];
  if (isWindows) {
    lines.push(
      "@echo off",
      ":loop",
      // `%~1` 为空串 = 参数已经 shift 完，收工；没参数时也不该写出一条空行。
      'if "%~1"=="" goto :end',
      // 日志路径可能有空格，先引号包住再重定向；参数照原样写，自己不加引号。
      `>>"${logPath}" echo %~1`,
      "shift",
      "goto :loop",
      ":end",
      "",
    );
  } else {
    lines.push(
      "#!/bin/sh",
      // 每个参数单独一行：断言时只需看这段字节是否逐字节等于送进去的路径。
      `for a in "$@"; do printf '%s\\n' "$a"; done >> "${logPath}"`,
      "",
    );
  }
  writeFileSync(scriptPath, lines.join(eol));
  // POSIX 上判的是执行位，没有它就命中不了 resolveEditorBinary 的 X_OK 判定；
  // Windows 上判的是「存在且是普通文件」，批处理文件本来就没有执行位。
  if (!isWindows) chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** 读日志的原始字节；第一次 spawn 之前它还不存在，按空文件处理。 */
function readLog() {
  try {
    return readFileSync(logPath);
  } catch {
    // 还没生成 = 还没有任何参数被送达，正好是 0 长度。
    return Buffer.alloc(0);
  }
}

/**
 * 从 `from` 字节开始等日志长出新内容，返回当时的全量字节。
 *
 * 必须轮询的理由：spawnDetached 在子进程的 'spawn' 事件上就返回了，那一瞬间假脚本
 * 很可能还没执行到写日志那一行。等待有硬上限（默认 2s），超时就返回现状让断言判红，
 * 绝不无限等下去。
 */
async function waitForLogGrowth(from, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = readLog();
    if (current.length > from) return current;
    if (Date.now() > deadline) return current;
    await sleep(20);
  }
}

/**
 * 本机到底有没有装 VS Code 命令行？按平台扫**原始** PATH 的每个目录来判。
 *
 * 为什么不能只看安装位置：老写法查 `/Applications/Visual Studio Code.app` 与
 * `/usr/bin/code`，这两个位置在 Windows 上都不存在，判定恒为假，于是「装了 VS Code 但 PATH
 * 被清空 → 仍判未找到」这条（Requirement 2.5 唯一的手段）在 Windows 上恒定跳过。改成扫
 * PATH 之后，Windows 上只要有 `code.cmd` 就真跑这条用例，POSIX 上的结论也不变。
 *
 * 必须用 realPath（模块加载时抄下的那份原始 PATH）：脚本中途会把 process.env.PATH 换成
 * 假目录或空目录，那时再扫只会扫到自己造的假货。
 */
function hasRealVsCodeCli() {
  // 平台决定文件名：Windows 上 VS Code 的入口是 `code.cmd`，其它平台是 `code`。
  const fileName = process.platform === "win32" ? "code.cmd" : "code";
  for (const dir of realPath.split(delimiter)) {
    // 空片段（连续分隔符或结尾分隔符造成的）在 POSIX 里指当前目录；跳过它，
    // 免得把工作目录里恰好叫 code 的东西当成「本机装了 VS Code」。
    if (dir === "") continue;
    // 命中一个就算装了：这里只问「有没有」，PATH 的先后顺序不影响结论。
    if (isVsCodeCliIn(dir, fileName)) return true;
  }
  // 整个 PATH 扫完都没找到：当作本机没装，调用处跳过那条用例。
  return false;
}

/**
 * 某个目录里有没有可用的 VS Code 命令行？命中返回 true，没有返回 false。
 *
 * 两个平台的「可用」不同：非 Windows 上必须带执行位（与 resolveEditorBinary 的 X_OK 口径
 * 一致，没有执行位它也不会命中）；Windows 上批处理文件根本没有执行位，只判「存在且是普通
 * 文件」——判目录的话，恰好有个叫 code.cmd 的目录也会被误判成装了。
 */
function isVsCodeCliIn(dir, fileName) {
  const candidate = join(dir, fileName);
  // Windows 分支：只看是不是普通文件。
  if (process.platform === "win32") {
    try {
      return statSync(candidate).isFile();
    } catch {
      // 目录不存在 / 没权限 / 不是普通文件：当作这个目录里没有。
      return false;
    }
  }
  // 非 Windows 分支：存在且有执行位才算。
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    // 文件不存在或没有执行位：当作这个目录里没有。
    return false;
  }
}

/** 桩宿主共享的 workspace：改这里的 path 就等于换一个打开的项目。 */
const workspace = { path: project, name: "repo" };
/** 桩宿主共享的偏好容器；onLoad 会读它，写回时替换这个变量。 */
let settings = { fmPrefs: {} };

/**
 * 照 verify-git.mjs / verify-watch.mjs 的写法给 globalThis.pi 赋值。
 * 本次不需要 shell——「在浏览器打开」走的是 `fm.remote.open`，属于别的任务。
 */
function makeHost() {
  return {
    workspace: { get: async () => workspace },
    plugin: {
      getDataPath: async () => join(base, "data"),
      getSettings: async () => settings,
      setSettings: async (value) => {
        settings = value;
        return true;
      },
    },
    ui: { showToast: () => {} },
    fs: {},
  };
}

/**
 * 设好 PATH 后重新加载 main.js 并 onLoad，返回新实例。
 *
 * 为什么必须整份重载：`editorBinary` 是模块级缓存，进程内只探测一次；想在同一次运行
 * 里换「命中 / 未命中」两种结论，只能删掉 require.cache 里的那一份再 require——新
 * 实例的模块状态是全新的，桩宿主也得重新挂一遍（旧实例仍持有旧的 pi）。
 */
async function loadPlugin(pathValue) {
  process.env.PATH = pathValue;
  delete require.cache[require.resolve(pluginMain)];
  globalThis.pi = makeHost();
  const loaded = require(pluginMain);
  await loaded.onLoad();
  return loaded;
}

/**
 * 硬闸：加载「假脚本排在最前」的那份插件，并核对 `fm.hello` 报的 `editor.binary`
 * 就是我们亲手造的假脚本。
 *
 * 返回实例 = 可以安全调用 `fm.editor.open`；返回 null = 假脚本没被命中，此时**绝不能**
 * 再调 `fm.editor.open`——PATH 后面可能挂着用户真实的 code 命令，一调就真的在人家的机器
 * 上打开 VS Code。跳过会让这几组用例零覆盖，但比误启动安全；跳过数会进汇总行。
 */
async function loadGuardedPlugin() {
  const plugin = await loadPlugin(`${fakeDir}${delimiter}${realPath}`);
  const hello = await plugin.onPanelInvoke("fm.hello", {});
  const binary = hello.editor?.binary;
  // 命中就是那个假脚本：放心往下走。
  if (binary === fakeCodePath) return plugin;
  // 没命中：整节跳过，并把「命中了谁、期望谁」写清楚，方便判断是平台问题还是守卫坏了。
  skip(`假脚本没被命中（editor.binary = ${JSON.stringify(binary)}，期望 ${fakeCodePath}）：为避免启动真实的 VS Code 已跳过本节全部用例`);
  return null;
}

/**
 * 一条「必须被拒」的用例：`ok === false` 且原因码**恰好**是规格定的那一个。
 *
 * 必须钉住原因码：`.git/config`、`.ssh/id_rsa` 这类即使把凭据黑名单整个删掉，也会因为
 * 父目录不存在被 NOT_FOUND 拒掉——只查 `ok === false` 的断言守不住它声称守的黑名单。
 * 原因码取自 requirements.md Requirement 1.6 与 design.md 的错误处理表，不是从运行结果
 * 反推的；实测与表不符时不许改表，如实报出来。
 */
async function checkRefused(plugin, label, path, expectedCode) {
  const response = await plugin.onPanelInvoke("fm.editor.open", { path });
  check(`${label}（${expectedCode}）`, response.ok === false && response.code === expectedCode, JSON.stringify(response));
}

/**
 * 跑一批「必须被拒」的用例，再确认这批请求一条 spawn 记录都没产生。
 *
 * 主证据是每条的原因码——被拒就走不到 spawn，所以「没新增日志」只是补一刀：真的 spawn
 * 了的话写日志是异步的，必须等一小会儿（固定 200ms，有硬上限，不无限轮询）再比。
 * 两次读的字节数必须相等，方向只能更严不能更松。
 */
async function runRefusalBatch(plugin, cases) {
  const before = readLog().length;
  for (const item of cases) {
    await checkRefused(plugin, item.label, item.path, item.code);
  }
  await sleep(200);
  const after = readLog().length;
  check(`被拒的 ${cases.length} 条请求一条 spawn 记录都没产生`, after === before, `多了 ${after - before} 字节`);
}

/** 3.4 探测：命中 / 未命中 / 不做安装位置兜底。 */
async function verifyDetection() {
  console.log("1. 探测：只认 PATH（3.4）");

  // 命中：假目录排在最前，系统 PATH 接在后面。这两条也是硬闸的正面证据。
  let plugin = await loadPlugin(`${fakeDir}${delimiter}${realPath}`);
  let hello = await plugin.onPanelInvoke("fm.hello", {});
  check("PATH 上有 code → editor.binary 是非空字符串", typeof hello.editor?.binary === "string" && hello.editor.binary.length > 0, JSON.stringify(hello.editor));
  check("命中的就是 PATH 最前那个假脚本（硬闸）", hello.editor?.binary === fakeCodePath, `${hello.editor?.binary} !== ${fakeCodePath}`);
  // 闸门没通过：会触发启动的小节（2 / 3 / 4）在各自开头还会再查一次并整节跳过，这里先
  // 给出一条醒目的总提示。本节剩下的部分只往「没找到」走，不会启动任何东西。
  if (hello.editor?.binary !== fakeCodePath) {
    skip("假脚本没被命中：为避免启动真实的 VS Code，后面会触发启动的小节全部跳过");
  }

  // 未命中：PATH 只剩一个不含 code 的空目录。
  plugin = await loadPlugin(emptyDir);
  hello = await plugin.onPanelInvoke("fm.hello", {});
  check("PATH 上没有 code → editor.binary === null", hello.editor?.binary === null, JSON.stringify(hello.editor));
  check("探测失败不把握手搞崩（仍然 ok: true）", hello.ok === true, JSON.stringify(hello).slice(0, 200));
  const unavailable = await plugin.onPanelInvoke("fm.editor.open", { path: "" });
  check("强行调用 → EDITOR_UNAVAILABLE", unavailable.ok === false && unavailable.code === "EDITOR_UNAVAILABLE", JSON.stringify(unavailable));
  check("提示里点名 PATH（而不是「找不到 VS Code」）", String(unavailable.message ?? "").includes("PATH"), String(unavailable.message));

  // 不做兜底：只有本机确实装了 VS Code 命令行时这条才有证伪能力，没装就跳过不算失败。
  // 判定走 hasRealVsCodeCli()：按平台扫**原始** PATH，Windows 上也能真跑，不再恒定跳过。
  if (!hasRealVsCodeCli()) {
    skip("本机没装 VS Code 命令行（Requirement 2.5 的唯一手段）：「不做安装位置兜底」这一条跳过");
    return;
  }
  plugin = await loadPlugin("");
  hello = await plugin.onPanelInvoke("fm.hello", {});
  check("装了 VS Code 但 PATH 为空 → 仍判为没找到（没去猜安装位置）", hello.editor?.binary === null, JSON.stringify(hello));
}

/** 3.5 参数安全与项目根：根内逐字节送达、省略 path 落基点、越界与凭据在 spawn 前被拒。 */
async function verifyArgumentsAndRoot() {
  console.log("\n2. 参数安全与项目根（3.5）");
  // 硬闸：假脚本没被命中时这些调用会打到真的 code 命令上，整节不能跑。
  const plugin = await loadGuardedPlugin();
  if (!plugin) return;

  // 名字含空格、`;`、`$()`、反引号的目录：这些字符只要被 shell 解释过一次就会露馅。
  const nastyName = "with space; $(whoami) `date`";
  mkdirSync(join(project, nastyName), { recursive: true });
  // 含 `%` 的目录：POSIX 上只是普通字符，Windows 上由 isUnsafeForCmd 拦下。
  mkdirSync(join(project, "percent%name"), { recursive: true });
  writeFileSync(outsideFile, "outside\n");
  // 指向根外真实文件的符号链接：realpath 逃逸校验的主力用例；平台不给建就挂空，第二、
  // 三组里用到它的那两条一起跳过——不能在第三组里无条件断言它被拒（链接根本不存在）。
  try {
    symlinkSync(outsideFile, join(project, "escape-link.txt"));
    symlinkOk = true;
  } catch {
    symlinkOk = false;
  }

  let before = readLog().length;
  const openedNasty = await plugin.onPanelInvoke("fm.editor.open", { path: nastyName });
  let bytes = await waitForLogGrowth(before);
  check("含空格 / `;` / `$()` / 反引号的目录能打开", openedNasty.ok === true, JSON.stringify(openedNasty));
  check("假 code 收到的参数与该目录绝对路径逐字节相等", Buffer.from(`${resolve(project, nastyName)}\n`).equals(bytes.subarray(before)), JSON.stringify(bytes.subarray(before).toString("utf8")));

  // 省略 path（视图在空白处右键的那条分支）：目标是基点文件夹自身。
  before = readLog().length;
  const openedRoot = await plugin.onPanelInvoke("fm.editor.open", {});
  bytes = await waitForLogGrowth(before);
  check("省略 path → 目标就是基点文件夹", openedRoot.ok === true && openedRoot.path === project, JSON.stringify(openedRoot));
  check("假 code 收到的是基点文件夹的绝对路径", Buffer.from(`${project}\n`).equals(bytes.subarray(before)), JSON.stringify(bytes.subarray(before).toString("utf8")));

  // 空串与省略应当等价（主进程两条都归到「基点自身」）。
  before = readLog().length;
  const openedEmpty = await plugin.onPanelInvoke("fm.editor.open", { path: "" });
  bytes = await waitForLogGrowth(before);
  check("空串 path 与省略同义", openedEmpty.ok === true && Buffer.from(`${project}\n`).equals(bytes.subarray(before)), JSON.stringify(bytes.subarray(before).toString("utf8")));

  // 越界 / 凭据 / 符号链接逃逸：全部在 spawn 之前被拒，且原因码必须是规格定的那个。
  const refused = [
    { label: "越界被拒：../outside.txt", path: "../outside.txt", code: "ESCAPE" },
    { label: "凭据被拒：.env", path: ".env", code: "DENIED_PATH" },
    { label: "凭据被拒：.ssh/id_rsa", path: ".ssh/id_rsa", code: "DENIED_PATH" },
  ];
  // 符号链接没建出来（Windows 非开发者模式等）时这条挂空，不算失败，但要看得见。
  if (symlinkOk) {
    refused.push({ label: "符号链接逃逸被拒：escape-link.txt", path: "escape-link.txt", code: "SYMLINK_ESCAPE" });
  } else {
    skip("符号链接用例：这个平台不让建 symlink");
  }
  await runRefusalBatch(plugin, refused);

  // 含 `%` 的路径：POSIX 上只是普通字符，按普通目录打开；Windows 分支由纯函数覆盖。
  if (process.platform === "win32") {
    skip("含 % 的路径只在 POSIX 上判可打开：Windows 侧由 isUnsafeForCmd 的纯函数断言覆盖");
    return;
  }
  before = readLog().length;
  const percent = await plugin.onPanelInvoke("fm.editor.open", { path: "percent%name" });
  bytes = await waitForLogGrowth(before);
  check("% 在 POSIX 上只是普通字符（能正常打开）", percent.ok === true && Buffer.from(`${resolve(project, "percent%name")}\n`).equals(bytes.subarray(before)), JSON.stringify(percent));
}

/** 3.6 性质：通道只接受基点内的路径（Correctness Property 1）。 */
async function verifyInsideRootOnly() {
  console.log("\n3. 性质：通道只接受基点内的路径（3.6）");
  // 硬闸：同上一节，假脚本没被命中就不动这条通道。
  const plugin = await loadGuardedPlugin();
  if (!plugin) return;

  // 越界与凭据两批固定清单（见文件上方的 OUT_OF_ROOT_CASES / CREDENTIAL_CASES）。
  const cases = [...OUT_OF_ROOT_CASES];
  cases.push(...CREDENTIAL_CASES.map((path) => ({ label: `凭据被拒：${path}`, path, code: "DENIED_PATH" })));
  // 指向根外的符号链接：只有第二组建成功时链接才存在；平台不让建就跳过这一条。
  if (symlinkOk) {
    cases.push({ label: "符号链接逃逸被拒：escape-link.txt", path: "escape-link.txt", code: "SYMLINK_ESCAPE" });
  } else {
    skip("符号链接用例（指向根外的链接被拒）：这个平台不让建 symlink");
  }
  await runRefusalBatch(plugin, cases);

  // node_modules 是 read 模式的例外（黑名单只对写模式生效，见 main.js
  // WRITE_DENY_SEGMENTS）：它在基点之内，打开它与读它一样是允许的，
  // 所以这里断言的是「能打开」，不是「被拒」。
  mkdirSync(join(project, "node_modules"), { recursive: true });
  writeFileSync(join(project, "node_modules", "x.js"), "module.exports = 1;\n");
  const fromNodeModules = readLog().length;
  const inNodeModules = await plugin.onPanelInvoke("fm.editor.open", { path: "node_modules/x.js" });
  const bytes = await waitForLogGrowth(fromNodeModules);
  check("基点内的 node_modules 仍可打开（只有写模式拒它）", inNodeModules.ok === true && bytes.length > fromNodeModules, JSON.stringify(inNodeModules));
}

/**
 * 复刻 `cmd.exe /s` 的剥引号规则：命令串首尾都是双引号时，剥掉最外层那一对。
 *
 * 只在往返断言里用：spawnDetached 会先调 windowsCommandLine 拼出内层命令串，再在外面
 * 套一层引号交给 cmd.exe。这条性质保证「套一层再剥一层」逐字节回到原串，不多不少。
 */
function unwrapCmdS(command) {
  // 首尾不成对就什么都不剥，原样返回（cmd.exe 的规则也是如此）。
  if (command.length < 2 || !command.startsWith('"') || !command.endsWith('"')) return command;
  return command.slice(1, -1);
}

/** 3.7 性质：参数不经 shell（Correctness Property 2）。 */
async function verifyNoShell() {
  console.log("\n4. 性质：参数不经 shell（3.7）");
  // 硬闸：这一节大多数用例都要真启动编辑器，闸门没过就只跑纯函数断言。
  const plugin = await loadGuardedPlugin();

  if (plugin) {
    for (const name of SHELL_META_NAMES) {
      // Windows 上批处理记账有损的名字（`^` `&` `|` `>` `<` `%`、含换行的名字）：先查一遍，
      // 命中的单条 SKIP 并写明理由（理由见 cmdBookkeepingBlocker）。POSIX 上不拦，照常逐字节断言。
      const blocker = cmdBookkeepingBlocker(name);
      // 有 blocker = 这个平台上没法靠批处理记账断言，跳过这一条；跳过不等于放松断言。
      if (blocker) {
        skip(`Windows 批处理记账无法断言 ${JSON.stringify(name)}：${blocker}`);
        continue;
      }
      let created = true;
      try {
        mkdirSync(join(project, name));
      } catch {
        created = false;
      }
      // 平台不接受这个条目名（Windows 上的 `*` `?` `"` 之类）时只跳过这一条，不算失败。
      if (!created) {
        skip(`这个平台不允许的条目名：${JSON.stringify(name)}`);
        continue;
      }
      const from = readLog().length;
      const response = await plugin.onPanelInvoke("fm.editor.open", { path: name });
      const bytes = await waitForLogGrowth(from);
      const expected = Buffer.from(`${resolve(project, name)}\n`);
      check(
        `元字符照原样送达：${JSON.stringify(name)}`,
        response.ok === true && expected.equals(bytes.subarray(from)),
        `${JSON.stringify(bytes.subarray(from).toString("utf8"))} vs ${JSON.stringify(expected.toString("utf8"))}`,
      );
    }
  } else {
    skip("元字符逐字节送达用例：假脚本没被命中，为避免启动真实的 VS Code 已跳过");
  }

  // Windows 侧不需要真起 cmd.exe：命令串是纯函数拼的，任何平台都能断言。
  const codeCmd = "C:\\x\\code.cmd";
  const target = "C:\\a b\\c.txt";
  const commandLine = internals.windowsCommandLine(codeCmd, target);
  check("windowsCommandLine 把两个路径各自用双引号包住", commandLine === '"C:\\x\\code.cmd" "C:\\a b\\c.txt"', commandLine);
  check("整串里只有这两对引号（引号跳不出去）", (commandLine.match(/"/g) ?? []).length === 4, commandLine);
  // spawnDetached 会把上面这串整体**再套一层**引号交给 `cmd.exe /s`：层数只能是两层，
  // 多一层少一层都会让 cmd.exe 看见别的命令串。先钉住外层只有一对，再钉住往返可逆。
  const wrapped = `"${commandLine}"`;
  check("外面再套一层引号后恰好 6 个引号（只有一层外皮）", (wrapped.match(/"/g) ?? []).length === 6, wrapped);
  check(
    "cmd.exe /s 剥掉最外层那一对后逐字节回到 windowsCommandLine 的原输出",
    Buffer.from(unwrapCmdS(wrapped)).equals(Buffer.from(commandLine)),
    `${JSON.stringify(unwrapCmdS(wrapped))} vs ${JSON.stringify(commandLine)}`,
  );
  check("含 % 的路径被 isUnsafeForCmd 拦下", internals.isUnsafeForCmd("C:\\a%b\\c.txt") === true);
  check("含空格与 & 的普通路径不误伤", internals.isUnsafeForCmd("C:\\Program Files\\a&b\\c.txt") === false);
}

try {
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(emptyDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  fakeCodePath = makeFakeCode();

  await verifyDetection();
  await verifyArgumentsAndRoot();
  await verifyInsideRootOnly();
  await verifyNoShell();

  // 汇总行带上跳过数：跳过不算失败、不改退出码，但必须看得见（否则 CI 上是零覆盖）。
  const verdict = failures === 0 ? "REMOTE VERIFY PASSED" : `${failures} FAILURE(S)`;
  console.log(`\n${verdict}${skips > 0 ? ` (skipped ${skips})` : ""}`);
} finally {
  // 假脚本、日志与临时项目都要自己清掉（force 让「已经没了的」不报错）。
  rmSync(base, { recursive: true, force: true });
}

// 显式退出：即使还有句柄没释放，也不会把 npm 命令吊在这里。
process.exit(failures === 0 ? 0 : 1);
