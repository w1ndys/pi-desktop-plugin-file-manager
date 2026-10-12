/**
 * 用 VS Code 打开（0.9.0）：`code` 探测、启动参数与路径守卫的离线校验。
 *
 * 四组，对应 tasklist 的 3.4 / 3.5 / 3.6 / 3.7：
 *   ① 探测：只认 PATH——命中（PATH 最前放一个假的 `code`）、未命中（PATH 指向一个不含
 *      `code` 的空目录）、不做安装位置兜底（本机装了 VS Code 也照样判未找到）。
 *   ② 参数安全与项目根：根内路径逐字节送达假 `code`；省略 path 落到基点文件夹；
 *      越界 / 凭据 / 符号链接逃逸在 spawn 之前就被拒。
 *   ③ 性质：通道只接受基点内的路径（design.md Correctness Property 1）。
 *   ④ 性质：参数不经 shell（design.md Correctness Property 2），Windows 侧的命令串
 *      用纯函数断言。
 *
 * 观测手法：临时目录里写一个假 `code` 脚本，它把自己收到的每个参数逐行追加到日志
 * 文件；把该目录放在 PATH 最前再加载 main.js，`resolveEditorBinary` 命中的就是它，
 * 绝不会真的启动 VS Code。日志是**异步**写的（spawnDetached 在子进程的 'spawn'
 * 事件上就返回），所以每次调用之后都要轮询日志直到长出新内容，不能调用完立刻断言。
 *
 * 用法：pnpm verify:remote
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginMain = join(here, "..", "main.js");
const require = createRequire(pluginMain);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label} ${detail}`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 纯函数断言用第一份加载的实例；端到端部分每次换 PATH 都会重新加载，见 loadPlugin。 */
const { internals } = require(pluginMain);

/** 本次校验自己的临时目录：假 `code`、假脚本日志、临时项目都住在它下面。 */
const base = mkdtempSync(join(tmpdir(), "pifm-remote-"));
/** 假 `code` 所在的目录：唯一被塞到 PATH 最前的目录。 */
const fakeDir = join(base, "fake-bin");
/** 宿主原本的 PATH：接在假目录之后，否则脚本里用到的工具会失效。 */
const realPath = String(process.env.PATH ?? "");
/** 不含 `code` 的空目录：用来造「PATH 上没有 code」这一幕。 */
const emptyDir = join(base, "empty-bin");
/** 临时项目目录：桩宿主报给插件的基点文件夹。 */
const project = join(base, "project");
/** 项目之外的一个真实文件：越界与符号链接逃逸的目标。 */
const outsideFile = join(base, "outside.txt");
/** 假 `code` 的参数日志；这个绝对路径会被写死在假脚本里（见 makeFakeCode）。 */
const logPath = join(fakeDir, "code-args.log");

/**
 * 造一个假的 `code` 可执行脚本，返回它的绝对路径。
 *
 * 日志的绝对路径直接写死在脚本里，不用环境变量传：子进程的环境是从插件进程继承的，
 * 写死可以排除「环境没传对」这个变量，也让脚本本身能独立跑起来看出问题。
 */
function makeFakeCode() {
  const scriptPath = join(fakeDir, "code");
  const lines = [
    "#!/bin/sh",
    // 每个参数单独一行：断言时只需看这段字节是否逐字节等于送进去的路径。
    `for a in "$@"; do printf '%s\\n' "$a"; done >> "${logPath}"`,
    "",
  ];
  writeFileSync(scriptPath, lines.join("\n"));
  // 没有执行位就命中不了 resolveEditorBinary 的 X_OK 判定。
  chmodSync(scriptPath, 0o755);
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

/** 3.4 探测：命中 / 未命中 / 不做安装位置兜底。 */
async function verifyDetection(fakeCode) {
  console.log("1. 探测：只认 PATH（3.4）");

  // 命中：假目录排在最前，系统 PATH 接在后面。
  let plugin = await loadPlugin(`${fakeDir}${delimiter}${realPath}`);
  let hello = await plugin.onPanelInvoke("fm.hello", {});
  check("PATH 上有 code → editor.binary 是非空字符串", typeof hello.editor?.binary === "string" && hello.editor.binary.length > 0, JSON.stringify(hello.editor));
  check("命中的就是 PATH 最前那个假脚本", hello.editor?.binary === fakeCode, `${hello.editor?.binary} !== ${fakeCode}`);

  // 未命中：PATH 只剩一个不含 `code` 的空目录。
  plugin = await loadPlugin(emptyDir);
  hello = await plugin.onPanelInvoke("fm.hello", {});
  check("PATH 上没有 code → editor.binary === null", hello.editor?.binary === null, JSON.stringify(hello.editor));
  check("探测失败不把握手搞崩（仍然 ok: true）", hello.ok === true, JSON.stringify(hello).slice(0, 200));
  const unavailable = await plugin.onPanelInvoke("fm.editor.open", { path: "" });
  check("强行调用 → EDITOR_UNAVAILABLE", unavailable.ok === false && unavailable.code === "EDITOR_UNAVAILABLE", JSON.stringify(unavailable));
  check("提示里点名 PATH（而不是「找不到 VS Code」）", String(unavailable.message ?? "").includes("PATH"), String(unavailable.message));

  // 不做兜底：只有本机确实装了 VS Code 时这条才有证伪能力，没装就跳过不算失败。
  if (!existsSync("/Applications/Visual Studio Code.app") && !existsSync("/usr/bin/code")) {
    console.log("  skip 本机没装 VS Code，「不做安装位置兜底」这一条跳过");
    return;
  }
  plugin = await loadPlugin("");
  hello = await plugin.onPanelInvoke("fm.hello", {});
  check("装了 VS Code 但 PATH 为空 → 仍判为没找到（没去猜安装位置）", hello.editor?.binary === null, JSON.stringify(hello.editor));
}

/** 3.5 参数安全与项目根：根内逐字节送达、省略 path 落基点、越界与凭据在 spawn 前被拒。 */
async function verifyArgumentsAndRoot() {
  console.log("\n2. 参数安全与项目根（3.5）");
  const plugin = await loadPlugin(`${fakeDir}${delimiter}${realPath}`);

  // 名字含空格、`;`、`$()`、反引号的目录：这些字符只要被 shell 解释过一次就会露馅。
  const nastyName = "with space; $(whoami) `date`";
  mkdirSync(join(project, nastyName), { recursive: true });
  // 含 `%` 的目录：POSIX 上只是普通字符，Windows 上由 isUnsafeForCmd 拦下。
  mkdirSync(join(project, "percent%name"), { recursive: true });
  writeFileSync(outsideFile, "outside\n");
  // 指向根外真实文件的符号链接：realpath 逃逸校验的主力用例；平台不给建就跳过这一条。
  let symlinkOk = true;
  try {
    symlinkSync(outsideFile, join(project, "escape-link.txt"));
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

  // 越界 / 凭据 / 符号链接逃逸：全部在 spawn 之前被拒，日志一行都不该多。
  before = readLog().length;
  const refused = [
    { label: "越界 `../outside.txt`", path: "../outside.txt" },
    { label: "凭据 `.env`", path: ".env" },
    { label: "凭据 `.ssh/id_rsa`", path: ".ssh/id_rsa" },
  ];
  for (const item of refused) {
    const response = await plugin.onPanelInvoke("fm.editor.open", { path: item.path });
    check(`${item.label} 被拒`, response.ok === false, JSON.stringify(response));
  }
  if (symlinkOk) {
    const viaLink = await plugin.onPanelInvoke("fm.editor.open", { path: "escape-link.txt" });
    check("指向根外的符号链接被拒（SYMLINK_ESCAPE）", viaLink.ok === false, JSON.stringify(viaLink));
  } else {
    console.log("  skip 符号链接用例：这个平台不让建 symlink");
  }
  // 等一会儿再比较：万一真的 spawn 了，写日志是异步的，立刻比看不见。
  await sleep(200);
  const afterRefused = readLog().length;
  check("被拒的四个请求一条 spawn 记录都没产生", afterRefused === before, `多了 ${afterRefused - before} 字节`);

  // 含 `%` 的路径：POSIX 上只是普通字符，按普通目录打开；Windows 分支由纯函数覆盖。
  if (process.platform === "win32") {
    console.log("  skip 含 % 的路径只在 POSIX 上判可打开，Windows 侧由 isUnsafeForCmd 断言");
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
  const plugin = await loadPlugin(`${fakeDir}${delimiter}${realPath}`);

  // 固定清单而不是真随机：失败要能复现，用例要能一眼看懂。node_modules 刻意不在
  // 这里——read 模式下它不在黑名单里（只有写模式拒），而且它本来就在基点内，
  // 不属于「越界 / 凭据」这一类，单独一条断言它。
  const outOfJail = [
    "../outside.txt",
    "../../outside.txt",
    "../../../etc/passwd",
    "sub/../../outside.txt",
    "sub/./../../outside.txt",
    "..\\outside.txt",
    "/etc/passwd",
    "/",
    "/tmp",
    "escape-link.txt",
  ];
  const credentialNames = [
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

  const before = readLog().length;
  for (const path of outOfJail) {
    const response = await plugin.onPanelInvoke("fm.editor.open", { path });
    check(`越界被拒：${path}`, response.ok === false, JSON.stringify(response));
  }
  for (const path of credentialNames) {
    const response = await plugin.onPanelInvoke("fm.editor.open", { path });
    check(`凭据被拒：${path}`, response.ok === false, JSON.stringify(response));
  }
  // 同前：真的 spawn 了的话日志是异步写的，等一会儿再比。
  await sleep(200);
  const after = readLog().length;
  check("这一整批被拒的请求一条 spawn 记录都没产生", after === before, `多了 ${after - before} 字节`);

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

/** 3.7 性质：参数不经 shell（Correctness Property 2）。 */
async function verifyNoShell() {
  console.log("\n4. 性质：参数不经 shell（3.7）");
  const plugin = await loadPlugin(`${fakeDir}${delimiter}${realPath}`);

  // 合法条目名的固定清单：shell 元字符、不可打印字符、非 ASCII 各来几个。
  const safeNames = [
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

  for (const name of safeNames) {
    let created = true;
    try {
      mkdirSync(join(project, name));
    } catch {
      created = false;
    }
    // 平台不接受这个条目名（Windows 上的 `*` `?` `"` 之类）时只跳过这一条，不算失败。
    if (!created) {
      console.log(`  skip 这个平台不允许的条目名：${JSON.stringify(name)}`);
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

  // Windows 侧不需要真起 cmd.exe：命令串是纯函数拼的，任何平台都能断言。
  const commandLine = internals.windowsCommandLine("C:\\x\\code.cmd", "C:\\a b\\c.txt");
  check("windowsCommandLine 把两个路径各自用双引号包住", commandLine === '"C:\\x\\code.cmd" "C:\\a b\\c.txt"', commandLine);
  check("整串里只有这两对引号（引号跳不出去）", (commandLine.match(/"/g) ?? []).length === 4, commandLine);
  check("含 % 的路径被 isUnsafeForCmd 拦下", internals.isUnsafeForCmd("C:\\a%b\\c.txt") === true);
  check("含空格与 & 的普通路径不误伤", internals.isUnsafeForCmd("C:\\Program Files\\a&b\\c.txt") === false);
}

try {
  mkdirSync(fakeDir, { recursive: true });
  mkdirSync(emptyDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const fakeCode = makeFakeCode();

  await verifyDetection(fakeCode);
  await verifyArgumentsAndRoot();
  await verifyInsideRootOnly();
  await verifyNoShell();

  console.log(`\n${failures === 0 ? "REMOTE VERIFY PASSED" : `${failures} FAILURE(S)`}`);
} finally {
  // 假 `code`、日志与临时项目都要自己清掉（force 让「已经没了的」不报错）。
  rmSync(base, { recursive: true, force: true });
}

// 显式退出：即使还有句柄没释放，也不会把 npm 命令吊在这里。
process.exit(failures === 0 ? 0 : 1);
