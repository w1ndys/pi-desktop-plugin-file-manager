/**
 * 用 VS Code 打开 / 在浏览器打开仓库（0.9.0）：`code` 探测、启动参数与路径守卫、
 * origin 地址规范化的离线校验。
 *
 * 八组，对应 tasklist 的 3.4 / 3.5 / 3.6 / 3.7 / 5.2 / 5.3 / 6.6 / 6.7 / 6.8 / 9.4 / 10.2 / 12.2：
 *   ① 探测：只认 PATH——命中（PATH 最前放一个假的 code 命令行）、未命中（PATH 指向一个
 *      不含 code 的空目录）、不做安装位置兜底（本机装了 VS Code 也照样判未找到）。
 *   ② 参数安全与项目根：根内路径逐字节送达假脚本；省略 path 落到基点文件夹；
 *      越界 / 凭据 / 符号链接逃逸在 spawn 之前就被拒。
 *   ③ 性质：通道只接受基点内的路径（design.md Correctness Property 1）。
 *   ④ 性质：参数不经 shell（design.md Correctness Property 2），Windows 侧的命令串
 *      用纯函数断言。
 *   ⑤ origin 地址规范化（Requirement 4）：纯计算夹具 + 性质断言（design.md
 *      Correctness Property 3）。它不碰 PATH、不起进程，所以放在**第一个**执行：
 *      后面几组一旦因为假脚本没命中而整节跳过，这一组的证据仍然完整。
 *   ⑥ 真实仓库（6.6 / 6.7 / 6.8）：起真的临时仓库、改它的 origin，断言 `fm.list` 的
 *      `remote` 判定（可用 / 地址不可打开 / 没有 origin / 不是仓库 / 没有 git 五种成因
 *      各一次）、宿主 `shell.openExternal` 收到的地址与拒绝时的失败响应，以及性质
 *      「两个动作全程只读」（design.md Correctness Property 4）。本机没有 git 时整节跳过；
 *      Windows 上只跳过「git 子命令记录」那一条（假 git 包装器在那边造不出来）。
 *   ⑦ 视图调用层与菜单判定（9.4 / 10.2）：把 lib/hostActions.ts、lib/remoteOpen.ts 与
 *      i18n.ts 打成一份 ESM 直接 import 进来（用桩 bridge 观察视图往哪条通道送了什么样的
 *      payload），断言两个菜单项的 disabled 与 hint、「这一项送什么路径」的纯函数
 *      editorTargetPath、路径参数与中英键位对齐。它**不依赖**
 *      假脚本与 git，所以排得很靠后且必定执行。
  *
 *   ⑧ 降级不牵连的回归（12.2）：`editor.binary === null`、机器上没有 git、不是仓库、仓库没有
 *      origin 这四档降级各发生时，列目录 / 读 / 写 / 保存 / 删除 / 搜索与 `fm.watch` 都与
 *      全环境基线逐项一致（design.md Correctness Property 7）。
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

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * main.js 用来包住登录 shell PATH 的一对标记。从 internals 取，不写死字面量：
 * 假 shell 要按同一套标记产出，测试才不会与实现漂移。
 */
const MARK_START = internals.LOGIN_PATH_MARK_START;
const MARK_END = internals.LOGIN_PATH_MARK_END;

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
/**
 * 在**原始** PATH 上找真 git 的绝对路径；找不到返回 null（第 6 节整节跳过）。
 *
 * 为什么不用 "git" 这个名字：第 6.8 节要把一个假的 `git` 包装器挂在 PATH 最前，
 * 测试脚本自己调 git 时必须绕过它；而且插件会把 PATH 换成桩目录，脚本若跟着用
 * "git" 就会被自己的桩带走。绝对路径 + 模块加载时抄下的 PATH 两样都躲得开。
 *
 * 文件名按平台取：Windows 上真正的入口是 `git.exe`（PATH 搜索按 PATHEXT 匹配带扩展名
 * 的文件），只找没扩展名的 `git` 会一路落空、让整节在 Windows 上白跳过。
 */
function findRealGit() {
  // 平台决定候选文件名：POSIX 只有一个 `git`，Windows 是带扩展名的两个。
  const names = process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"];
  for (const dir of realPath.split(delimiter)) {
    // 空片段指当前目录，跳过（与 hasRealVsCodeCli 同一条理由）。
    if (dir === "") continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        // Windows 上 exe / 批处理都没有执行位，只看是不是普通文件。
        if (process.platform === "win32") {
          // 是普通文件就算命中；是目录的话 CreateProcess 起不来，跳过。
          if (statSync(candidate).isFile()) return candidate;
          continue;
        }
        // POSIX 靠执行位：没有执行位的那个即使存在也起不来。
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // 这个名字在这个目录里不可用，换下一个候选。
      }
    }
  }
  // 整个 PATH 都没有：调用处据此跳过第 6 节。
  return null;
}

/** 真 git 的绝对路径；null = 原始 PATH 上没有 git。 */
const realGit = findRealGit();

/**
 * 测试脚本自己调 git：用真 git 的绝对路径，不受插件桩 PATH 的影响。
 * 只在第 6 节用，那时已经确认 realGit 非 null。
 */
const git = (cwd, args) => execFileSync(realGit, args, { cwd, encoding: "utf8" });

/** 桩宿主共享的 workspace：改这里的 path 就等于换一个打开的项目。 */
const workspace = { path: project, name: "repo" };
/** 桩宿主共享的偏好容器；onLoad 会读它，写回时替换这个变量。 */
let settings = { fmPrefs: {} };

/** 桩宿主收到过的 `shell.openExternal` 地址（按调用次序）；每次重新加载插件时清空。 */
let openedExternalUrls = [];
/** 下一次 `shell.openExternal` 要不要像宿主拒绝那样抛错（6.7 的开关）。 */
let rejectExternal = false;

/**
 * 照 verify-git.mjs / verify-watch.mjs 的写法给 globalThis.pi 赋值。
 *
 * `shell.openExternal` 是「在浏览器打开仓库」唯一的出口（6.7）：桩宿主把收到的地址
 * 记进数组供断言，并且能按开关抛错，用来验证「宿主拒绝时通道绝不谎称成功」。
 * 每次重新加载插件都从干净的开局开始，免得上一节的记录混进来。
 */
function makeHost() {
  openedExternalUrls = [];
  rejectExternal = false;
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
    shell: {
      openExternal: async (url) => {
        // 先记账再判是否拒绝：调用次数是「只调一次」那条断言的全部依据。
        openedExternalUrls.push(url);
        // 宿主侧白名单拒掉时的真实表现：抛带 DISALLOWED_EXTERNAL_URL 的错误。
        if (rejectExternal) {
          throw Object.assign(new Error("blocked by the host allowlist"), {
            code: "DISALLOWED_EXTERNAL_URL",
          });
        }
      },
    },
  };
}

/**
 * 把一段文本包成 shell 单引号字面量（内嵌单引号按 POSIX 规则转义）。
 * 假 shell 要用它把 PATH 原样打印出来，免得值里的字符被 shell 解释一遍。
 */
function shellQuote(text) {
  return `'${text.split("'").join("'\\''")}'`;
}

/** 假 shell 的序号：每次要一个新的就 +1，同一次运行里互不覆盖。 */
let stubShellCount = 0;

/**
 * 造一个「假登录 shell」，顶替用户真正的那个。
 *
 * 为什么必须有它：探测的第二个来源是**登录 shell 的 PATH**。要是测试放着真的 SHELL 不管，
 * 「PATH 上没有 code」这类结论就会随本机装没装 code 而变（本机 PATH 里真有
 * `/opt/homebrew/bin/code` 就会命中），同一条断言在不同机器上时红时绿。假 shell 把这份输入
 * 变成测试完全可控的值——它只打印一段带标记的 PATH，main.js 传的 `-ilc` 参数直接忽略。
 */
function makeStubShell(printedPath) {
  stubShellCount += 1;
  const file = join(base, `stub-shell-${stubShellCount}`);
  // 标记文本从 internals 拿：假 shell 与 main.js 用同一对标记，测试不会与实现漂移。
  writeFileSync(file, `#!/bin/sh\nprintf '${MARK_START}%s${MARK_END}' ${shellQuote(printedPath)}\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * 造一个内容完全自定义的假 shell（用来打 loginShellPath 的失败路径）。
 * body 是脚本正文，调用方自己决定打印什么、退什么码、睡多久。
 */
function makeRawStubShell(body) {
  stubShellCount += 1;
  const file = join(base, `stub-shell-${stubShellCount}`);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * 设好 PATH（与登录 shell 的 PATH）后重新加载 main.js 并 onLoad，返回新实例。
 *
 * 为什么必须整份重载：`editorBinary` 是模块级缓存，进程内只探测一次；想在同一次运行
 * 里换「命中 / 未命中」两种结论，只能删掉 require.cache 里的那一份再 require——新
 * 实例的模块状态是全新的，桩宿主也得重新挂一遍（旧实例仍持有旧的 pi）。
 *
 * shellPathValue 是「用户登录 shell 的 PATH」：默认 null = 空的（等价于这个用户 PATH 里
 * 什么都没有，第二个来源也帮不上忙）；传字符串 = 那个用户 shell 的 PATH 长这样。
 */
async function loadPlugin(pathValue, shellPathValue = null) {
  process.env.PATH = pathValue;
  // 第二个来源也一并接管：否则它会去读**真实**登录 shell 的 PATH，结论随跑测试的机器而变。
  process.env.SHELL = makeStubShell(shellPathValue ?? "");
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
 *
 * extraDir 会插在假 code 目录之后：第 6.8 节还要把假的 `git` 包装器一起挂上，
 * 好在「只读」这条性质上多一层「git 只被问过 remote get-url」的证据。
 */
async function loadGuardedPlugin(extraDir = "") {
  // 两个桩目录都必须排在真实 PATH 之前，否则探测与 git 都会命中用户机器上真的那份。
  const prefix = extraDir ? `${fakeDir}${delimiter}${extraDir}${delimiter}${realPath}` : `${fakeDir}${delimiter}${realPath}`;
  const plugin = await loadPlugin(prefix);
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
  console.log("1. 探测：进程 PATH 优先（3.4）");

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

  // 不做安装位置兜底：把**两个来源都清空**（进程 PATH 与假登录 shell 的 PATH），
  // 即使本机真的装了 VS Code，也必须判为没找到。结论由假 shell 保证确定性，
  // 不再依赖「本机装没装」——旧写法靠 hasRealVsCodeCli() 决定跳不跳，机器不同结论就不同。
  plugin = await loadPlugin("", "");
  hello = await plugin.onPanelInvoke("fm.hello", {});
  check("两个 PATH 都为空 → 仍判为没找到（没去猜安装位置）", hello.editor?.binary === null, JSON.stringify(hello).slice(0, 200));
}

/*
 * 探测的第二个来源：登录 shell 的 PATH。
 *
 * 为什么单独一节：macOS 从 Dock 启动的 GUI 程序拿到的是 launchd 的默认 PATH
 * （`/usr/bin:/bin:/usr/sbin:/usr/sbin` 那一档），里面既没有 Homebrew 的
 * `/opt/homebrew/bin` 也没有 `/usr/local/bin`，而 `code` 通常就装在那儿——只认进程 PATH
 * 就等于让这个功能在 macOS 上默认不可用。这一节用假 shell 把「用户登录 shell 的 PATH」
 * 变成可控输入，顺带钉住解析与失败路径（噪音、没有标记、非 0 退出、超时、输出超限）。
 */
async function verifyLoginShellProbe() {
  console.log("\n1b. 登录 shell 的 PATH（第二个来源）");

  // 进程 PATH 里没有 code，但用户登录 shell 的 PATH 里有 → 应当命中后者。这是本次修复的核心。
  const fromShell = await loadPlugin(emptyDir, fakeDir);
  const shellHello = await fromShell.onPanelInvoke("fm.hello", {});
  check("进程 PATH 没有、登录 shell PATH 有 → 命中后者", shellHello.editor?.binary === fakeCodePath, JSON.stringify(shellHello.editor));

  // 两个来源都没有：装了 VS Code 的机器上也要走通。
  const neither = await loadPlugin(emptyDir, emptyDir);
  const neitherHello = await neither.onPanelInvoke("fm.hello", {});
  check("两个 PATH 都没有 code → 判为没找到", neitherHello.editor?.binary === null, JSON.stringify(neitherHello.editor));
  // 本机装没装只作为背景信息打印，不再是跳过条件（假 shell 已经把结论钉住了）。
  console.log(
    hasRealVsCodeCli()
      ? "  （本机确实装了 VS Code 命令行，上面这条「没找到」因此更有说服力）"
      : "  （本机没装 VS Code 命令行，上面这条对本机是空转）",
  );

  // 直接打 loginShellPath 的解析与失败路径。它不缓存，可以连着调。
  const noisy = makeRawStubShell(`printf 'loading rc...\\n'\nprintf '${MARK_START}%s${MARK_END}' '/one:/two'\nprintf 'done\\n'`);
  process.env.SHELL = noisy;
  const parsed = await internals.loginShellPath();
  check("rc 横幅在标记之外 → 仍能正确取出 PATH", JSON.stringify(parsed) === JSON.stringify(["/one", "/two"]), JSON.stringify(parsed));

  const noMark = makeRawStubShell(`printf '/one:/two'`);
  process.env.SHELL = noMark;
  check("没有标记 → null（输出不可信）", (await internals.loginShellPath()) === null);

  const failExit = makeRawStubShell(`printf '${MARK_START}%s${MARK_END}' '/one:/two'\nexit 3`);
  process.env.SHELL = failExit;
  check("非 0 退出 → null（输出不可信）", (await internals.loginShellPath()) === null);

  // 超时：用**绝对路径**的 sleep，这样既不依赖 PATH（前面几节把 PATH 换成了空目录，
  // 写 "sleep 30" 会因找不到命令立刻非 0 退出、测的其实不是超时），也保证它既不输出、
  // 也不自己退出——唯一的收敛途径就是超时，所以实测耗时必须接近上限。
  const sleepy = makeRawStubShell("/bin/sleep 30");
  process.env.SHELL = sleepy;
  const startedAt = Date.now();
  const timedOut = await internals.loginShellPath();
  const elapsed = Date.now() - startedAt;
  check("超时 → null", timedOut === null, JSON.stringify(timedOut));
  check(
    `超时确实等满上限才收敛（实测 ${elapsed}ms，上限 ${internals.LOGIN_SHELL_TIMEOUT_MS}ms）`,
    elapsed >= internals.LOGIN_SHELL_TIMEOUT_MS - 300 && elapsed < internals.LOGIN_SHELL_TIMEOUT_MS + 2000,
    `${elapsed}ms`,
  );

  // 输出超限：`/bin/cat /dev/zero` 会一直吐字节，同样不依赖 PATH、也不会自己退出。
  // 它必须在**超时之前**被输出上限掐掉——实测耗时明显小于上限才算走对了这条路径。
  const flood = makeRawStubShell("/bin/cat /dev/zero");
  process.env.SHELL = flood;
  const floodStartedAt = Date.now();
  const flooded = await internals.loginShellPath();
  const floodElapsed = Date.now() - floodStartedAt;
  check("输出超限 → null（不把内存吃满）", flooded === null, JSON.stringify(flooded));
  check(
    `输出超限早于超时收敛（实测 ${floodElapsed}ms < 上限 ${internals.LOGIN_SHELL_TIMEOUT_MS}ms）`,
    floodElapsed < internals.LOGIN_SHELL_TIMEOUT_MS - 500,
    `${floodElapsed}ms`,
  );

  // SHELL 指向不存在的路径 → 回退 zsh / bash；至少不能抛错。
  process.env.SHELL = join(base, "no-such-shell");
  const fallback = await internals.loginShellPath();
  check("SHELL 不存在时不抛错（回退到 zsh/bash）", fallback === null || Array.isArray(fallback), JSON.stringify(fallback)?.slice(0, 80));
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

/**
 * 5.2 的夹具表：输入 → 期望结果（`expected: null` = 必须被拒）。
 *
 * 形态与结果逐条取自 design.md 3.3 那张表与「层 1：纯函数夹具」清单；label 写的是
 * 这一条在钉什么规则，失败时不必回头翻文档。用固定清单而不是随机：失败要能复现。
 */
const REMOTE_URL_CASES = [
  { label: "scp 带 user", input: "git@github.com:owner/repo.git", expected: "https://github.com/owner/repo" },
  { label: "scp 不带 user", input: "github.com:owner/repo", expected: "https://github.com/owner/repo" },
  { label: "scp 多级路径（自建 GitLab）", input: "git@gitlab.company.com:group/sub/repo.git", expected: "https://gitlab.company.com/group/sub/repo" },
  { label: "scp 结尾 /", input: "git@github.com:owner/repo.git/", expected: "https://github.com/owner/repo" },
  { label: "ssh 带端口（端口丢弃）", input: "ssh://git@gitlab.com:2222/owner/repo.git", expected: "https://gitlab.com/owner/repo" },
  { label: "ssh 不带端口", input: "ssh://git@gitlab.com/owner/repo.git", expected: "https://gitlab.com/owner/repo" },
  { label: "git:// 换协议", input: "git://github.com/owner/repo.git", expected: "https://github.com/owner/repo" },
  { label: "https 去 .git", input: "https://github.com/owner/repo.git", expected: "https://github.com/owner/repo" },
  { label: "https 本来没有 .git", input: "https://github.com/owner/repo", expected: "https://github.com/owner/repo" },
  { label: "https 结尾 /", input: "https://github.com/owner/repo/", expected: "https://github.com/owner/repo" },
  { label: "https 结尾 .git 与 / 叠加", input: "https://github.com/owner/repo.git/", expected: "https://github.com/owner/repo" },
  { label: "http 保留协议与端口", input: "http://git.internal:8080/owner/repo.git", expected: "http://git.internal:8080/owner/repo" },
  { label: "http 不带端口", input: "http://git.internal/owner/repo.git", expected: "http://git.internal/owner/repo" },
  { label: "大写协议", input: "HTTPS://github.com/owner/repo.git", expected: "https://github.com/owner/repo" },
  { label: "userinfo 丢弃（token@）", input: "https://token@github.com/owner/repo.git", expected: "https://github.com/owner/repo" },
  { label: "userinfo 丢弃（user:pass@）", input: "https://user:pass@git.internal/o/r", expected: "https://git.internal/o/r" },
  { label: "查询串与锚点丢弃", input: "https://github.com/owner/repo?x=1#y", expected: "https://github.com/owner/repo" },
  { label: "首尾空白先剪掉（含结尾换行）", input: "  git@github.com:owner/repo.git \n", expected: "https://github.com/owner/repo" },
  { label: "本地绝对路径被拒", input: "/Users/x/repo", expected: null },
  { label: "file:// 被拒", input: "file:///srv/repo", expected: null },
  { label: "盘符路径被拒（反斜杠）", input: "C:\\Users\\x\\repo", expected: null },
  { label: "盘符路径被拒（正斜杠）", input: "C:/Users/x/repo", expected: null },
  { label: "UNC 路径被拒", input: "\\\\server\\share\\repo", expected: null },
  { label: "相对路径（无 host）被拒", input: "owner/repo", expected: null },
  { label: "空串被拒", input: "", expected: null },
  { label: "纯空白被拒", input: "   \t ", expected: null },
  { label: "单个 - 被拒", input: "-", expected: null },
  { label: "内嵌换行被拒", input: "git@github.com:owner/\nrepo", expected: null },
  { label: "内嵌 NUL 被拒", input: "https://github.com/owner/repo\u0000", expected: null },
  { label: "结尾 DEL 被拒", input: "git@github.com:owner/repo.git\u007f", expected: null },
  { label: "协议之外被拒（ftp://）", input: "ftp://github.com/owner/repo.git", expected: null },
  { label: "冒号后是纯数字（host:port，不是 scp）被拒", input: "git@github.com:2222/o/r", expected: null },
  { label: "只有 host 没有路径被拒", input: "git@github.com:", expected: null },
  { label: "只有 :// 被拒", input: "://", expected: null },
  { label: "只有协议被拒", input: "https://", expected: null },
  // 下面五条是给两道「零覆盖」守卫补的真输入：上面那些「无 host」「非网页协议」的条目
  // 要么被 URL 解析器自己拒掉、要么在 scp 分支就被改写成 `https://…`，从来没走到 main.js
  // 里的协议白名单与最终地址复验。这五条能穿透过去，把那两道守卫删掉就会变红。
  { label: "协议白名单：ftp 能解析出 host，但不是 http(s)/ssh/git 被拒", input: "ftp://github.com/owner/repo", expected: null },
  { label: "最终地址复验：ssh host 带百分号编码，换 https:// 后不可解析被拒", input: "ssh://a%20b/o/r", expected: null },
  { label: "多斜杠形态被拒：https:///owner/repo（解析器会把 owner 当 host）", input: "https:///owner/repo", expected: null },
  { label: "多斜杠形态被拒：ssh:///o/r（非 special scheme 同样多斜杠）", input: "ssh:///o/r", expected: null },
  { label: "多斜杠形态被拒：反斜杠形态（解析器把 \\ 也吃掉）", input: "https://\\\\owner\\repo", expected: null },
];

/**
 * 5.3 性质测试的固定输入清单（不用随机：失败要能复现）。
 *
 * 混的是各种畸形与极端写法，只为逼问同一个问题——输出会不会漏出非 http(s) 的东西。
 * 清单必须同时含有「该被接受」与「该被拒绝」两类，否则这条性质会退化成空话
 * （下面的第二条 check 就守着这一点）。
 */
const REMOTE_URL_PROPERTY_INPUTS = [
  // 空与纯空白。
  "",
  " ",
  "\t",
  "\n",
  "   \t \n ",
  // 只有分隔符与冒号：没有 host 可拼。
  "-",
  "--",
  ":",
  "::",
  ":::",
  "://",
  "//",
  "///",
  // 只有协议、连主机都没有（`http:` 这种非 special scheme 根本拼不出 host）。
  "http:",
  "https:",
  "http://",
  "https://",
  "ssh://",
  "git://",
  "ftp://",
  // `scheme://` 之后多一个斜杠：解析器会把路径第一段当 host（`https:///owner/repo` 解出
  // `https://owner/repo`，凭空捏造一个域名），现在由形态守卫拦下；非 special scheme 同理。
  "https:///owner/repo",
  "ssh:///o/r",
  // 只有主机名、没有路径，或者连主机都没有：没有主机可落，全部被拒。
  "owner/repo",
  "github.com",
  "github.com:",
  "git@github.com:",
  "git@:o/r",
  // 没有 `://`、冒号左边那段像主机名的串按 scp 读：`@github.com:o/r` 里 `@` 左边没有用户名，
  // host 取到 `github.com`，读成 `https://github.com/o/r`；`git:/o/r` 只有一个斜杠，host 取到
  // `git`，读成 `https://git/o/r`。后者是单标签主机、大概率打不开，但与 git 对 `host:path`
  // 的解释一致、也不指向别人的域名，所以不拦（拦了反而与 git 行为不一致）。
  "@github.com:o/r",
  "git:/o/r",
  // `host:port/path` 的写法：冒号后是纯数字，不是 scp。
  "git@github.com:2222/o/r",
  "git.internal:8080/o/r",
  // 冒号左边像主机名、又没有 `://`：这几条同样走 scp 分支，被读成 `https://<第一段>/<其余>`
  // （例如 `https://javascript/alert(1)`）。它们不是「非网页协议」——走到协议白名单那一句的
  // 只有带 `://` 的串；这里的结果是单标签主机的 https 地址，打不开但无害，所以不拦。
  "javascript:alert(1)",
  "data:text/html,<b>x</b>",
  "mailto:a@b.c",
  "vbscript:msgbox(1)",
  // Windows 盘符与 UNC：应被拒，且绝不能被读成 scp 的 host。
  "C:\\Users\\x\\repo",
  "C:/Users/x/repo",
  "c:\\repo",
  "\\\\server\\share\\repo",
  "file:///srv/repo",
  "file://C:/repo",
  // 内嵌控制字符（首尾空白之外的位置）。
  "git@github.com:o/\nrepo",
  "https://github.com/o/r\u0000",
  "https://github.com/o/r\u007f",
  "\u0001https://github.com/o/r",
  // host 里有非法字符与空格。
  "https://git hub.com/o/r",
  "git@git hub.com:o/r",
  // 超长输入。
  `https://github.com/${"a".repeat(5000)}.git`,
  `git@github.com:${"x/".repeat(2000)}repo.git`,
  // Unicode 域名：punycode 归一或直接拒绝都行，但结果不许是别的东西。
  "https://例え.jp/o/r.git",
  "git@例え.jp:o/r.git",
  // 大写协议、默认端口、多层结尾。
  "HTTPS://github.com/owner/repo.git",
  "HTTP://git.internal/o/r",
  "https://github.com/o/r.git.git",
  "https://github.com/o/r/.git",
];

/**
 * 结果串是不是 host 非空的 http(s) 绝对地址？是就返回解析结果，否则返回 null。
 * 与 main.js 同口径：能被 `new URL` 解析、协议恰为 http 或 https、hostname 非空。
 */
function parseWebUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // 解析不了就不是合格地址。
    return null;
  }
  // 只有 http / https 算合格：别的协议绝不能从这里漏出去。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // host 为空说明这条地址落不到任何主机上。
  if (!parsed.hostname) return null;
  return parsed;
}

/**
 * 5.2 / 5.3 origin 地址规范化（Requirement 4）。
 *
 * 这一组的对象是一个纯函数（输入字符串、输出地址或拒绝理由），所以它不碰 git、
 * 不起进程、也不依赖 PATH：纯计算断言，跑得飞快。也正因为它跟假脚本、临时仓库
 * 都无关，它在脚本里第一个执行——后面几组一旦因为假脚本没命中而整节跳过，
 * 这一组的证据仍然完整。
 */
function verifyRemoteNormalization() {
  console.log("5. origin 地址规范化（Requirement 4）");

  // 5.2 夹具：逐条对齐 design.md 3.3 的结果。
  for (const item of REMOTE_URL_CASES) {
    const result = internals.normalizeRemoteUrl(item.input);
    // 拒绝分支：只查 ok === false 守不住「必须被拒」——reason 也得是唯一那一种。
    if (item.expected === null) {
      check(
        `${item.label}：${JSON.stringify(item.input)} → 被拒（notOpenable）`,
        result.ok === false && result.reason === "notOpenable",
        JSON.stringify(result),
      );
      continue;
    }
    // 通过分支：地址必须逐字符等于表里那一列，多一个斜杠都算错。
    check(
      `${item.label}：${JSON.stringify(item.input)} → ${item.expected}`,
      result.ok === true && result.url === item.expected,
      JSON.stringify(result),
    );
  }

  // 5.3 性质（Correctness Property 3）：输出要么被拒，要么是能解析的 http(s) 地址
  // 且 host 非空——绝不可能出现别的协议。
  // 逐条打印会在报告里刷出几十行 ok，所以这里把不合格的输入收集起来一次性断言；
  // 真有 offender 时它们会被完整写进 detail，信息一条都不丢。
  const offenders = [];
  let accepted = 0;
  let refused = 0;
  for (const input of REMOTE_URL_PROPERTY_INPUTS) {
    const result = internals.normalizeRemoteUrl(input);
    // 被拒是合法结果，但理由必须恰好是 notOpenable（别的 reason 视图没有文案）。
    if (result.ok === false) {
      refused += 1;
      if (result.reason !== "notOpenable") offenders.push(`${JSON.stringify(input)} → ${JSON.stringify(result)}`);
      continue;
    }
    accepted += 1;
    // 成功分支必须是真能解析的 http(s) 地址，且 host 非空。
    if (!parseWebUrl(result.url)) offenders.push(`${JSON.stringify(input)} → ${JSON.stringify(result)}`);
  }
  check(
    `性质：${REMOTE_URL_PROPERTY_INPUTS.length} 条畸形 / 极端输入要么被拒，要么是 host 非空的 http(s) 地址`,
    offenders.length === 0,
    offenders.join(" | "),
  );
  // 再钉一次清单本身：两种结果都得真的出现过，否则上面那条断言是空转。
  check(`性质清单同时覆盖两侧（接受 ${accepted} 条 / 拒绝 ${refused} 条）`, accepted > 0 && refused > 0, `accepted=${accepted} refused=${refused}`);
  // 这一组跑在最前，结束时空一行，下一组的标题才不会跟上面最后一条粘在一起
  // （其它组自己带了前导换行）。
  console.log("");
}

// ── 6. 真实仓库：remote 判定、宿主调用与「只读」性质（6.6 / 6.7 / 6.8） ─────────────

/** 第 6 节的临时仓库都住在这里；假 git 包装器与它的日志放在仓库之外。 */
const remoteBase = join(base, "remote");
/** 假 git 包装器所在的目录：只在 6.8 挂在 PATH 上，用来记下每一次 git 子命令。 */
const fakeGitDir = join(remoteBase, "fake-git");
/** 假 git 的记录文件：一行一次调用（参数用空格拼起来），供「只问过 remote get-url」断言。 */
const gitLogPath = join(remoteBase, "git-calls.log");

/**
 * 写一个假 `git`：把收到的参数追加到日志，再 `exec` 真 git 转交。
 *
 * 为什么要这层包装：6.8 要断言「这一段里 git 只被问过只读的 remote get-url」，而子进程
 * 的命令行从外面看不见。`printf` 一行一个参数、`exec` 保证退出码与 stdout / stderr
 * 原样透传，插件察觉不到中间那层。日志写在仓库之外，不会污染「仓库逐字节不变」那条断言。
 */
function makeFakeGit() {
  mkdirSync(fakeGitDir, { recursive: true });
  const scriptPath = join(fakeGitDir, "git");
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >> "${gitLogPath}"`, `exec "${realGit}" "$@"`, ""];
  writeFileSync(scriptPath, lines.join("\n"));
  // POSIX 上 spawn 靠执行位决定能不能起，脚本必须带它。
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/** 读假 git 的记录（一行一次调用）；文件还不存在就是「一次都没跑过」。 */
function readGitCalls() {
  try {
    return readFileSync(gitLogPath, "utf8").split("\n").filter((line) => line !== "");
  } catch {
    // 日志还没生成 = 一次 git 都没跑过。
    return [];
  }
}

/** 起一个真仓库：一次提交、一个文件，可选配 origin（不给就留成「没有 origin」那一档）。 */
function makeRepo(name, originUrl) {
  const repo = join(remoteBase, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["init", "-q", "-b", "main", "."]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "init"]);
  // 只有给了地址才配 origin：需要「本来就没有 origin」时这一步必须缺席。
  if (originUrl) git(repo, ["remote", "add", "origin", originUrl]);
  return repo;
}

/** 等过 git 快照 / origin 判定的缓存 TTL：同一个目录要换结论就得等它过期。 */
const sleepPastTtl = () => sleep(internals.GIT_SNAPSHOT_TTL_MS + 150);

/** 换掉基点文件夹后列一次目录，返回响应里的 remote 判定。 */
async function remoteOf(plugin, rootPath) {
  // 桩宿主的 workspace 是同一个对象，改 path 就等于换一个打开的项目。
  workspace.path = rootPath;
  const listing = await plugin.onPanelInvoke("fm.list", { path: "" });
  return listing.remote;
}

/**
 * 在「这个运行时不给子进程」的条件下执行 fixture。
 *
 * main.js 的 gitSpawnFn 明写了这条降级路径（被裁剪的构建 / 非 Node 宿主）：拿不到
 * spawn 时 git 一律按 GIT_UNAVAILABLE 失败、快照为 null，而 gitBinary 保持 null——
 * 正好造出「机器上没有 git」这一幕，用来把 noGit 与 noRepo 分开。
 * 真实机器上没法用 PATH 造这一幕：git 的兜底路径（/usr/bin/git 等）还在，libuv 会
 * 跳过 PATH 里那个坏掉的候选继续往后找，结论就变成了「有 git、但不是仓库」。
 * 挡的必须是整个调用窗口而不只是加载：`node:child_process` 是**惰性** require 的。
 */
async function withBlockedChildProcess(fixture) {
  const originalLoad = Module._load;
  Module._load = function blockedLoad(request, parent, isMain) {
    // 只挡子进程能力，其余 require 原样放行。
    if (request === "node:child_process") throw new Error("no child processes in this fixture");
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await fixture();
  } finally {
    // 无论如何都还原：后面几节还要起真的假脚本与真的 git。
    Module._load = originalLoad;
  }
}

/**
 * 把一棵目录树扫成「相对路径 → 大小:mtime:内容哈希」，用来断言调用前后逐字节不变。
 *
 * 三项一起比是刻意的：只比哈希会漏掉「碰了 mtime 但没改内容」，只比 mtime 会漏掉
 * 同一秒内的改写。符号链接只记它指向哪儿、不跟进去（可能指到仓库外面）。
 */
function fingerprintTree(dir, prefix = "", out = new Map()) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const full = join(dir, dirent.name);
    // 目录往里走。
    if (dirent.isDirectory()) {
      fingerprintTree(full, rel, out);
      continue;
    }
    // 符号链接只记目标，不读它指向的内容。
    if (dirent.isSymbolicLink()) {
      out.set(rel, `link:${readlinkSync(full)}`);
      continue;
    }
    const stat = statSync(full);
    out.set(rel, `${stat.size}:${stat.mtimeMs}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
  }
  return out;
}

/** 两份指纹的第一处差异；没有差异返回 null（照 cmdBookkeepingBlocker 的 null = 无事约定）。 */
function firstDifference(before, after) {
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    // 有一侧没有这个键（新增 / 删除）或值不同 = 就是这一处，报出来即可。
    if (before.get(key) !== after.get(key)) return `${key}: ${before.get(key)} → ${after.get(key)}`;
  }
  return null;
}

/**
 * 问一次工作区状态。
 * 带 `GIT_OPTIONAL_LOCKS=0`：`git status` 默认会顺手刷新索引，那本身就是一次写；
 * 这条性质要证明「被检的调用没写」，那么用来提问的工具自己先不能写。
 */
const gitStatusOf = (repo) => execFileSync(realGit, ["status", "--porcelain"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

/** 6.6 真实仓库的五种判定：可用 / 地址不可打开 / 没有 origin / 不是仓库 / 没有 git。 */
async function verifyRemoteCapability() {
  console.log("\n6. 真实仓库的 remote 判定（6.6）");

  // 可用：配了 scp 形态的 origin，列表就该给出规范化后的首页与主机名。
  const repo = makeRepo("capability", "git@github.com:owner/repo.git");
  const plugin = await loadPlugin(realPath);
  const available = await remoteOf(plugin, repo);
  check("配了 scp 形态 origin → available: true", available?.available === true, JSON.stringify(available));
  check("url 是规范化后的仓库首页", available?.url === "https://github.com/owner/repo", JSON.stringify(available));
  check("host 是解析出来的主机名（不为它另跑 git）", available?.host === "github.com", JSON.stringify(available));

  // 缓存：TTL 内 origin 改了仍读到旧结论——这正是「不为每条 entry 重算」换来的代价。
  git(repo, ["remote", "set-url", "origin", repo]);
  const cached = await remoteOf(plugin, repo);
  check("TTL 内 origin 已变仍返回缓存结论（2s 缓存生效）", cached?.available === true, JSON.stringify(cached));
  await sleepPastTtl();
  const notOpenable = await remoteOf(plugin, repo);
  check("origin 是本地路径 → notOpenable", notOpenable?.reason === "notOpenable", JSON.stringify(notOpenable));

  // 插件自己写过文件之后必须立刻重算：invalidateGitSnapshots() 连 origin 判定一起清。
  // 这里用 fm.write（保存）而不是 fm.create：保存同样会作废缓存，而 fm.create / fm.rename
  // 在本仓 HEAD 上有一个与本次改动无关的既有故障（见 main.js 的 assertValidName），
  // 拿它当夹具会把一个别人的 bug 混进这一节。该故障已单独报告，未在本任务里修。
  git(repo, ["remote", "set-url", "origin", "https://git.internal:8080/owner/repo.git"]);
  const saved = await plugin.onPanelInvoke("fm.write", { path: "a.txt", text: "a\nsaved\n" });
  check("插件自己保存文件成功（这一步会作废缓存）", saved.ok === true, JSON.stringify(saved));
  // 关键：保存之后**立刻**列目录就必须是新结论，不用等 TTL 到期。
  const afterWrite = await remoteOf(plugin, repo);
  check("插件写完之后立刻重算，不等 TTL 到期", afterWrite?.available === true && afterWrite.url === "https://git.internal:8080/owner/repo", JSON.stringify(afterWrite));

  // 没有 origin：删掉之后再等过 TTL，结论必须跟着变，通道也给出 NO_REMOTE。
  git(repo, ["remote", "remove", "origin"]);
  await sleepPastTtl();
  const noRemote = await remoteOf(plugin, repo);
  check("删掉 origin → noRemote", noRemote?.reason === "noRemote", JSON.stringify(noRemote));
  const openNoRemote = await plugin.onPanelInvoke("fm.remote.open", {});
  check("没有 origin 时打开 → NO_REMOTE", openNoRemote.ok === false && openNoRemote.code === "NO_REMOTE", JSON.stringify(openNoRemote));

  // 不是仓库：换一个普通文件夹当基点。
  const plain = join(remoteBase, "plain");
  mkdirSync(plain, { recursive: true });
  const noRepo = await remoteOf(plugin, plain);
  check("非仓库目录 → noRepo", noRepo?.reason === "noRepo", JSON.stringify(noRepo));
  const openNoRepo = await plugin.onPanelInvoke("fm.remote.open", {});
  check("非仓库目录打开 → NO_REPO", openNoRepo.ok === false && openNoRepo.code === "NO_REPO", JSON.stringify(openNoRepo));
  // 地址不可打开：换一个 origin 指向本地路径的仓库（本地路径绝不能被读成 host）。
  const localRepo = makeRepo("capability-local", repo);
  const localCapability = await remoteOf(plugin, localRepo);
  check("origin 指向本地路径 → notOpenable", localCapability?.reason === "notOpenable", JSON.stringify(localCapability));
  const openLocal = await plugin.onPanelInvoke("fm.remote.open", {});
  check("本地路径 origin 打开 → REMOTE_NOT_OPENABLE", openLocal.ok === false && openLocal.code === "REMOTE_NOT_OPENABLE", JSON.stringify(openLocal));

  // 没有 git：整段调用都跑在「没有子进程能力」的窗口里，git 探测必然失败。
  const blocked = await withBlockedChildProcess(async () => {
    const instance = await loadPlugin(realPath);
    return { verdict: await remoteOf(instance, plain), open: await instance.onPanelInvoke("fm.remote.open", {}) };
  });
  check("机器上没有 git → noGit（与 noRepo 分开）", blocked.verdict?.reason === "noGit", JSON.stringify(blocked.verdict));
  check("没有 git 时打开 → GIT_UNAVAILABLE", blocked.open.ok === false && blocked.open.code === "GIT_UNAVAILABLE", JSON.stringify(blocked.open));
}

/** 6.7 宿主调用与拒绝：地址恰好等于规范化结果、只调一次、拒绝时不谎称成功。 */
async function verifyRemoteOpen() {
  console.log("\n6. 宿主调用与拒绝（6.7）");

  const repo = makeRepo("open", "git@github.com:owner/repo.git");
  const plugin = await loadPlugin(realPath);
  workspace.path = repo;

  openedExternalUrls = [];
  const opened = await plugin.onPanelInvoke("fm.remote.open", {});
  check("成功返回 { ok: true, url }", opened.ok === true && opened.url === "https://github.com/owner/repo", JSON.stringify(opened));
  check("宿主收到的地址恰好等于规范化结果、且只收了一次", openedExternalUrls.length === 1 && openedExternalUrls[0] === opened.url, JSON.stringify(openedExternalUrls));

  // 目标无关（Requirement 3.4）：从文件上请求，落到的是同一个仓库首页。
  openedExternalUrls = [];
  const fromFile = await plugin.onPanelInvoke("fm.remote.open", { path: "a.txt" });
  check("从文件上请求打开发的是同一个仓库首页", fromFile.ok === true && fromFile.url === opened.url, JSON.stringify(fromFile));
  check("这一次也只调了宿主一次", openedExternalUrls.length === 1 && openedExternalUrls[0] === opened.url, JSON.stringify(openedExternalUrls));

  // 宿主拒绝：桩宿主像宿主白名单那样抛 DISALLOWED_EXTERNAL_URL。
  openedExternalUrls = [];
  rejectExternal = true;
  const refused = await plugin.onPanelInvoke("fm.remote.open", {});
  check("宿主拒绝 → { ok: false }，绝不谎称成功", refused.ok === false, JSON.stringify(refused));
  check("拒绝原因由宿主原样透传", refused.code === "DISALLOWED_EXTERNAL_URL", JSON.stringify(refused));
  check("拒绝前确实调过宿主（不是压根没尝试）", openedExternalUrls.length === 1, JSON.stringify(openedExternalUrls));
}

/**
 * 6.8 性质：两个动作全程只读（design.md Correctness Property 4）。
 *
 * 三层证据：① 仓库整棵树（大小 + mtime + 内容哈希）逐项不变、且没多出 index.lock；
 * ② `git status --porcelain` 前后一致；③ 假 git 记下的调用只有 `remote get-url`。
 */
async function verifyReadOnlyActions() {
  console.log("\n6. 性质：两个动作全程只读（6.8）");
  // 假 git 包装器只在 POSIX 上造得出来：Windows 的 PATH 搜索按 PATHEXT 匹配带扩展名的
  // 文件，一个没扩展名的 `git` 不会被选中，批处理包装器又没法原样透传退出码与输出。
  // 造不出来时只跳过「git 子命令」那一条证据，逐字节不变与索引锁照常断言。
  const instrumentGit = process.platform !== "win32";
  // 假 git 包装器：挂上之后这一段里每一次 git 调用都会被记下来。
  if (instrumentGit) makeFakeGit();
  // 硬闸：这一节要真启动假 code 脚本（POSIX 上假 git 与它一起排在真实 PATH 之前）。
  const plugin = await loadGuardedPlugin(instrumentGit ? fakeGitDir : "");
  // 假脚本没被命中：整节跳过，避免打到用户机器上真的 code（与第 2 / 3 / 4 节同一道硬闸）。
  if (!plugin) return;

  const repo = makeRepo("readonly", "git@github.com:owner/repo.git");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "sub", "b.txt"), "b\n");
  workspace.path = repo;
  // 日志与指纹都从这一刻算起，且 git 的调用记录必须先清零。
  if (instrumentGit) writeFileSync(gitLogPath, "");
  const codeLogBefore = readLog().length;
  const statusBefore = gitStatusOf(repo);
  const before = fingerprintTree(repo);

  // 三轮：空 path（基点自身）、文件、子目录都走到，两条通道各一次。
  const targets = ["", "a.txt", "sub/b.txt"];
  for (let round = 0; round < targets.length; round += 1) {
    const opened = await plugin.onPanelInvoke("fm.remote.open", {});
    check(`第 ${round + 1} 轮 fm.remote.open 成功`, opened.ok === true, JSON.stringify(opened));
    const edited = await plugin.onPanelInvoke("fm.editor.open", { path: targets[round] });
    check(`第 ${round + 1} 轮 fm.editor.open 成功`, edited.ok === true, JSON.stringify(edited));
  }
  // 假脚本写日志是异步的：等它写完再比（与前面几节同一手法，有硬上限）。
  await waitForLogGrowth(codeLogBefore);

  const statusAfter = gitStatusOf(repo);
  const after = fingerprintTree(repo);
  const difference = firstDifference(before, after);
  check("工作区与 .git 在调用前后逐字节不变（大小 + mtime + 内容哈希）", difference === null, String(difference));
  check("没有留下索引锁（.git/index.lock）", !existsSync(join(repo, ".git", "index.lock")), "index.lock 出现了");
  check("git status --porcelain 前后一致（没多出任何改动）", statusBefore === statusAfter, `${JSON.stringify(statusBefore)} → ${JSON.stringify(statusAfter)}`);
  check("两条动作确实执行过（否则这条性质是空转）", readLog().length > codeLogBefore, "假 code 一次都没被调用");
  // 这个平台上没挂假 git：这一条证据（只问过哪些子命令）没法取，但跳过要看得见。
  if (!instrumentGit) {
    skip("git 子命令记录（只跑 remote get-url）：Windows 上造不出可用的假 git");
    return;
  }
  // 只读的正面证据：这一段里 git 只被问过 remote get-url 这一条只读子命令。
  const calls = readGitCalls();
  check(
    `这一段里 git 只跑了 remote get-url（共 ${calls.length} 次）`,
    calls.length === targets.length && calls.every((line) => line === "remote get-url origin"),
    JSON.stringify(calls),
  );
}

/**
 * 7. 视图调用层与菜单判定（9.4 / 10.2）。
 *
 * 这一节测的是 lib/ 里的纯函数与调用层，不碰主进程、不碰 PATH，所以必定执行（不受
 * 假脚本硬闸与「本机有没有 git」影响）。两个菜单项的判定纯函数被搬出 App.tsx 就是为了
 * 能在这里离线断言：App.tsx 是渲染组件，判定留在里面就只能靠人手点着看。
 *
 * 桩 bridge：视图模块读 window.pluginBridge，给 globalThis 挂一个假的就能看到「点了
 * 某一项之后，视图到底往哪条通道、送了什么样的 payload」。这一段钉住的是**调用层**：
 * lib/hostActions.ts 的 openInEditor、lib/remoteOpen.ts 的 openRepoInBrowser，以及
 * 「这一项要送什么路径」那个纯函数 editorTargetPath——**不是 App.tsx 的渲染**，
 * App.tsx 在本脚本里从未被加载。App.tsx 那两处 onPick 只是
 * `runEditorOpen(editorTargetPath(target ? target.path : null))` 与 `runRemoteOpen()`，
 * 所以下面分两段把同一件事钉住：先单独断言 editorTargetPath（相对路径原样返回、
 * null / 空串给 undefined），再把它的返回值喂进 openInEditor 查 payload。少了前一段，
 * 只调 openInEditor("src/a.ts") 什么也证明不了——把 App.tsx 那行换成 hostActionPath(...)
 * 这一节照样全绿。
 */
async function verifyViewLayer() {
  console.log("\n7. 视图调用层与菜单判定（9.4 / 10.2）");

  const view = await loadViewModules();
  const { openInEditor } = view.hostActions;
  const { editorMenuState, editorTargetPath, openRepoInBrowser, remoteMenuState } = view.remoteOpen;
  const { COPY_TABLES } = view;

  /** 照 i18n.ts 里 makeT 的规则做一份精简版：只做 {占位符} 替换。 */
  const makeT = (table) => (key, values = {}) =>
    String(table[key] ?? "").replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  const tZh = makeT(COPY_TABLES.zh);
  const tEn = makeT(COPY_TABLES.en);

  // ── 10.2 键位对齐 ─────────────────────────────────────────────────────────
  const enKeys = Object.keys(COPY_TABLES.en);
  const zhKeys = Object.keys(COPY_TABLES.zh);
  const missingZh = enKeys.filter((key) => !zhKeys.includes(key));
  const missingEn = zhKeys.filter((key) => !enKeys.includes(key));
  check(
    "中英文案键完全对齐（少一个中文键，界面上就会突然冒一句英文，而 tsc 抓不到）",
    missingZh.length === 0 && missingEn.length === 0,
    `zh 缺 ${missingZh.join(",")}；en 缺 ${missingEn.join(",")}`,
  );
  const newKeys = [
    "openInVSCode",
    "openProjectInVSCode",
    "editorUnavailable",
    "editorOpenError",
    "editorUnsupportedPath",
    "openRemote",
    "openRemoteHint",
    "remoteNoRepo",
    "remoteNoRemote",
    "remoteNotOpenable",
    "remoteNoGit",
    "remoteOpenError",
  ];
  const absent = newKeys.filter((key) => !enKeys.includes(key) || !zhKeys.includes(key));
  check(`本版新增的 ${newKeys.length} 个键两种语言都有`, absent.length === 0, absent.join(","));

  // ── 9.4「用 VSCode 打开」的可用状态 ───────────────────────────────────────
  const editorOff = editorMenuState(false, tZh);
  check("探测不到 code 命令 → 这一项禁用", editorOff.disabled === true, JSON.stringify(editorOff));
  check(
    "禁用时的提示就是那条点名 PATH 的文案（Requirement 2.6）",
    editorOff.hint === COPY_TABLES.zh.editorUnavailable,
    editorOff.hint,
  );
  check(
    "同一句话英文表里也有（不是回落到中文）",
    editorMenuState(false, tEn).hint === COPY_TABLES.en.editorUnavailable,
    editorMenuState(false, tEn).hint,
  );
  const editorOn = editorMenuState(true, tZh);
  check("探测到命令行 → 不再禁用", editorOn.disabled === false, JSON.stringify(editorOn));
  check("可用时不给悬停提示（标签已经说明白了，空串等于没有提示）", editorOn.hint === "", editorOn.hint);

  // ── 9.4「在浏览器打开仓库」的可用状态 ─────────────────────────────────────
  const reasonKeys = {
    noRepo: "remoteNoRepo",
    noRemote: "remoteNoRemote",
    notOpenable: "remoteNotOpenable",
    noGit: "remoteNoGit",
  };
  const reasonHints = [];
  for (const [reason, key] of Object.entries(reasonKeys)) {
    const state = remoteMenuState({ available: false, reason }, tZh);
    // 文案从表里取、不写死中文：写死的话改文案时这里会假绿。
    check(
      `${reason} → 禁用，提示是 ${key}`,
      state.disabled === true && state.hint === COPY_TABLES.zh[key],
      JSON.stringify(state),
    );
    reasonHints.push(state.hint);
  }
  check("四种不可用原因各给一句不同的话（不是笼统一句）", new Set(reasonHints).size === 4, reasonHints.join(" / "));
  check(
    "判定还没到手（remote 为 null）时也禁用，并给一句解释",
    remoteMenuState(null, tZh).disabled === true && remoteMenuState(null, tZh).hint === COPY_TABLES.zh.remoteNoRepo,
    JSON.stringify(remoteMenuState(null, tZh)),
  );
  const host = "github.com";
  const remoteOn = remoteMenuState({ available: true, url: `https://${host}/owner/repo`, host }, tZh);
  check("可用 → 不禁用", remoteOn.disabled === false, JSON.stringify(remoteOn));
  check(
    "可用时提示里给出将要打开的 host",
    remoteOn.hint.includes(host) && remoteOn.hint === COPY_TABLES.zh.openRemoteHint.replace("{host}", host),
    remoteOn.hint,
  );
  // ── editorTargetPath：那一项到底送什么路径（9.4 / 8.1）─────────────────────
  // 纯函数断言：App.tsx 里那一项传的就是它的返回值，所以调用层的路径口径由它负责。
  const relative = "src/deep/a.ts";
  check(
    "有目标时原样返回基点相对路径（逐字节，不绝对化、不拼基点）",
    editorTargetPath(relative) === relative && !relative.startsWith("/"),
    String(editorTargetPath(relative)),
  );
  check(
    "纯透传：喂进去什么就吐什么，函数自己不会把相对路径拼成绝对路径（拒绝绝对路径是主进程 ABSOLUTE_PATH 的责任）",
    editorTargetPath("../outside.txt") === "../outside.txt" && editorTargetPath("a%b.txt") === "a%b.txt",
    String(editorTargetPath("../outside.txt")),
  );
  check(
    "空白处（null）返回 undefined：通道里连 path 这个字段都不带，由主进程按基点文件夹自身解析",
    editorTargetPath(null) === undefined,
    String(editorTargetPath(null)),
  );
  check(
    "空串与 null 同档（主进程把空串也当基点文件夹自身），不会把空串当成路径送出去",
    editorTargetPath("") === undefined,
    String(editorTargetPath("")),
  );

  // ── 8.1 / 8.2 调用层送出的通道与 payload ─────────────────────────────────
  /** 桩 bridge 记下的每一次调用；每段断言前清空，免得上一段混进来。 */
  const calls = [];
  /** 下一次通道调用要回的响应；成功与失败两种形状各来一遍。 */
  let reply = { ok: true, path: "/abs/repo/src/a.ts", binary: "/usr/local/bin/code" };
  globalThis.window = {
    pluginBridge: {
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        return reply;
      },
      on: () => () => {},
    },
  };

  // 文件右键：App.tsx 那一项的 onPick 送的就是 editorTargetPath(树里的 target.path)。
  calls.length = 0;
  const opened = await openInEditor(editorTargetPath("src/a.ts"));
  check(
    "「用 VSCode 打开」走 fm.editor.open 通道，且只调一次",
    calls.length === 1 && calls[0].channel === "fm.editor.open",
    JSON.stringify(calls),
  );
  check(
    "payload 里的 path 就是 target.path 原样（基点相对：不绝对化、不拼基点）",
    JSON.stringify(calls[0].payload) === JSON.stringify({ path: "src/a.ts" }),
    JSON.stringify(calls[0].payload),
  );
  check(
    "成功时把主进程给的绝对路径与命令行路径回传出来",
    opened.path === reply.path && opened.binary === reply.binary,
    JSON.stringify(opened),
  );

  // 空白处右键：App.tsx 传 editorTargetPath(null)，也就是 undefined，payload 里连 path 都没有。
  calls.length = 0;
  await openInEditor(editorTargetPath(null));
  check(
    "空白处右键的 payload 不带 path 字段（主进程按基点文件夹自身解析）",
    calls.length === 1 && !("path" in calls[0].payload),
    JSON.stringify(calls[0].payload),
  );

  // 失败折算：通道回 { ok: false } 必须抛错，并把原因码带出来（调用方据此挑文案）。
  reply = { ok: false, code: "EDITOR_UNSUPPORTED_PATH", message: "this path cannot be opened on Windows" };
  const thrown = await openInEditor("a%b.txt").then(
    () => null,
    (cause) => cause,
  );
  check("失败响应抛错（调用方只写一个 catch）", thrown !== null, "居然 resolve 了");
  check(
    "原因码被带出来，供调用方挑「这条路径不能交给 cmd.exe」那句文案",
    thrown?.code === "EDITOR_UNSUPPORTED_PATH",
    String(thrown?.code),
  );

  // 「在浏览器打开仓库」：不带 payload 调到 fm.remote.open，成功回传地址。
  reply = { ok: true, url: "https://github.com/owner/repo" };
  calls.length = 0;
  const remoteOpened = await openRepoInBrowser();
  check(
    "「在浏览器打开仓库」走 fm.remote.open 通道，且不带任何 payload 字段",
    calls.length === 1 && calls[0].channel === "fm.remote.open" && Object.keys(calls[0].payload ?? {}).length === 0,
    JSON.stringify(calls),
  );
  check("成功时回传实际打开的地址", remoteOpened.url === "https://github.com/owner/repo", JSON.stringify(remoteOpened));

  reply = { ok: false, code: "REMOTE_NOT_OPENABLE", message: "the origin remote is not a web address" };
  const remoteThrown = await openRepoInBrowser().then(
    () => null,
    (cause) => cause,
  );
  check("通道失败时抛错，绝不谎称成功", remoteThrown !== null, "居然 resolve 了");

  // 桩 bridge 用完就撤：后面再没有视图模块的调用，别把 window 留给别的脚本段。
  delete globalThis.window;
}

/**
 * 把视图的三个模块打成一份 ESM 再 import 进来（与 verify-roots.mjs / verify-git.mjs
 * 同一做法）：lib/hostActions.ts 是「用 VSCode 打开」的调用层，lib/remoteOpen.ts 是
 * 「在浏览器打开仓库」的调用层与两个菜单项判定，i18n.ts 是文案表。
 *
 * 三个模块都不碰 DOM，import 到 Node 里是安全的；只有 bridge.ts 里的 invoke 会读
 * window.pluginBridge，那是调用时才读，所以由调用方按需挂桩。
 */
async function loadViewModules() {
  const dir = mkdtempSync(join(tmpdir(), "pifm-remote-view-"));
  const entry = join(dir, "entry.ts");
  const out = join(dir, "bundle.mjs");
  writeFileSync(
    entry,
    `export * as hostActions from ${JSON.stringify(join(here, "src", "lib", "hostActions.ts"))};\n` +
      `export * as remoteOpen from ${JSON.stringify(join(here, "src", "lib", "remoteOpen.ts"))};\n` +
      `export { COPY_TABLES } from ${JSON.stringify(join(here, "src", "i18n.ts"))};\n`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: out,
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

 /*
 * 8. 降级不牵连的回归（12.2，对应 design.md Correctness Property 7）。
 *
 * 要证明的是「新增的两个动作各自降级时，别人不受牵连」：四种降级各发生时，列目录 / 读 /
 * 写 / 保存 / 删除 / 搜索 / `fm.watch` 这些早就存在的通道必须与全环境基线**逐项一致**。
 *
 * 为什么用「与基线比对」而不是逐条写死期望：写死期望只证明「现在是这个样子」，跟基线
 * 比对才证明「没有因为这次改动而变样」——这正是本任务要的回归口径。
 *
 * ⚠️ 范围提醒：`fm.create` 与 `fm.rename` 在基线（7cd39c2）上就是坏的——`main.js` 的
 * `assertValidName` 函数体被截断（`main.js:1795-1811`：函数体后面紧跟着 `entryFromStat`
 * 的函数体，最后那句 `return` 引用了并不存在的 `rel`），两个通道必然返回
 * `{ ok: false, code: "INTERNAL", message: "rel is not defined" }`。这**不是本次改动引入的**，
 * 本任务也不去修它；所以下面钉住的是**失败**结论，「与改动前一致」对这两个通道就是
 * 「仍然返回那个 INTERNAL」，绝不是期望成功。
 */

/** 第 8 节的夹具都住在这里；每一档一份全新副本，免得写过的、删过的互相污染。 */
const degradeBase = join(base, "degrade");

/**
 * 铺一份第 8 节用的项目：一个文件 + 一个带文件的子目录，够把列目录 / 读 / 写 / 保存 /
 * 删除 / 搜索各走一遍。
 *
 * `originUrl` 三态是刻意的：字符串 = 仓库且配了 origin；`null` = 仓库但没有 origin；
 * 不给（`undefined`）= 普通目录，连 `git init` 都不跑，才算真的「不是仓库」那一档。
 */
function makeDegradeFixture(name, originUrl) {
  const dir = join(degradeBase, name);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  writeFileSync(join(dir, "sub", "note-from-sub.txt"), "sub\n");
  // 要装成仓库、且本机真有 git：本机没有 git 时装也装不成，那样只会让这一档名不副实。
  if (originUrl !== undefined && realGit !== null) {
    git(dir, ["init", "-q", "-b", "main", "."]);
    git(dir, ["config", "user.email", "t@example.com"]);
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "init"]);
    // 只有给了地址才配 origin：`null` 这一档要的就是「仓库但没有 origin」。
    if (originUrl) git(dir, ["remote", "add", "origin", originUrl]);
  }
  return dir;
}

/**
 * 把「与本次改动无关的那些通道」驱动一遍，返回 `{ remoteReason, observed }`。
 *
 * `observed` 只放跨场景**应该**逐项相同的观测量：`remote` / `git` / `editor` 正是本次新增
 * 的字段，本来就该随降级变化，记进来会让比对永远不等。`remoteReason` 单独放在外面，用途
 * 只有一个——核对这一档的降级真的发生了，否则后面那场比对是空转。
 *
 * 顺序也有意：先列目录，再写、再删——列目录看到的 `git` 因此都是「干净仓库里的 null」，
 * 与「没有 git」那一档同形，不必为了对齐再去等 git 快照的 2 秒缓存过期。
 */
async function driveBaselineChannels(plugin, dir) {
  // 桩宿主的 workspace 是同一个对象：改 path 就等于换一个打开的项目。
  workspace.path = dir;
  const listing = await plugin.onPanelInvoke("fm.list", { path: "" });
  const read = await plugin.onPanelInvoke("fm.read", { path: "keep.txt" });
  const write = await plugin.onPanelInvoke("fm.write", { path: "keep.txt", text: "keep\nedited\n" });
  // 写完再读一遍：这才叫「保存」落了盘，只看 write.ok 只说明「没报错」。
  const saved = await plugin.onPanelInvoke("fm.read", { path: "keep.txt" });
  const search = await plugin.onPanelInvoke("fm.search", { query: "note-from-sub", limit: 20 });
  const watch = await plugin.onPanelInvoke("fm.watch", { since: 0 });
  const removed = await plugin.onPanelInvoke("fm.delete", { path: "sub" });
  // create / rename 在基线上就是坏的（见本节开头的范围提醒）：这里只记结论，不期望成功。
  const created = await plugin.onPanelInvoke("fm.create", { parent: "", name: "brand-new.txt" });
  const renamed = await plugin.onPanelInvoke("fm.rename", { path: "keep.txt", newName: "kept.txt" });

  return {
    // 这一档的降级成因（`noGit` / `noRepo` / `noRemote`）；「PATH 上没有 code」那一档不用它。
    remoteReason: listing.remote?.reason ?? null,
    // 跨场景比对的观测量：每一项都是一种早就存在的通道行为，少记一项就少一处回归面。
    observed: {
      // 列目录：条目名 + 是否目录（目录带一个斜杠），以及截断标记。
      listNames: (listing.entries ?? []).map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`).join(","),
      listTruncated: listing.truncated === true,
      // 读：成功与否 + 实际拿到的文本。
      readOk: read.ok === true,
      readText: read.text,
      // 写 / 保存：写入成功与否 + 重新读回来的文本。
      writeOk: write.ok === true,
      savedText: saved.text,
      // 搜索：命中的相对路径（夹具里只有一个够独特的名字）。
      searchPaths: (search.matches ?? []).map((match) => match.path).join(","),
      // 监听：这一轮问得成不成功，以及本运行时给不给可用。
      watchOk: watch.ok === true,
      watchAvailable: watch.available === true,
      // 删除：成功与否，以及那个目录是不是真的没了。
      deleteOk: removed.ok === true,
      subGone: !existsSync(join(dir, "sub")),
      // 新建 / 重命名的完整结论（连 message 一起记，基线那一档会另行钉死它到底是哪个故障）。
      createVerdict: `${created.ok}/${created.code ?? ""}/${created.message ?? ""}`,
      renameVerdict: `${renamed.ok}/${renamed.code ?? ""}/${renamed.message ?? ""}`,
    },
  };
}

/** 两份观测的第一处差异；没有差异返回 null（沿用 firstDifference 的 null = 无事约定）。 */
function observationDifference(baseline, actual) {
  for (const key of Object.keys(baseline)) {
    // 逐字段比：不相等的第一处就是被牵连的点，报出来即可（键顺序由同一个函数决定，两边一致）。
    if (baseline[key] !== actual[key]) return `${key}: ${JSON.stringify(baseline[key])} → ${JSON.stringify(actual[key])}`;
  }
  return null;
}

/**
 * 跑一档降级：先核对降级确实发生了（没发生的话后面的比对是空转，等于没测），再把与本次
 * 改动无关的那些通道与全环境基线逐项比对。
 *
 * `load` 收成一个函数是为了「机器上没有 git」那一档：挡 child_process 必须把加载与调用
 * 一起包在那个窗口里（`node:child_process` 是惰性 require 的），由调用方决定包不包。
 */
async function runDegradeCase(label, load, dir, expectation, baseline) {
  const plugin = await load();
  const hello = await plugin.onPanelInvoke("fm.hello", {});
  const driven = await driveBaselineChannels(plugin, dir);
  // 「没有 code」这一档的观测量在握手响应里；其余三档看 remote 的成因码。
  if (expectation.editorBinaryNull === true) {
    check(`${label}：降级确实发生（editor.binary === null）`, hello.editor?.binary === null, JSON.stringify(hello.editor));
  }
  if (expectation.remoteReason) {
    check(`${label}：降级确实发生（remote.reason === "${expectation.remoteReason}"）`, driven.remoteReason === expectation.remoteReason, JSON.stringify(driven.remoteReason));
  }
  const difference = observationDifference(baseline.observed, driven.observed);
  check(`${label}：列目录 / 读 / 写 / 保存 / 删除 / 搜索 / fm.watch 与基线逐项一致`, difference === null, String(difference));
}

/** 12.2 降级不牵连（Correctness Property 7）：四种降级各发生时，无关通道照旧，不被牵连。 */
async function verifyDegradationIsolation() {
  console.log("\n8. 降级不牵连的回归（12.2）");

  // 全环境基线：完整 PATH，本机有 git 的话给的是一个配了 origin 的仓库。
  const baselinePlugin = await loadPlugin(realPath);
  const baseline = await driveBaselineChannels(baselinePlugin, makeDegradeFixture("healthy", "git@github.com:owner/repo.git"));
  check(
    "基线：列目录 / 读 / 写 / 保存 / 删除 / 搜索在完整环境下都照常",
    baseline.observed.listNames === "sub/,keep.txt" &&
      baseline.observed.readOk &&
      baseline.observed.writeOk &&
      baseline.observed.savedText === "keep\nedited\n" &&
      baseline.observed.deleteOk &&
      baseline.observed.subGone &&
      baseline.observed.searchPaths === "sub/note-from-sub.txt",
    JSON.stringify(baseline.observed),
  );
  // 基线里那两个早就坏掉的通道：断言的是**失败**，不是期望成功（见本节开头的范围提醒）。
  check(
    "fm.create 仍然返回基线的既有故障（INTERNAL / rel is not defined，不是本次引入）",
    baseline.observed.createVerdict === "false/INTERNAL/rel is not defined",
    baseline.observed.createVerdict,
  );
  check(
    "fm.rename 仍然返回基线的既有故障（INTERNAL / rel is not defined，不是本次引入）",
    baseline.observed.renameVerdict === "false/INTERNAL/rel is not defined",
    baseline.observed.renameVerdict,
  );

  // （一）PATH 上没有 code：探测落空那一档。夹具本身仍是配了 origin 的仓库。
  await runDegradeCase(
    "降级一：PATH 上没有 code",
    () => loadPlugin(emptyDir),
    makeDegradeFixture("no-editor", "git@github.com:owner/repo.git"),
    { editorBinaryNull: true },
    baseline,
  );

  // （二）机器上没有 git：只有挡住 child_process 才造得出来（与 6.6 的 noGit 同一手法）。
  await withBlockedChildProcess(() =>
    runDegradeCase(
      "降级二：机器上没有 git",
      () => loadPlugin(realPath),
      makeDegradeFixture("no-git", "git@github.com:owner/repo.git"),
      { remoteReason: "noGit" },
      baseline,
    ),
  );

  // （三）不是仓库：普通目录（夹具不跑 git init）。
  await runDegradeCase(
    "降级三：不是 git 仓库",
    () => loadPlugin(realPath),
    makeDegradeFixture("no-repo"),
    { remoteReason: "noRepo" },
    baseline,
  );

  // （四）仓库没有 origin：要真仓库才造得出来，本机没有 git 时跳过（跳过要看得见）。
  if (realGit === null) {
    skip("降级四（仓库没有 origin）：原始 PATH 上没有 git");
  } else {
    await runDegradeCase(
      "降级四：仓库没有 origin",
      () => loadPlugin(realPath),
      makeDegradeFixture("no-origin", null),
      { remoteReason: "noRemote" },
      baseline,
    );
  }
}

try {
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(emptyDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  fakeCodePath = makeFakeCode();

  // 纯函数那一组放在最前：它不碰 PATH、不起进程、也不依赖假脚本能不能命中，
  // 所以后面几组即便整节跳过，它也已经把证据留全了（见文件头 ⑤）。
  await verifyRemoteNormalization();
  await verifyDetection();
  await verifyLoginShellProbe();
  await verifyArgumentsAndRoot();
  await verifyInsideRootOnly();
  await verifyNoShell();

  // 第 6 节要起真的临时仓库：原始 PATH 上找不到 git 时整节跳过（与 verify-git.mjs 同一道闸）。
  if (realGit === null) {
    skip("真实仓库的用例（6.6 / 6.7 / 6.8）：原始 PATH 上没有 git");
  } else {
    await verifyRemoteCapability();
    await verifyRemoteOpen();
    await verifyReadOnlyActions();
  }

  // 第 7 节不依赖假脚本与 git（它只 import 视图模块），所以必定执行：
  // 前面的硬闸即便整节跳过，也拦不住这一节的证据。
  await verifyViewLayer();

  // 第 8 节只加载插件、驱动既有通道，同样不依赖假脚本，所以放在最后：
  // 它会把 PATH 换成别的形状，排在最末才不会干扰前面几节。
  await verifyDegradationIsolation();

  // 汇总行带上跳过数：跳过不算失败、不改退出码，但必须看得见（否则 CI 上是零覆盖）。
  const verdict = failures === 0 ? "REMOTE VERIFY PASSED" : `${failures} FAILURE(S)`;
  console.log(`\n${verdict}${skips > 0 ? ` (skipped ${skips})` : ""}`);
} finally {
  // 假脚本、日志与临时项目都要自己清掉（force 让「已经没了的」不报错）。
  rmSync(base, { recursive: true, force: true });
}

// 显式退出：即使还有句柄没释放，也不会把 npm 命令吊在这里。
process.exit(failures === 0 ? 0 : 1);
