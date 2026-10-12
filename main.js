"use strict";

/**
 * 文件管理器 — PI-Desktop 插件主进程
 *
 * 插件 id: pi.file-manager
 * 视图:    contributes.views[0] → views/index.html（右侧工作面板）
 *
 * 为什么用原生 node:fs：
 *   宿主的 pi.fs.* 网关做不到本插件的核心诉求——manifest.fs 的 write/delete
 *   在语法上就禁止整树通配（plugin-sdk fs-policy.ts isWholeTreePattern），任何
 *   一个能通过校验的窄 scope 都会让「保存」变成每次都弹权限确认；而 fs.list /
 *   fs.glob 还有条数上限、跳过 node_modules、屏蔽凭据路径，并且没有创建 /
 *   重命名 / 移动。官方文档也承认这个边界：brokered gate「约束不了插件进程里
 *   的直接 Node 访问」（docs/spec/05-security/01-security.md）。
 *
 * 因此本插件自己承担全部安全责任：
 *   ① 路径包含：规范化 + realpath 双重校验，拒绝 .. 与符号链接 / junction 逃逸
 *   ② 敏感路径黑名单：.env* / .ssh / *.pem / .git/** 等读写全拒
 *   ③ 原子写：临时文件 → fsync → chmod → rename，中断不留半写文件
 *   ④ 冲突检测：mtimeMs + size 作为乐观锁，外部改动过的文件不静默覆盖
 *   ⑤ 写入审计：追加到插件数据目录 write-audit.jsonl（宿主审计不到这条路径）
 *   ⑥ 上限：文本预览 2 MiB / 图片 8 MiB / 音视频 24 MiB / 写入 8 MiB /
 *      单目录 3000 条 / 搜索分页（后两类要走 base64，所以单独设限）
 *   ⑦ 宿主请求打开：宿主可以要求视图打开项目之外的文件（会话临时目录 / 附件，
 *      路径由宿主自己选定）。视图带 external: true 时才放行绝对路径，这条路径
 *      不做根内包含校验（它本来就在根外），黑名单与 realpath 检查照旧全量生效。
 *   ⑧ 项目组（0.5.0）：宿主可以把一个项目注册成多个本地文件夹（roots）。本插件
 *      同一时刻**只认一个** root 作为包含基点——当前选中的那个（记忆在
 *      prefs.projectRoots，按 projectId 记忆、缺 projectId 时按主根路径）。基点
 *      绝不放大成「整个组的并集」：换基点只是换一扇门，门后的规则一条不变。
 *   ⑨ git 联动（0.7.0）：状态与差异来自工作区里真实存在的 git（只读子命令
 *      status / diff / rev-parse，见下面「git 状态」一节），不是自己解析 .git/**。
 *      git 缺失 / 非仓库 / 超时都只是「没有状态」，绝不牵连列目录与读写。
 *   ⑩ 用 VS Code 打开（0.9.0）：由插件进程自己 spawn `code`（与 git 同一套惰性
 *      require + unref 后立即返回；不走宿主网关，因为宿主没有「交给某个具体命令行」
 *      这项能力）。只认 `PATH` 上的 `code` / `code.cmd`，**不做安装位置兜底**——
 *      替用户猜环境，猜错时就是「我改过 PATH，插件还是打开了那个我早删掉的 VS Code」
 *      这种没法解释的行为。Windows 上 `code.cmd` 是批处理文件、只能经 `cmd.exe` 起，
 *      所以那一支拒掉含 `%` 的路径（`%VAR%` 在双引号内照样展开，引号屏蔽不掉）。
 *
 * 通道：视图 window.pluginBridge.invoke("fm.*", payload) → onPanelInvoke。
 *   宿主对自定义通道的转发超时是 30s（plugin-runtime.ts PLUGIN_PANEL_TIMEOUT_MS），
 *   所以任何遍历类操作都必须分页，绝不整树递归返回。
 */

const fs = require("node:fs/promises");
const path = require("node:path");

// ── 上限 ────────────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_ENTRIES = 3000;
/** prefs.projectRoots 最多记多少个项目；超出按最久没用过的淘汰。 */
const MAX_PROJECT_ROOTS = 20;
const MAX_SEARCH_MATCHES = 60;
const MAX_SEARCH_SCANNED = 200000;
const SEARCH_BUDGET_MS = 3000;
const MAX_SEARCH_SESSIONS = 4;
const AUDIT_MAX_BYTES = 1024 * 1024;

/**
 * 图片 / 音视频走 data URI 交给视图：面板是 file:// 的沙箱页，没有文件系统，
 * 相对路径只会指向视图自身，所以字节必须随响应带过去（base64 会膨胀约 1/3，
 * 这也是这两类各有独立上限的原因）。
 *
 * 只列 Chromium 真能解码的格式。TIFF 故意不在列——浏览器放不出来，硬认成
 * 图片只会得到一张破图，让它落到二进制分支、明确说「不支持预览」更诚实。
 * SVG 走 <img>，脚本不会执行（图片上下文是只读渲染，不是文档上下文）。
 */
const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
]);

const MEDIA_MIME = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".ogv", "video/ogg"],
  [".mkv", "video/x-matroska"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/opus"],
  [".weba", "audio/webm"],
]);

// ── 敏感路径黑名单（读与写都拒绝） ──────────────────────────────────────────

const DENY_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".npmrc",
  ".git-credentials",
  ".netrc",
  "_netrc",
]);
const DENY_EXACT_NAMES = new Set([".env"]);
const DENY_NAME_PREFIXES = [".env.", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const DENY_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]);

/** 写入额外拒绝：依赖目录体量巨大且几乎不可能手改。 */
const WRITE_DENY_SEGMENTS = new Set(["node_modules"]);

/** 忽略规则文件名；项目里一个都没有时不过滤任何条目。 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore"];

// ── 模块状态 ────────────────────────────────────────────────────────────────

/**
 * mdPreview / csvTable / jsonTree 的默认值不同，是刻意的：
 * CSV 基本是纯数据，打开就想看表格；JSON 多半是 package.json / tsconfig.json
 * 这类配置，打开就想改文本。两边都只需点一下切换器换到另一侧。
 */
let dataPath = null;
let prefs = {
  splitRatio: 0.32,
  /** 左侧文件列表是否收起；宿主请求打开文件时视图会强制收起并持久化。 */
  treeCollapsed: false,
  showIgnored: false,
  /**
   * 监听外部改动并自动刷新（0.8.0）。默认开；用户可以随时关掉回到「只手动刷新」。
   * 主进程那边的 fs.watch 与视图的轮询都跟着这个偏好走。
   */
  watchFiles: true,
  mdPreview: false,
  csvTable: true,
  jsonTree: false,
  tablePageSize: 1000,
  /**
   * 项目组里「当前在看哪个 folder root」的记忆：projectKey → 绝对路径。
   * projectKey = `p:<projectId>`（宿主给了 projectId）或 `r:<主根路径>`；
   * 值必须命中宿主当前给的 roots 才被信任（否则退回主根），最多
   * MAX_PROJECT_ROOTS 条，按最近写入做 LRU 淘汰。见下面「项目组与基点」。
   */
  projectRoots: {},
};
const searchSessions = new Map();

// ── 错误 ────────────────────────────────────────────────────────────────────

function fail(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function toFailure(error) {
  return {
    ok: false,
    code: typeof error?.code === "string" ? error.code : "INTERNAL",
    message: String(error?.message ?? error),
  };
}

// ── 路径安全 ────────────────────────────────────────────────────────────────

/**
 * child 是否严格位于 parent 之内（child === parent 返回 false）。
 * Windows 下 path.relative 已按大小写不敏感比较公共前缀。
 */
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (!rel) return false;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function segmentsOf(relPath) {
  return String(relPath)
    .split("/")
    .filter((part) => part && part !== ".");
}

function isDenied(relPath, mode) {
  for (const segment of segmentsOf(relPath)) {
    const lower = segment.toLowerCase();
    if (DENY_SEGMENTS.has(lower)) return true;
    if (DENY_EXACT_NAMES.has(lower)) return true;
    if (DENY_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
    if (DENY_EXTENSIONS.has(path.extname(lower))) return true;
    if (mode === "write" && WRITE_DENY_SEGMENTS.has(lower)) return true;
  }
  return false;
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前基点：宿主给的组里**被选中**的那个 folder root。所有按相对路径解析的通道
 * （列表 / 读 / 写 / 新建 / 重命名 / 移动 / 搜索 / sqlite）都以它为包含基点。
 *
 * path / name 在 0.5.0 之前就是 workspace.path/name——那时只有一个根，也就是
 * 主根；现在多根时它是「当前选中的那个」。视图需要的组身份不在这里，见下面
 * projectGroup()：两者刻意分开，免得视图把「基点」当成「组的身份」来记忆。
 */
async function currentRoot() {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) return null;
  return rootPayload(workspace, selectedRootOf(workspace));
}

/**
 * 组形状：path / name 是组的**主根**（与 pi.workspace.get 完全一致），projectId
 * 与 roots 原样透传给视图（宿主没给就一个都不带）。视图只从这里认「这是哪个组、
 * 一共有哪些 folder」，当前看的是哪个由 prefs.projectRoots 推导。
 */
async function projectGroup() {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) return null;
  return rootPayload(workspace, primaryRootOf(rootsOf(workspace)));
}

/** 把一个 root 包成发给视图的形状（基点路径 + 名字 + 组信息）。 */
function rootPayload(workspace, root) {
  const group = groupRoots(workspace);
  return {
    path: root.path,
    name: root.name,
    ...(typeof workspace.projectId === "string" && workspace.projectId
      ? { projectId: workspace.projectId }
      : {}),
    ...(group ? { roots: group } : {}),
  };
}

/** 把相对根目录的正斜杠路径规范化；拒绝绝对路径与 `..` 段。 */
function normalizeRelative(relPath) {
  if (typeof relPath !== "string") throw fail("INVALID_PATH", "path must be a string");
  if (path.isAbsolute(relPath)) throw fail("ABSOLUTE_PATH", "absolute paths are not accepted");
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (segmentsOf(rel).some((part) => part === "..")) {
    throw fail("ESCAPE", "path escapes the project root");
  }
  return rel;
}

/**
 * 所有通道的唯一入口守卫。返回 { root, rootPath, abs, rel, isRoot }。
 */
async function resolveInsideRoot(relPath, { mode = "read", allowRoot = false } = {}) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;
  const rel = normalizeRelative(relPath);

  if (!rel) {
    if (!allowRoot) throw fail("INVALID_PATH", "the project root is not a valid target here");
    return { root, rootPath, abs: rootPath, rel: "", isRoot: true };
  }

  if (isDenied(rel, mode)) throw fail("DENIED_PATH", `refused path: ${rel}`);

  const abs = path.resolve(rootPath, rel);
  if (!isInside(rootPath, abs)) throw fail("ESCAPE", "path escapes the project root");

  let realRoot;
  try {
    realRoot = await fs.realpath(rootPath);
  } catch {
    realRoot = rootPath;
  }

  // 父目录必须真实存在且落在根内：这是符号链接 / junction 逃逸的主闸门。
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(abs));
  } catch {
    throw fail("NOT_FOUND", "parent directory does not exist");
  }
  if (realParent !== realRoot && !isInside(realRoot, realParent)) {
    throw fail("SYMLINK_ESCAPE", "parent directory resolves outside the project root");
  }

  if (await exists(abs)) {
    let realAbs;
    try {
      realAbs = await fs.realpath(abs);
    } catch {
      realAbs = abs;
    }
    if (realAbs !== realRoot && !isInside(realRoot, realAbs)) {
      throw fail("SYMLINK_ESCAPE", "path resolves outside the project root");
    }
  }

  return { root, rootPath, abs, rel, isRoot: false };
}

/** 绝对路径判定：POSIX 根、Windows 盘符、UNC（`\\server\share`）。 */
function isAbsolutePath(target) {
  return /^\//.test(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\");
}

/** 黑名单按 POSIX 段切分，所以外部路径里的 `\` 先统一成 `/`。 */
function denyPathOf(target) {
  return String(target).replace(/\\/g, "/");
}

/**
 * 项目之外的绝对路径——宿主请求视图打开的文件（会话临时目录 / 附件），路径由
 * 宿主自己选定，本来就在项目根外。
 *
 * 与 resolveInsideRoot 的唯一区别是不做根内包含校验：对这条路径做包含校验没有
 * 意义。黑名单照旧全量生效，而且「原始字符串 / 规范化后 / realpath 之后」各查
 * 一遍，免得 `..` 折叠或符号链接把 .ssh 这类段藏起来。
 */
async function resolveExternal(rawPath, mode) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw fail("INVALID_PATH", "path must be a non-empty string");
  }
  if (!isAbsolutePath(rawPath)) {
    throw fail("INVALID_PATH", "external mode requires an absolute path");
  }

  const abs = path.resolve(rawPath);
  if (isDenied(denyPathOf(rawPath), mode) || isDenied(denyPathOf(abs), mode)) {
    throw fail("DENIED_PATH", `refused path: ${abs}`);
  }

  // 父目录必须真实存在（写新文件也一样），且真实路径不在黑名单里。
  let realParent;
  try {
    realParent = await fs.realpath(path.dirname(abs));
  } catch {
    throw fail("NOT_FOUND", "parent directory does not exist");
  }
  if (isDenied(denyPathOf(realParent), mode)) {
    throw fail("DENIED_PATH", `refused path: ${realParent}`);
  }

  if (await exists(abs)) {
    let realAbs;
    try {
      realAbs = await fs.realpath(abs);
    } catch {
      realAbs = abs;
    }
    if (isDenied(denyPathOf(realAbs), mode)) {
      throw fail("DENIED_PATH", `refused path: ${realAbs}`);
    }
  }

  // rel 直接取绝对路径：外部路径没有「相对根」的形态，响应里的 path 就是它，
  // 视图把这个字符串原样带回来读写。
  return { abs, rel: abs };
}

/**
 * 读 / 写共用的目标解析。三种形态：
 *   payload 带 `external: true` → 项目外绝对路径（宿主请求打开它自己选定的文件）
 *   绝对路径                    → 组内某个 root 下的绝对路径（0.5.0，可跨 folder）
 *   其余                        → 相对「当前选中的 root」的路径
 */
async function resolveTarget(payload, mode) {
  const rawPath = payload?.path ?? "";
  if (payload?.external === true) return resolveExternal(rawPath, mode);
  if (isAbsolutePath(rawPath)) return resolveGroupAbsolute(rawPath, mode);
  return resolveInsideRoot(rawPath, { mode });
}

/**
 * 绝对路径的「组内」形态：宿主给的绝对路径可能落在同一个项目的另一个 folder
 * root 里。找到包含它的 root 就切过去，再按「相对那个 root」的路径走原有守卫——
 * 绝对路径本身绝不当基点用，包含基仍然是单独一个 root。
 *
 * 落在组外的一律拒绝。组外只有一条合法入口：视图显式带 `external: true` 的
 * 项目外路径，那条路仍归 resolveExternal 管。
 */
async function resolveGroupAbsolute(rawPath, mode) {
  const workspace = await pi.workspace.get();
  if (!workspace?.path) throw fail("NO_WORKSPACE", "no project is open");

  const abs = path.resolve(rawPath);
  const roots = rootsOf(workspace);
  const exact = matchRoot(roots, abs);
  const hit = exact ?? roots.find((entry) => isInside(entry.path, abs)) ?? null;
  if (!hit) {
    throw fail("ABSOLUTE_PATH", "absolute paths are only accepted under a registered folder root");
  }

  await selectRoot(workspace, hit.path);
  if (exact) return resolveInsideRoot("", { mode, allowRoot: true });
  return resolveInsideRoot(relativeToRoot(hit.path, abs), { mode });
}

// ── 项目组与基点（0.5.0） ────────────────────────────────────────────────────
//
// 宿主可以把一个项目注册成多个本地文件夹（roots）。本插件同一时刻只以「当前
// 选中的那个 root」为包含基点：.. / 符号链接 / 凭据黑名单这些规则一条都没放松，
// 只是换了扇门（绝不放大成「整个组的并集」）。
//
// 选中的是哪个：prefs.projectRoots 是**唯一**真相 —— projectKey → 绝对路径。
// projectKey 是 `p:<projectId>`（宿主给了 projectId 时）或 `r:<主根路径>`。视图
// 与主进程都按它推导基点，所以切基点必须先把这份记忆落盘，再发下一个通道请求。
//
/**
 * 去尾部分隔符、把反斜杠统一成正斜杠后的比较形态。
 *
 * 宿主给的目录是正斜杠（`C:/Users/me/Docs`），而这里（`sanitizePrefs`）会用 Node 的
 * `path.resolve()` 把记忆里的值写成反斜杠（`C:\Users\me\Docs`）。同一个目录的这两种
 * 写法必须算同一个目录，否则「切到 B 之后记住」在写盘那一刻就自己失效了：视图用原样
 * 字符串还能匹配（头部名字会换），这里匹配不上就退回主目录（列表不换）。
 */
function canonicalPath(target) {
  const trimmed = String(target).replace(/[\\/]+$/, "");
  return (trimmed || String(target)).replace(/\\/g, "/");
}

/** 同一个目录的两种写法（Windows 盘符 / 路径大小写、末尾斜杠）。 */
function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** roots 里按路径命中一个 root：先精确比，再忽略大小写比一次。 */
function matchRoot(roots, target) {
  return (
    roots.find((entry) => entry.path === target) ??
    roots.find((entry) => samePath(entry.path, target)) ??
    null
  );
}

/** 相对某个 root 的 POSIX 相对路径（调用前必须已确认落在该 root 内）。 */
function relativeToRoot(rootPath, abs) {
  return path.relative(rootPath, abs).split(path.sep).join("/");
}

/**
 * 宿主给的 roots 规整结果；宿主没送（或送来的全是垃圾）时返回 null —— 绝不自己
 * 造一个假的 roots 去骗视图。名字缺失时退回目录名。
 */
function groupRoots(workspace) {
  const raw = workspace?.roots;
  if (!Array.isArray(raw)) return null;
  const roots = [];
  for (const entry of raw) {
    if (!entry || typeof entry.path !== "string" || !entry.path) continue;
    roots.push({
      path: entry.path,
      name:
        typeof entry.name === "string" && entry.name
          ? entry.name
          : path.posix.basename(entry.path.replace(/\\/g, "/")),
      primary: entry.primary === true,
    });
  }
  return roots.length > 0 ? roots : null;
}

/** 内部的 root 列表：宿主没给 roots 时退化成一个根（主根 = workspace.path）。 */
function rootsOf(workspace) {
  const roots = groupRoots(workspace);
  if (roots) return roots;
  return [
    {
      path: workspace.path,
      name:
        typeof workspace.name === "string" && workspace.name
          ? workspace.name
          : path.posix.basename(workspace.path.replace(/\\/g, "/")),
      primary: true,
    },
  ];
}

function primaryRootOf(roots) {
  return roots.find((entry) => entry.primary === true) ?? roots[0];
}

/** 记忆键：优先 projectId；宿主没给就退回主根路径（前缀让两种键不会互相撞上）。 */
function projectKeyOf(workspace) {
  return typeof workspace.projectId === "string" && workspace.projectId
    ? `p:${workspace.projectId}`
    : `r:${workspace.path}`;
}

/**
 * 记忆一条「这个项目在看哪个 root」：重写一次就把这条挪到末尾，超过
 * MAX_PROJECT_ROOTS 条时丢最旧的。JS 对象保持字符串键的插入顺序，所以插入顺序
 * 本身就是最近使用顺序。
 */
function rememberProjectRoot(map, key, value) {
  const next = {};
  for (const [entryKey, entryValue] of Object.entries(map ?? {})) {
    if (entryKey === key || typeof entryValue !== "string") continue;
    next[entryKey] = entryValue;
  }
  next[key] = value;

  const keys = Object.keys(next);
  if (keys.length <= MAX_PROJECT_ROOTS) return next;
  const bounded = {};
  for (const entryKey of keys.slice(keys.length - MAX_PROJECT_ROOTS)) {
    bounded[entryKey] = next[entryKey];
  }
  return bounded;
}

/** 记忆里的 root 必须命中宿主当前给的 roots 才被信任，否则退回主根。 */
function selectedRootOf(workspace) {
  const roots = rootsOf(workspace);
  const remembered = (prefs.projectRoots ?? {})[projectKeyOf(workspace)];
  return (
    (typeof remembered === "string" ? matchRoot(roots, remembered) : null) ?? primaryRootOf(roots)
  );
}

/**
 * 换基点（绝对路径落在组里另一个 root 时用）。落盘是必须的：视图那边也按这份
 * 记忆推导基点，不写就会各说各话。返回基点是否真的变了。
 */
async function selectRoot(workspace, rootPath) {
  const key = projectKeyOf(workspace);
  const changed = !samePath((prefs.projectRoots ?? {})[key] ?? "", rootPath);
  prefs = { ...prefs, projectRoots: rememberProjectRoot(prefs.projectRoots, key, rootPath) };
  if (changed) dropRootScopedCaches();
  try {
    await pi.plugin.setSettings({ fmPrefs: prefs });
  } catch {
    /* 设置写不进去不影响本次请求：内存里的基点已经换了 */
  }
  return changed;
}

/**
 * 换基点后必须丢掉的两样按「相对路径」缓存的东西：SQLite 句柄与搜索会话——
 * 两个 root 下的同名相对路径根本不是同一个文件。
 */
function dropRootScopedCaches() {
  searchSessions.clear();
  for (const key of [...sqliteHandles.keys()]) closeSqliteHandle(key);
}

// ── 忽略规则（.gitignore / .ignore 语义子集） ────────────────────────────────
//
// 项目里存在忽略规则文件就按规则隐藏，一个都没有就全部展示。
// 子集支持：空行、# 注释、! 取反、末尾 / 仅目录、前导 / 锚定、* ? ** 通配、
// 无斜杠模式匹配任意层级。不支持 \ 转义与 [a-z] 字符类。

function compileIgnoreLine(rawLine, base) {
  let line = String(rawLine).replace(/\r$/, "");
  if (!line.trim() || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }

  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);

  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (!line) return null;
  const isAnchored = anchored || line.includes("/");

  let source = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "*") {
      if (line[index + 1] === "*") {
        index += 1;
        if (line[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }

  const pattern = isAnchored
    ? `^${source}(?:/.*)?$`
    : `^(?:.*/)?${source}(?:/.*)?$`;
  return { base, regex: new RegExp(pattern), negated, dirOnly };
}

async function readIgnoreFile(rootPath, relDir) {
  const dirAbs = relDir ? path.join(rootPath, relDir.split("/").join(path.sep)) : rootPath;
  const rules = [];
  for (const name of IGNORE_FILE_NAMES) {
    let text;
    try {
      text = await fs.readFile(path.join(dirAbs, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const rule = compileIgnoreLine(line, relDir);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/** 根 → 目标目录这一链上的全部规则（浅的在前，深的在后，深层优先）。 */
async function rulesForDirectory(rootPath, relDir) {
  const parts = segmentsOf(relDir);
  const chain = [""];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(parts.slice(0, index).join("/"));
  }
  const rules = [];
  for (const base of chain) {
    rules.push(...(await readIgnoreFile(rootPath, base)));
  }
  return rules;
}

/**
 * 命中判定。祖先目录被忽略则整体忽略（与 git 一致，取反无法把文件从
 * 被排除的目录里救回来）；否则由最后一条匹配的规则决定。
 */
function matchesRules(relPath, isDirectory, rules) {
  const parts = segmentsOf(relPath);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const target = parts.slice(0, depth).join("/");
    const targetIsDir = depth < parts.length || isDirectory;

    let verdict;
    for (const rule of rules) {
      let local = target;
      if (rule.base) {
        if (!target.startsWith(`${rule.base}/`)) continue;
        local = target.slice(rule.base.length + 1);
      }
      if (!local) continue;
      if (rule.dirOnly && !targetIsDir) continue;
      if (rule.regex.test(local)) verdict = !rule.negated;
    }

    if (verdict === undefined) continue;
    if (verdict) return true;
    if (depth === parts.length) return false;
  }
  return false;
}

// ── 审计 ────────────────────────────────────────────────────────────────────

async function audit(entry) {
  if (!dataPath) return;
  const file = path.join(dataPath, "write-audit.jsonl");
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  try {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size > AUDIT_MAX_BYTES) await fs.writeFile(file, line, "utf8");
    else await fs.appendFile(file, line, "utf8");
  } catch {
    /* 审计失败不应影响主流程 */
  }
}

// ── git 状态（0.7.0） ───────────────────────────────────────────────────────
//
// 文件列表里的「已修改 / 新增」标记，以及单个文件到底改了什么。
//
// 状态**不是自己解析 .git/** 得来的，而是跑工作区里真实存在的 git（只读子命令
// status / diff / rev-parse）。两条理由：
//   ① 索引格式（v2/v3/v4、扩展块、稀疏索引）、工作树状态、rename 检测、
//      .gitattributes 的 filters 与换行归一化，都要复刻一遍。自己算出来的状态
//      迟早和 git 对不上——而「和 git 对不上」正是这个功能的全部价值所在。
//   ② 插件进程跑在宿主给的最小环境里（child-process-env.ts 只放行 PATH 等少量
//      变量），git 就在 PATH 上，spawn 得到；状态也因此跟着用户的 git 版本走。
//
// 边界：
//   · 只跑只读子命令，从不传会写索引 / 联网的开关。GIT_OPTIONAL_LOCKS=0 让
//     status 不为了刷新索引去抢 .git/index.lock；GIT_TERMINAL_PROMPT=0 保证任何
//     意外的交互都变成一次立即失败，而不是把面板挂住。
//   · 每个子命令都有超时（5s）与输出上限，超了直接 kill。面板通道的总预算是 30s，
//     一次列表最多再叠一层 2s 的结果缓存。
//   · 路径仍然先过 resolveInsideRoot（根内包含 + 凭据黑名单）；传给 git 的是
//     **根相对**路径，并配 GIT_LITERAL_PATHSPECS=1——文件名里带 ":(top)" 之类
//     也不会被当成 pathspec 魔法。git 在这里只是被问了一句「这些文件怎么样」。
//   · git 缺失 / 当前文件夹不是仓库 / 超时 / 任何意外，都只是「没有状态」：
//     全部降级成 null，绝不影响列目录与读写。
//   · 子模块只看指针本身变没变（--ignore-submodules=none），不递归进子模块工作区。

const GIT_TIMEOUT_MS = 5000;
/** 同一 root 的结果缓存：一次展开目录往往连带好几次列表调用。 */
const GIT_SNAPSHOT_TTL_MS = 2000;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
/** 未跟踪文件的「全文都是新增」是自己读出来的，单独一个更紧的上限。 */
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;
const MAX_DIFF_LINES = 20000;
/** PATH 里没有 git 时的兜底（Windows 上 git 常不在 PATH 的前半段）。 */
const GIT_FALLBACK_BINARIES = [
  "/usr/bin/git",
  "/usr/local/bin/git",
  "/opt/homebrew/bin/git",
  "/opt/local/bin/git",
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
];

/** 状态严重度：目录汇总时取子树里最值得注意的那个（冲突 > 新增 > 删除 > …）。 */
const GIT_STATUS_RANK = {
  typechange: 1,
  modified: 2,
  renamed: 3,
  deleted: 4,
  added: 5,
  conflicted: 6,
};

let gitSpawn = null;
/**
 * 惰性拿 child_process.spawn：万一这个运行时不给（非 Node 宿主、被裁剪的构建），
 * 整个功能静默降级成「没有状态」，列目录照旧。
 */
function gitSpawnFn() {
  if (gitSpawn === null) {
    try {
      gitSpawn = require("node:child_process").spawn;
    } catch {
      gitSpawn = false;
    }
  }
  return gitSpawn || null;
}

/** 探测成功的 git 可执行文件；null = 还没试过。 */
let gitBinary = null;

function runGit(rootPath, binary, args, { maxBytes, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const spawn = gitSpawnFn();
  if (!spawn) return Promise.reject(fail("GIT_UNAVAILABLE", "child processes are unavailable"));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, {
        cwd: rootPath,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          // 只读三件套：别抢索引锁、别开分页器、别弹交互提示。
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          // 文件名里的 pathspec 魔法一律当普通字符。
          GIT_LITERAL_PATHSPECS: "1",
          LC_ALL: "C",
        },
      });
    } catch (error) {
      reject(error);
      return;
    }

    const chunks = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let stderr = "";
    let settled = false;

    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // 超量就掐掉：面板里没人看得完 8 MiB 的状态，掐掉还少占内存。
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2048) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      finish(resolve, {
        code: code ?? 0,
        stdout: Buffer.concat(chunks),
        truncated,
        timedOut,
        stderr,
      });
    });
  });
}

/**
 * 跑一条 git 命令。第一次用 PATH 里的 `git`；ENOENT 就按常见安装位置挨个试，
 * 找到就记住（每个插件进程一次）。
 */
async function runGitCommand(rootPath, args, options = {}) {
  const candidates = gitBinary ? [gitBinary] : ["git", ...GIT_FALLBACK_BINARIES];
  for (const binary of candidates) {
    let result;
    try {
      result = await runGit(rootPath, binary, args, options);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    gitBinary = binary;
    return result;
  }
  throw fail("GIT_UNAVAILABLE", "git was not found on PATH");
}

/**
 * `git status --porcelain=v1 -z` 的解析。两列状态 + 一个路径，NUL 分隔；重命名 /
 * 复制是**两条**记录：先「新路径」（带 XY 两列），紧跟一条只有原路径的裸记录。
 */
function parsePorcelainV1(stdout) {
  const records = [];
  const fields = stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    // 空字段是结尾的 NUL；长度不足或第三位不是空格的都是裸路径（重命名的原路径）。
    if (!field || field.length < 4 || field[2] !== " ") continue;
    const x = field[0];
    const y = field[1];
    const renamed = x === "R" || x === "C";
    const origPath = renamed ? fields[index + 1] ?? "" : null;
    if (renamed) index += 1;
    records.push({ x, y, path: field.slice(3), origPath });
  }
  return records;
}

/** 两列状态 → 一个用来显示的状态 + 「暂存区里也有没有」+「是不是全新文件」。 */
function classifyRecord(record) {
  const { x, y } = record;
  if (x === "?" || y === "?") return { status: "added", staged: false, untracked: true };
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return { status: "conflicted", staged: true, untracked: false };
  }
  if (x === "R" || x === "C") return { status: "renamed", staged: true, untracked: false };
  if (x === "A") return { status: "added", staged: true, untracked: false };
  if (x === "D") return { status: "deleted", staged: true, untracked: false };
  if (y === "D") return { status: "deleted", staged: false, untracked: false };
  if (x === "T" || y === "T") return { status: "typechange", staged: x === "T", untracked: false };
  if (x === "M" || y === "M") return { status: "modified", staged: x === "M", untracked: false };
  return null;
}

/**
 * `git diff --numstat -z` 的解析：每条 `+行数\t-行数\t路径`，二进制是 `-\t-`。
 * 重命名在 -z 下是 `+行\t-行\t`（路径留空）后面跟两条裸路径，原路径在前、新路径在后。
 */
function parseNumstat(stdout) {
  const stats = new Map();
  const fields = stdout.toString("utf8").split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const first = field.indexOf("\t");
    const second = first < 0 ? -1 : field.indexOf("\t", first + 1);
    if (second < 0) continue;
    const added = field.slice(0, first);
    const deleted = field.slice(first + 1, second);
    let filePath = field.slice(second + 1);
    if (!filePath) {
      // 重命名：紧跟的两条裸路径是 (原, 新)，统计挂在新路径上。
      filePath = fields[index + 2] ?? "";
      index += 2;
      if (!filePath) continue;
    }
    stats.set(filePath, {
      added: added === "-" ? 0 : Number(added) || 0,
      deleted: deleted === "-" ? 0 : Number(deleted) || 0,
      binary: added === "-" && deleted === "-",
    });
  }
  return stats;
}

/**
 * HEAD → 工作区的增删行数。一次 diff 就覆盖了「已暂存 + 未暂存」两层。
 * 仓库还没有任何提交（unborn HEAD）时 HEAD 不存在，退回「暂存区」与「工作区」
 * 两份再合并。
 */
async function gitNumstat(rootPath) {
  const options = { maxBytes: MAX_STATUS_BYTES };
  const head = await runGitCommand(rootPath, ["diff", "--numstat", "-z", "HEAD", "--"], options);
  if (head && head.code === 0) return parseNumstat(head.stdout);
  const [staged, worktree] = await Promise.all([
    runGitCommand(rootPath, ["diff", "--numstat", "-z", "--cached", "--"], options),
    runGitCommand(rootPath, ["diff", "--numstat", "-z", "--"], options),
  ]);
  const merged = new Map();
  for (const result of [staged, worktree]) {
    if (!result || result.code !== 0) continue;
    for (const [filePath, value] of parseNumstat(result.stdout)) merged.set(filePath, value);
  }
  return merged;
}

/**
 * 一次快照：这个工作区相对当前基点 root 的状态。
 *
 * files 的键是**根相对**路径（git 报的路径相对仓库根，而当前基点可能在仓库的
 * 子目录里，所以先减掉 `rev-parse --show-prefix` 给的前缀）；值是这一行要显示的
 * 状态与增删行数。快照为 null = 这里没有可用的状态（非仓库 / 没有 git / 出错）。
 */
async function buildGitSnapshot(rootPath) {
  const probe = await runGitCommand(rootPath, ["rev-parse", "--show-toplevel", "--show-prefix"], {
    maxBytes: 4096,
  });
  if (!probe || probe.code !== 0) return null;
  const probeLines = probe.stdout.toString("utf8").split("\n");
  if (!probeLines[0]) return null;
  const prefix = (probeLines[1] ?? "").trim();

  const [status, stats, branchResult] = await Promise.all([
    runGitCommand(
      rootPath,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ],
      { maxBytes: MAX_STATUS_BYTES },
    ),
    gitNumstat(rootPath),
    runGitCommand(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"], { maxBytes: 4096 }).catch(
      () => null,
    ),
  ]);
  if (!status || status.code !== 0) return null;

  const files = new Map();
  for (const record of parsePorcelainV1(status.stdout)) {
    if (prefix && !record.path.startsWith(prefix)) continue;
    const rel = prefix ? record.path.slice(prefix.length) : record.path;
    if (!rel) continue;
    const classified = classifyRecord(record);
    if (!classified) continue;
    const stat = stats.get(record.path);
    files.set(rel, {
      ...classified,
      added: stat?.added ?? 0,
      deleted: stat?.deleted ?? 0,
      // 未跟踪的文件没有 numstat（git 不知道它以前长什么样），行数留给差异视图去数。
      binary: Boolean(stat?.binary),
    });
  }

  return {
    rootPath,
    files,
    truncated: status.truncated,
    // unborn 仓库与游离 HEAD 都报 "HEAD"，那不是分支名。
    branch: branchResult?.code === 0 ? branchResult.stdout.toString("utf8").trim() : null,
  };
}

/** rootPath → { at, snapshot }；同一个 root 的并发请求共用一次 git。 */
let gitCache = new Map();

/** 本插件自己改过文件之后立刻作废缓存：状态必须跟着这次保存走。 */
function invalidateGitSnapshots() {
  gitCache = new Map();
}

async function gitSnapshotFor(rootPath) {
  const cached = gitCache.get(rootPath);
  if (cached?.pending) return cached.pending;
  if (cached && Date.now() - cached.at < GIT_SNAPSHOT_TTL_MS) return cached.snapshot;

  const pending = buildGitSnapshot(rootPath)
    // 快照失败只等于「没有状态」：绝不让它把列目录 / 打开文件带崩。
    .catch(() => null)
    .then((snapshot) => {
      gitCache.set(rootPath, { at: Date.now(), snapshot });
      return snapshot;
    });
  gitCache.set(rootPath, { at: cached?.at ?? 0, snapshot: cached?.snapshot ?? null, pending });
  return pending;
}

/**
 * 把子树里的变化汇总到直接子目录上：列目录时每个子目录要一个徽标，不能对每个
 * 目录都重扫一遍全部变化（3000 个条目 × 几万条变化会卡住面板）。这里只把每条
 * 变化归到它**第一段**路径上，一次遍历就够。
 */
function rollupByChildDirectory(snapshot, rel) {
  const prefix = rel ? `${rel}/` : "";
  const groups = new Map();
  for (const [filePath, info] of snapshot.files) {
    if (prefix && !filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) continue; // 直接子文件：它自己那行有状态
    const name = rest.slice(0, slash);
    const current = groups.get(name);
    if (!current) {
      groups.set(name, { ...info, changed: 1 });
      continue;
    }
    current.changed += 1;
    current.added += info.added;
    current.deleted += info.deleted;
    current.staged = current.staged || info.staged;
    current.untracked = current.untracked || info.untracked;
    if ((GIT_STATUS_RANK[info.status] ?? 0) > (GIT_STATUS_RANK[current.status] ?? 0)) {
      current.status = info.status;
    }
  }
  // 目录的徽标只显示状态与合计行数，binary 是单文件才有的细节。
  for (const group of groups.values()) delete group.binary;
  return groups;
}

/** 列表响应里那一句「多少处改动」：只算当前基点这个 root 里的变化。 */
function summarizeGit(snapshot) {
  const counts = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 };
  let total = 0;
  for (const info of snapshot.files.values()) {
    if (info.status in counts) counts[info.status] += 1;
    total += 1;
  }
  return {
    available: true,
    branch: snapshot.branch,
    counts,
    total,
    truncated: snapshot.truncated,
  };
}

/** 打开一个文件时问一句「它有没有改动」：列表收起时右侧也要有「变更」可看。 */
async function gitInfoFor(abs, rel) {
  if (!rel) return null;
  const root = await currentRoot();
  // 项目外（宿主自选的会话临时文件 / 附件）没有根内基点，与 git 无关。
  if (!root || !isInside(root.path, abs)) return null;
  const snapshot = await gitSnapshotFor(root.path);
  return snapshot?.files.get(rel) ?? null;
}

/**
 * unified diff → 可直接渲染的段落。返回行类型（add/del/ctx）而不是原始文本，
 * 视图不必再解析一遍，也就能在这里单测。
 */
function parseUnifiedDiff(text) {
  const meta = [];
  const hunks = [];
  let binary = false;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  const rawLines = text.split("\n");
  // git 的输出以换行收尾：split 出来的最后一个空串不是一行内容，丢掉它，
  // 否则每个文件末尾都会多出一行「空白的上下文」。
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  for (const line of rawLines) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!match) {
        hunk = null;
        continue;
      }
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        header: line,
        section: (match[5] ?? "").trim(),
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      // hunk 之前是文件头：diff --git / index / 模式变化 / 二进制提示。
      if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) binary = true;
      else if (line) meta.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      hunk.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ type: "del", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      hunk.lines.push({ type: "note", text: line.slice(1).trim(), oldLine: null, newLine: null });
    } else {
      hunk.lines.push({ type: "ctx", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return { meta, hunks, binary };
}

/**
 * 未跟踪文件的内容全是新增，git 自己不给差异（`--no-index` 还得造一个 /dev/null，
 * 跨平台不牢靠）。这里直接读文件、每行加前缀，语义与 git 的「新文件」一致。
 */
function untrackedDiff(text, truncated) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(0, MAX_DIFF_LINES);
  return {
    meta: ["--- /dev/null", truncated ? "+++ (truncated new file)" : "+++ (new file)"],
    binary: false,
    hunks: [
      {
        header: `@@ -0,0 +1,${kept.length} @@`,
        section: "",
        oldStart: 0,
        newStart: 1,
        lines: kept.map((line, index) => ({
          type: "add",
          text: line,
          oldLine: null,
          newLine: index + 1,
        })),
      },
    ],
  };
}

/**
 * 一个文件到底改了什么。已跟踪文件同时看「暂存区 → 工作区」与「HEAD → 暂存区」
 * 两段：只有一段有内容就只给这一段，两段都有就都列出来（标题写清楚哪来的）。
 */
async function handleGitDiff(payload) {
  // 一次解析就够：包含校验、凭据黑名单、基点都在 resolveInsideRoot 里。
  const { rootPath, abs, rel } = await resolveInsideRoot(payload?.path ?? "");
  if (!rel) throw fail("INVALID_PATH", "the project root has no changes to show");
  const snapshot = await gitSnapshotFor(rootPath);
  if (!snapshot) throw fail("GIT_UNAVAILABLE", "git status is unavailable in this folder");

  const info = snapshot.files.get(rel) ?? null;

  if (info?.untracked) {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw fail("NOT_FOUND", "file not found");
    if (stat.size > MAX_UNTRACKED_DIFF_BYTES) {
      return {
        ok: true,
        path: rel,
        kind: "tooLarge",
        untracked: true,
        limit: MAX_UNTRACKED_DIFF_BYTES,
        size: stat.size,
        addedLines: 0,
        deletedLines: 0,
        sections: [],
        truncated: true,
      };
    }
    const buffer = await fs.readFile(abs);
    // 含 NUL 字节 = 二进制：逐行加前缀毫无意义，直接说清楚。
    if (buffer.subarray(0, 4096).includes(0)) {
      return {
        ok: true,
        path: rel,
        kind: "binary",
        untracked: true,
        addedLines: 0,
        deletedLines: 0,
        sections: [],
        truncated: false,
      };
    }
    const parsed = untrackedDiff(buffer.toString("utf8"), buffer.length >= MAX_UNTRACKED_DIFF_BYTES);
    return {
      ok: true,
      path: rel,
      kind: "text",
      untracked: true,
      addedLines: parsed.hunks[0].lines.length,
      deletedLines: 0,
      sections: [{ scope: "worktree", ...parsed }],
      truncated: buffer.length >= MAX_UNTRACKED_DIFF_BYTES,
    };
  }

  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "-U3", "--", rel];
  const [worktree, staged] = await Promise.all([
    runGitCommand(rootPath, diffArgs, { maxBytes: MAX_DIFF_BYTES }),
    runGitCommand(
      rootPath,
      ["diff", "--no-color", "--no-ext-diff", "-U3", "--cached", "--", rel],
      { maxBytes: MAX_DIFF_BYTES },
    ),
  ]);
  if (!worktree || worktree.code !== 0) {
    throw fail("GIT_UNAVAILABLE", worktree?.stderr?.trim() || "git diff failed");
  }

  const sections = [];
  let addedLines = 0;
  let deletedLines = 0;
  // 整个响应的行数预算：超了就把后面的 hunk 丢掉并说清楚「已截断」——界面上那句
  // 「输出已截断」必须名副其实，否则用户会以为差异就这么多。
  let budget = MAX_DIFF_LINES;
  let truncated = false;

  for (const [scope, result] of [
    ["worktree", worktree],
    ["staged", staged],
  ]) {
    if (!result || result.code !== 0 || result.stdout.length === 0) continue;
    const parsed = parseUnifiedDiff(result.stdout.toString("utf8"));
    if (parsed.hunks.length === 0 && !parsed.binary) continue;

    if (parsed.binary) {
      sections.push({ scope, meta: parsed.meta, hunks: [], binary: true, truncated: false });
      continue;
    }

    const hunks = [];
    for (const hunk of parsed.hunks) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const lines = hunk.lines.slice(0, budget);
      budget -= lines.length;
      if (lines.length < hunk.lines.length) truncated = true;
      for (const line of lines) {
        if (line.type === "add") addedLines += 1;
        else if (line.type === "del") deletedLines += 1;
      }
      hunks.push({ ...hunk, lines });
    }
    sections.push({
      scope,
      meta: parsed.meta,
      hunks,
      binary: false,
      truncated: truncated || result.truncated,
    });
  }

  return {
    ok: true,
    path: rel,
    kind:
      sections.length === 0
        ? "none"
        : sections.some((section) => section.binary)
          ? "binary"
          : "text",
    untracked: false,
    status: info,
    addedLines,
    deletedLines,
    sections,
    truncated,
  };
}

// ── 文件监听（0.8.0） ───────────────────────────────────────────────────────
//
// 「文件在编辑器之外被改了」这条链路以前只能靠用户点刷新。现在主进程用 Node 的
// fs.watch 盯着**当前基点 root**（递归），把变化去抖成一串根相对路径，视图低频
// 轮询取走。为什么是「主进程 watch + 视图轮询」而不是别的形状：
//   · 宿主没有给插件「向视图推送」的通道（pi 上只有 ui.showToast / notify 这类
//     单向通知），视图只能自己来取；那就让主进程做监听、视图只取游标增量，
//     免得视图每秒在整棵树上 stat 一遍。
//   · fs.watch 是操作系统的原生通知（macOS FSEvents / Windows
//     ReadDirectoryChangesW / Linux inotify），比轮询便宜得多，也不占通道预算。
//
// 三件必须做对的事：
//   ① **不把自己的写当成外部改动**：保存走的是「临时文件 + rename」，监听一定会
//     报。照单全收的话，用户每按一次 Ctrl+S 就会把自己的文档重新装载一遍（光标
//     与滚动位置一起丢）。所以本插件每次写盘 / 新建 / 改名 / 移动 / 删除都先记一笔
//     （noteSelfWrite），这一笔在 SELF_WRITE_SUPPRESS_MS 内到达的事件被丢掉。
//   ② **不盯噪声**：.git/ 与 node_modules/ 的变化量极大且与本视图无关；凭据类路径
//     （.env* / .ssh / *.pem…）照旧不报——监听不是绕过黑名单的后门。
//   ③ **不丢事件、也不无限增长**：去抖窗口内的事件合并成一次；增量历史有界，
//     视图拿着很旧的游标回来时只可能拿到「最近这些」，它据此做的是保守刷新，
//     不会因为少看到一次就出错。

const WATCH_DEBOUNCE_MS = 250;
const WATCH_HISTORY_LIMIT = 400;
/** 本插件自己的写在这段时间内到达的同名事件被忽略。 */
const SELF_WRITE_SUPPRESS_MS = 1500;
const WATCH_SELF_WRITE_CACHE_LIMIT = 200;
/** 一次轮询最多报多少条变化（再多，视图「刷新所在目录」已经覆盖到了）。 */
const WATCH_MAX_CHANGED = 200;

let watchSupported = true;
let watcher = null;
let watchRevision = 0;
/** 增量历史：{ revision, path }，超过上限丢最旧的。 */
let watchHistory = [];
/** 去抖窗口里收到的事件（路径去重）。 */
let watchPending = new Set();
let watchTimer = null;
/** 根相对路径 → 本插件自己写它的时间戳。 */
const selfWrites = new Map();

let fsWatch = null;
/**
 * 惰性拿 fs.watch：万一这个运行时不给（非 Node 宿主、被裁剪的构建），功能静默
 * 降级成「只有手动刷新」，与 git 缺失是同一种降级方式。
 */
function fsWatchFn() {
  if (fsWatch === null) {
    try {
      fsWatch = require("node:fs").watch;
    } catch {
      fsWatch = false;
    }
  }
  return fsWatch || null;
}

/** 噪声与不该看的东西：.git / node_modules / 凭据路径 / 本插件的临时文件。 */
function isWatchIgnored(rel) {
  if (!rel) return false;
  // 任意一层出现 .git / node_modules 都跳（只看第一段会漏掉嵌套的依赖目录）。
  if (rel.split("/").some((segment) => segment === ".git" || segment === "node_modules")) return true;
  // 原子写的临时文件：`.README.md.1730abcd.ef12.tmp`（见 atomicWrite）。
  if (/^\..+\.[a-z0-9]+\.[a-z0-9]+\.tmp$/i.test(rel.split("/").pop() ?? "")) return true;
  return isDenied(rel, "read");
}

/** 本插件自己写下的这个路径刚被监听到了？ */
function isSelfWrite(rel) {
  const at = selfWrites.get(rel);
  if (at === undefined) return false;
  if (Date.now() - at > SELF_WRITE_SUPPRESS_MS) {
    selfWrites.delete(rel);
    return false;
  }
  return true;
}

/**
 * 本插件自己动了这个路径：接下来这一小段时间里它引起的事件不算「外部改动」。
 *
 * 除了这个路径，还要把它**每一层祖先目录**一起记上：Windows 的递归监听在我们写一个
 * 文件时，会额外给「它所在的每一层目录」各报一次 `change <目录>`——文件名是给了的，
 * 只是名字是目录而不是文件（实测：写 `src/deep/x.ts` 会报 `change src/deep` 与
 * `change src`）。这几笔不记下来，自己按一次 Ctrl+S 就会被这些多余的目录事件判成
 * 「外部改动」，刚保存的文档被重装一遍——正是这一节要防的事。根目录自身不发这种
 * 目录事件（实测），所以只记到最外层目录为止。
 */
function noteSelfWrite(rel) {
  if (!rel) return;
  const stamp = Date.now();
  selfWrites.set(rel, stamp);
  for (let cut = rel.lastIndexOf("/"); cut > 0; cut = rel.lastIndexOf("/", cut - 1)) {
    selfWrites.set(rel.slice(0, cut), stamp);
  }
  if (selfWrites.size > WATCH_SELF_WRITE_CACHE_LIMIT) {
    const now = Date.now();
    for (const [key, at] of selfWrites) {
      if (now - at > SELF_WRITE_SUPPRESS_MS) selfWrites.delete(key);
    }
  }
}

function flushWatchChanges() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watchPending.size === 0) return;
  const batch = [...watchPending];
  watchPending = new Set();
  for (const rel of batch) {
    if (isSelfWrite(rel)) continue;
    watchRevision += 1;
    watchHistory.push({ revision: watchRevision, path: rel });
  }
  if (watchHistory.length > WATCH_HISTORY_LIMIT) {
    watchHistory = watchHistory.slice(-WATCH_HISTORY_LIMIT);
  }
  // 磁盘变了，git 状态与增删行数也就变了：快照当场作废，下一次列表 / 差异现算。
  invalidateGitSnapshots();
}

function noteWatchChange(rel) {
  watchPending.add(rel);
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(flushWatchChanges, WATCH_DEBOUNCE_MS);
}

function stopWatching() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  watchPending = new Set();
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* 已经关掉了 */
    }
    watcher = null;
  }
}

/** 对着基点 root 开一只递归监听。同一时刻只有一只——换基点就是换监听对象。 */
function startWatching(rootPath) {
  if (watcher?.rootPath === rootPath) return true;
  stopWatching();
  const watch = fsWatchFn();
  if (!watch) {
    watchSupported = false;
    return false;
  }
  try {
    const handle = watch(
      rootPath,
      // persistent: false —— 监听不该让插件进程一直活着；没有变化时它可以自然退出。
      { recursive: true, persistent: false },
      (_eventType, filename) => {
        // 有些平台不提供文件名：那就只知道「根底下有东西变了」，把根本身报出去，
        // 视图据此刷新当前目录——宁可多刷一次，也不要漏掉一次。
        if (!filename) {
          noteWatchChange("");
          return;
        }
        const rel = String(filename).replace(/\\/g, "/");
        if (isWatchIgnored(rel)) return;
        noteWatchChange(rel);
      },
    );
    handle.on("error", () => {
      // 监听器自己出错了（例如根目录被删了）：退回手动刷新，不把错误抛给任何通道。
      stopWatching();
      watchSupported = false;
    });
    watcher = { rootPath, close: () => handle.close() };
    return true;
  } catch {
    // 老平台不支持 recursive watch：不假装能用，让视图把自动刷新关掉。
    watchSupported = false;
    return false;
  }
}

/**
 * 视图的轮询：拿「上次游标之后变了哪些路径」。
 *
 * 顺带做两件事——基点换了就换监听；去抖窗口快到点时把这一批现在就发出去（否则用户
 * 会多等一个去抖周期才看到刷新）。
 */
async function handleWatch(payload) {
  const root = await currentRoot();
  if (!root) return { ok: true, available: false, revision: watchRevision, changed: [] };

  if (watchSupported) startWatching(root.path);
  flushWatchChanges();

  const since = Number.isFinite(payload?.since) ? Number(payload.since) : 0;
  const changed = watchHistory
    .filter((entry) => entry.revision > since)
    .map((entry) => entry.path);

  return {
    ok: true,
    available: watchSupported && watcher !== null,
    revision: watchRevision,
    changed: changed.slice(0, WATCH_MAX_CHANGED),
    // 游标已经落到有界历史之外：视图据此也按「可能还有别的变化」做一次保守刷新。
    stale: since > 0 && watchHistory.length > 0 && since < watchHistory[0].revision,
  };
}

// ── 读 ──────────────────────────────────────────────────────────────────────

async function handleList(payload) {
  const { rootPath, abs, rel } = await resolveInsideRoot(payload?.path ?? "", {
    allowRoot: true,
  });

  const rules = await rulesForDirectory(rootPath, rel);

  let dirents;
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw fail("NOT_FOUND", "directory not found");
    if (error?.code === "ENOTDIR") throw fail("INVALID_PATH", "not a directory");
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw fail("DENIED_PATH", "permission denied");
    }
    throw error;
  }

  const entries = [];
  let truncated = false;

  for (const dirent of dirents) {
    if (dirent.name === ".git") continue;
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      break;
    }

    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (isDenied(childRel, "read")) continue;

    const childAbs = path.join(abs, dirent.name);
    const isSymlink = dirent.isSymbolicLink();
    const isDirectory = dirent.isDirectory();

    let size;
    let mtimeMs;
    try {
      const stat = isSymlink ? await fs.lstat(childAbs) : await fs.stat(childAbs);
      mtimeMs = stat.mtimeMs;
      if (!isDirectory) size = stat.size;
    } catch {
      continue;
    }

    let escapes = false;
    if (isSymlink) {
      try {
        const real = await fs.realpath(childAbs);
        escapes = real !== rootPath && !isInside(rootPath, real);
      } catch {
        escapes = true;
      }
    }

    entries.push({
      name: dirent.name,
      path: childRel,
      isDirectory: isDirectory && !isSymlink,
      size,
      mtimeMs,
      ignored: rules.length > 0 && matchesRules(childRel, isDirectory, rules),
      isSymlink,
      outside: escapes,
    });
  }

  entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });

  // git 状态：整个工作区一次算完（2s 缓存），文件各取各的，目录取子树的汇总。
  // 非仓库 / 没有 git 时 snapshot 为 null，整列就是 null——树照旧，只是没有徽标。
  const snapshot = await gitSnapshotFor(rootPath);
  const gitGroups = snapshot ? rollupByChildDirectory(snapshot, rel) : new Map();
  for (const entry of entries) {
    entry.git = snapshot
      ? entry.isDirectory
        ? gitGroups.get(entry.name) ?? null
        : snapshot.files.get(entry.path) ?? null
      : null;
  }

  return {
    ok: true,
    path: rel,
    entries,
    truncated,
    ignoreActive: rules.length > 0,
    git: snapshot ? summarizeGit(snapshot) : { available: false },
  };
}

/** base64 拼成 data URI——视图只能拿到字符串，不能拿到路径。 */
function asDataUri(mime, buffer) {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function handleRead(payload) {
  const { abs, rel } = await resolveTarget(payload, "read");

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw fail("NOT_FOUND", "file not found");
  if (stat.isDirectory()) throw fail("INVALID_PATH", "path is a directory");
  // 打开文件时也问一句 git：这个文件有没有改动。左侧列表收起时（宿主请求打开就会
  // 收起）树里没有这一行，右侧的「变更」入口不能跟着一起消失。
  const base = {
    path: rel,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    git: await gitInfoFor(abs, rel),
  };
  const extension = path.extname(rel).toLowerCase();

  // 数据库：只读 100 字节的头部就能认出它，所以这一支**不做体积限制**——
  // 几百 MB 的 .db 也会在这里秒开（真正的取数走 fm.sqlite.*，一次只拿一页）。
  // 扩展名像但魔数不对的（比如 Windows 的 thumbs.db 其实是 OLE 文件）继续按普通文件走。
  if (SQLITE_EXT.test(extension)) {
    const head = await readHead(abs, 100);
    if (isSqliteFile(head)) {
      return {
        ok: true,
        kind: "sqlite",
        available: loadSqlite() !== null,
        info: sqliteInfo(head, stat.size, await exists(`${abs}-wal`), await exists(`${abs}-journal`)),
        ...base,
      };
    }
  }

  // 图片与音视频返回 data URI：视图在 file:// 下拿不到项目里的文件，
  // 只能把字节随响应带过去。两类各自先做体积检查，避免读进内存再拒绝。
  const imageMime = IMAGE_MIME.get(extension);
  if (imageMime) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_IMAGE_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    return { ok: true, kind: "image", mime: imageMime, dataUri: asDataUri(imageMime, buffer), ...base };
  }

  const mediaMime = MEDIA_MIME.get(extension);
  if (mediaMime) {
    if (stat.size > MAX_MEDIA_BYTES) {
      return { ok: true, kind: "tooLarge", limit: MAX_MEDIA_BYTES, ...base };
    }
    const buffer = await fs.readFile(abs);
    return { ok: true, kind: "media", mime: mediaMime, dataUri: asDataUri(mediaMime, buffer), ...base };
  }

  // 其余扩展名一律按内容判断：超过上限 → tooLarge，含 NUL 字节 → binary。
  // zip / apk / exe 这类二进制会落到这里，视图只提示「不支持预览」。
  if (stat.size > MAX_READ_BYTES) {
    return { ok: true, kind: "tooLarge", limit: MAX_READ_BYTES, ...base };
  }

  const buffer = await fs.readFile(abs);
  if (buffer.subarray(0, 4096).includes(0)) return { ok: true, kind: "binary", ...base };

  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = (bom ? buffer.subarray(3) : buffer).toString("utf8");
  const eol = text.includes("\r\n") ? "crlf" : "lf";

  return {
    ok: true,
    kind: "text",
    text: eol === "crlf" ? text.split("\r\n").join("\n") : text,
    eol,
    bom,
    ...base,
  };
}

// ── 写 ──────────────────────────────────────────────────────────────────────

async function atomicWrite(abs, serialized, mode) {
  const dir = path.dirname(abs);
  const suffix = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(dir, `.${path.basename(abs)}.${suffix}.tmp`);

  let handle = null;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    // rename 会替换 inode，先把原文件权限位搬到临时文件上。
    if (mode != null) await fs.chmod(tmp, mode).catch(() => {});

    // Windows 上防病毒 / 索引器可能造成瞬态 EPERM / EBUSY。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, abs);
        return;
      } catch (error) {
        const transient =
          error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
        if (!transient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function handleWrite(payload) {
  const { abs, rel } = await resolveTarget(payload, "write");

  const text = typeof payload?.text === "string" ? payload.text : "";
  if (Buffer.byteLength(text, "utf8") > MAX_WRITE_BYTES) {
    throw fail("TOO_LARGE", "content exceeds the 8 MiB write limit");
  }

  const stat = await fs.stat(abs).catch(() => null);
  if (stat?.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  // 乐观锁：编辑器之外的改动绝不静默覆盖。
  if (stat && typeof payload?.expectedMtimeMs === "number") {
    const mtimeChanged = Math.abs(stat.mtimeMs - payload.expectedMtimeMs) > 0.5;
    const sizeChanged =
      typeof payload?.expectedSize === "number" && stat.size !== payload.expectedSize;
    if (mtimeChanged || sizeChanged) {
      return {
        ok: false,
        code: "CONFLICT",
        message: "the file changed on disk since it was opened",
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    }
  }

  let serialized = text;
  if (payload?.eol === "crlf") serialized = serialized.split("\n").join("\r\n");
  if (payload?.bom) serialized = `\uFEFF${serialized}`;

  await atomicWrite(abs, serialized, stat?.mode ?? null);

  const next = await fs.stat(abs);
  await audit({
    api: "fm.write",
    path: rel,
    bytes: Buffer.byteLength(serialized, "utf8"),
    result: "ok",
  });
  // 刚落盘的内容就是「工作区相对 HEAD 的改动」：状态缓存必须立刻作废，
  // 否则树里的徽标与右侧的差异要等 2s 之后才跟上。
  invalidateGitSnapshots();
  // 监听（0.8.0）会把「临时文件 + rename」报成一次外部改动；记一笔，视图就不会
  // 因为用户自己按的 Ctrl+S 而把文档重新装载一遍（那会丢光标与滚动位置）。
  noteSelfWrite(rel);

  return { ok: true, mtimeMs: next.mtimeMs, size: next.size };
}

// ── 新建 / 重命名 / 移动 / 删除 ────────────────────────────────────────────

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function assertValidName(rawName) {
  if (typeof rawName !== "string") throw fail("INVALID_NAME", "name is required");
  const name = rawName.trim();
function entryFromStat(name, rel, stat) {
  return {
    name,
    path: rel,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    mtimeMs: stat.mtimeMs,
    ignored: false,
    isSymlink: false,
    outside: false,
    // 新建 / 改名 / 移动之后这一行是全新的：状态由下一次列表调用现算。
    git: null,
  };
}
  return {
    name,
    path: rel,
    isDirectory: stat.isDirectory(),
    size: stat.isDirectory() ? undefined : stat.size,
    mtimeMs: stat.mtimeMs,
    ignored: false,
    isSymlink: false,
    outside: false,
  };
}

async function handleCreate(payload) {
  const parent = await resolveInsideRoot(payload?.parent ?? "", { allowRoot: true });
  const name = assertValidName(payload?.name);

  const childAbs = path.join(parent.abs, name);
  const childRel = parent.rel ? `${parent.rel}/${name}` : name;
  if (isDenied(childRel, "write")) throw fail("DENIED_PATH", `refused path: ${childRel}`);
  if (await exists(childAbs)) throw fail("EXISTS", "an entry with that name already exists");

  const isDirectory = Boolean(payload?.isDirectory);
  if (isDirectory) await fs.mkdir(childAbs);
  else await fs.writeFile(childAbs, "", { flag: "wx" });

  await audit({ api: "fm.create", path: childRel, result: "ok" });
  invalidateGitSnapshots(); // 新文件立刻就该有「新增」徽标。
  noteSelfWrite(childRel); // 监听别把这当成「外部新建」。
  return { ok: true, entry: entryFromStat(name, childRel, await fs.stat(childAbs)) };
}

async function handleRename(payload) {
  const source = await resolveInsideRoot(payload?.path ?? "", { mode: "write" });
  const name = assertValidName(payload?.newName);

  const parentRel = path.posix.dirname(source.rel);
  const dirPrefix = parentRel === "." ? "" : parentRel;
  const nextRel = dirPrefix ? `${dirPrefix}/${name}` : name;
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);

  const nextAbs = path.join(path.dirname(source.abs), name);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  await fs.rename(source.abs, nextAbs);
  await audit({ api: "fm.rename", path: `${source.rel} → ${nextRel}`, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(source.rel);
  noteSelfWrite(nextRel);
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

async function handleMove(payload) {
  const source = await resolveInsideRoot(payload?.from ?? "", { mode: "write" });
  const target = await resolveInsideRoot(payload?.toDir ?? "", { mode: "write", allowRoot: true });

  const targetStat = await fs.stat(target.abs).catch(() => null);
  if (!targetStat?.isDirectory()) throw fail("INVALID_PATH", "the destination is not a directory");
  if (source.abs === target.abs) return { ok: true, entry: null };

  // 不能把目录移进它自己的子孙。
  if (isInside(source.abs, target.abs)) {
    throw fail("INVALID_PATH", "cannot move a directory into itself");
  }

  const name = path.posix.basename(source.rel);
  const nextAbs = path.join(target.abs, name);
  const nextRel = target.rel ? `${target.rel}/${name}` : name;
  if (nextAbs === source.abs) return { ok: true, entry: null };
  if (isDenied(nextRel, "write")) throw fail("DENIED_PATH", `refused path: ${nextRel}`);
  if (await exists(nextAbs)) throw fail("EXISTS", "an entry with that name already exists");

  try {
    await fs.rename(source.abs, nextAbs);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    // 跨卷：复制 + 删除。
    await fs.cp(source.abs, nextAbs, { recursive: true, errorOnExist: true });
    await fs.rm(source.abs, { recursive: true });
  }

  await audit({ api: "fm.move", path: `${source.rel} → ${nextRel}`, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(source.rel);
  noteSelfWrite(nextRel);
  return { ok: true, entry: entryFromStat(name, nextRel, await fs.stat(nextAbs)) };
}

/**
 * 删除文件或目录。目录整体递归删除，删之前由视图弹确认框。
 *
 * 路径限制与写 / 新建 / 重命名 / 移动完全一致：resolveTarget(payload, "write")
 * 覆盖了项目内相对路径、组内绝对路径与 external 项目外路径三种形态，凭据黑名单
 * 与 node_modules 拒绝都在里面。根目录本身绝不能删——右键空白处的菜单也能走到
 * 这里，rel 为空就是根。
 */
async function handleDelete(payload) {
  const target = await resolveTarget(payload, "write");
  // 根目录本身绝不能删：右键空白处的菜单也能走到这里。
  if (!target.rel) throw fail("INVALID_PATH", "refusing to delete the project root");

  let stat;
  try {
    stat = await fs.lstat(target.abs);
  } catch {
    throw fail("NOT_FOUND", "entry does not exist");
  }

  await fs.rm(target.abs, { recursive: stat.isDirectory(), force: false });

  await audit({ api: "fm.delete", path: target.rel, result: "ok" });
  invalidateGitSnapshots();
  noteSelfWrite(target.rel);
  return { ok: true };
}

// ── 搜索（分页 + 会话游标） ─────────────────────────────────────────────────

function pruneSessions() {
  while (searchSessions.size > MAX_SEARCH_SESSIONS) {
    const oldest = [...searchSessions.entries()].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    )[0];
    if (!oldest) return;
    searchSessions.delete(oldest[0]);
  }
}

async function handleSearch(payload) {
  const root = await currentRoot();
  if (!root) throw fail("NO_WORKSPACE", "no project is open");
  const rootPath = root.path;

  const query = String(payload?.query ?? "").trim();
  if (!query) return { ok: true, matches: [], nextCursor: null, done: true, scanned: 0 };

  const cursor = typeof payload?.cursor === "string" ? payload.cursor : null;
  const limit = Math.min(Math.max(Number(payload?.limit) || MAX_SEARCH_MATCHES, 1), 200);

  let session = cursor ? searchSessions.get(cursor) : null;
  if (!session) {
    // 栈里是「目录帧」而不是目录路径：帧被完整扫完才出栈，否则命中上限时
    // 该目录剩余条目会被永久丢掉（分页会漏结果）。
    session = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      needle: query.toLowerCase(),
      stack: [{ dir: "", entries: null, index: 0, rules: [] }],
      scanned: 0,
    };
    searchSessions.set(session.id, session);
    pruneSessions();
  }

  const matches = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  const outOfBudget = () =>
    matches.length >= limit || Date.now() > deadline || session.scanned >= MAX_SEARCH_SCANNED;

  while (session.stack.length > 0) {
    if (outOfBudget()) break;

    const frame = session.stack.pop();
    if (!frame.entries) {
      const absDir = frame.dir
        ? path.join(rootPath, frame.dir.split("/").join(path.sep))
        : rootPath;
      frame.rules = await rulesForDirectory(rootPath, frame.dir);
      try {
        frame.entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        frame.entries = [];
      }
      frame.index = 0;
    }

    // 子目录先收集，等本帧处理完再入栈：直接在循环里 push 会让后面的
    // `pop()` 把刚压入的子帧弹掉，父帧则被反复重扫（死循环）。
    const children = [];
    while (frame.index < frame.entries.length) {
      if (outOfBudget()) break;

      const dirent = frame.entries[frame.index];
      frame.index += 1;

      if (dirent.name === ".git") continue;
      const childRel = frame.dir ? `${frame.dir}/${dirent.name}` : dirent.name;
      if (isDenied(childRel, "read")) continue;

      const isDirectory = dirent.isDirectory();
      if (frame.rules.length > 0 && matchesRules(childRel, isDirectory, frame.rules)) continue;

      session.scanned += 1;
      if (isDirectory && !dirent.isSymbolicLink()) {
        children.push({ dir: childRel, entries: null, index: 0, rules: [] });
      }
      if (
        dirent.name.toLowerCase().includes(session.needle) ||
        childRel.toLowerCase().includes(session.needle)
      ) {
        matches.push({ name: dirent.name, path: childRel, isDirectory });
      }
    }

    // 未扫完则原样回栈，下次续扫；扫完才释放目录列表。
    if (frame.index < frame.entries.length) session.stack.push(frame);
    else frame.entries = null;

    for (const child of children) session.stack.push(child);
  }

  const done = session.scanned >= MAX_SEARCH_SCANNED || session.stack.length === 0;
  if (done) searchSessions.delete(session.id);

  return {
    ok: true,
    matches,
    nextCursor: done ? null : session.id,
    done,
    scanned: session.scanned,
  };
}

// ── SQLite（只读浏览 + 查询） ───────────────────────────────────────────────
//
// 用 Node 内置的 node:sqlite。宿主是 Electron 43 / Node 24，模块存在（实测），
// 零依赖规则不破——和用 node:fs 同级。
//
// 为什么不像图片那样把字节搬给视图：.db 动辄几十上百 MB，只能留在主进程里查，
// 每次只把一页行发给视图。这是本插件唯一能打开「大文件」的预览类型。
//
// 只读是三层钉住的：
//   ① 打开时 { readOnly: true }
//   ② 打开后立刻 PRAGMA query_only = 1（实测：DROP / INSERT 都被 SQLite 拒绝，
//      报 "attempt to write a readonly database"）
//   ③ 语句白名单：只放行 SELECT / WITH / VALUES / EXPLAIN 与只读 PRAGMA，且必须是
//      单条语句——node:sqlite 的 prepare 对多语句是**放行**的（实测 "select 1; select 2"
//      只执行第一条、不报错），所以多语句必须自己拦。

const SQLITE_EXT = /\.(?:db|db3|sqlite|sqlite3)$/i;
const SQLITE_MAGIC = "SQLite format 3\u0000";
const SQLITE_MAX_ROWS = 5000;
const SQLITE_MAX_CELL = 4096;
const SQLITE_MAX_SQL = 20000;
const SQLITE_MAX_OFFSET = 100000;
const SQLITE_HANDLE_LIMIT = 2;
const SQLITE_IDLE_MS = 60000;
const ROWID = "rowid";

/** 只放行这些只读 PRAGMA；写性的（journal_mode 带值、writable_schema 等）不进白名单。 */
const READ_ONLY_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "database_list",
  "page_count",
  "page_size",
  "freelist_count",
  "encoding",
  "schema_version",
  "user_version",
  "compile_options",
  "collation_list",
]);

/** 这些词在 SQLite 里都是保留字，只能以关键字出现（列名同名必须加引号，而引号段会被跳过），
 *  所以扫到就是真的写语句，不会误伤。 */
const WRITE_VERBS = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "drop",
  "alter",
  "create",
  "attach",
  "detach",
  "vacuum",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
]);

/**
 * 拆出语句结构：首个关键字、出现的全部关键字、以及是不是多语句。
 * 引号段（'…' / "…" / `…` / […]）与注释整段跳过——不然 SQL 里的分号和关键字会把判定带偏。
 */
function analyzeSql(sql) {
  const keywords = [];
  const length = sql.length;
  let index = 0;
  let multiple = false;

  while (index < length) {
    const char = sql[index];

    if (char === "-" && sql[index + 1] === "-") {
      while (index < length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index += 2;
      while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      while (index < length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "[") {
      while (index < length && sql[index] !== "]") index += 1;
      index += 1;
      continue;
    }
    if (char === ";") {
      index += 1;
      // 分号后面还有非空白内容 → 多语句
      if (sql.slice(index).replace(/[\s;]/g, "").length > 0) multiple = true;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      keywords.push(sql.slice(index, end).toLowerCase());
      index = end;
      continue;
    }
    index += 1;
  }

  return { head: keywords[0] ?? "", keywords, multiple };
}

function assertReadOnlySql(sql) {
  if (!sql.trim()) throw fail("SQLITE_SQL_EMPTY", "the query is empty");
  if (sql.length > SQLITE_MAX_SQL) throw fail("SQLITE_SQL_TOO_LONG", "the query is too long");

  const { head, keywords, multiple } = analyzeSql(sql);
  if (multiple) throw fail("SQLITE_SQL_MULTIPLE", "only a single statement is allowed");
  if (!head) throw fail("SQLITE_SQL_EMPTY", "the query is empty");

  if (head === "select" || head === "values" || head === "explain") return;

  if (head === "with") {
    // WITH 可以给 INSERT/UPDATE/DELETE 当前缀，得再看一遍整句有没有写动词
    if (keywords.some((word) => WRITE_VERBS.has(word))) {
      throw fail("SQLITE_SQL_NOT_READ_ONLY", "only read-only statements are allowed");
    }
    return;
  }

  if (head === "pragma") {
    const name = keywords[1] ?? "";
    if (!READ_ONLY_PRAGMAS.has(name)) {
      throw fail("SQLITE_SQL_NOT_READ_ONLY", `pragma ${name || "?"} is not on the read-only list`);
    }
    return;
  }

  throw fail("SQLITE_SQL_NOT_READ_ONLY", "only select / with / values / explain are allowed");
}

/** 标识符加引号。名字一律来自我们自己读出的 schema，仍然转义一次——不给自己留例外。 */
function quoteIdent(name) {
  return `"${String(name).split('"').join('""')}"`;
}

let sqliteModule;
function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = require("node:sqlite");
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

/** rel 路径 → { db, mtimeMs, size, usedAt }；按 mtime + 体积判断句柄是否还新鲜。 */
const sqliteHandles = new Map();

function closeSqliteHandle(rel) {
  const entry = sqliteHandles.get(rel);
  if (!entry) return;
  sqliteHandles.delete(rel);
  try {
    entry.db.close();
  } catch {
    /* 关不上就算了，进程退出时会一并释放 */
  }
}

function pruneSqliteHandles() {
  while (sqliteHandles.size > SQLITE_HANDLE_LIMIT) {
    const oldest = [...sqliteHandles.entries()].sort(
      (left, right) => left[1].usedAt - right[1].usedAt,
    )[0];
    if (!oldest) return;
    closeSqliteHandle(oldest[0]);
  }
}

/** 读文件头（默认 100 字节）——只读这么点，所以 .db 再大也能秒开。 */
async function readHead(abs, bytes = 100) {
  let handle = null;
  try {
    handle = await fs.open(abs, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

const isSqliteFile = (head) =>
  head.length >= 16 && head.subarray(0, 16).toString("latin1") === SQLITE_MAGIC;

/** 100 字节头部 → 概览。页大小在偏移 16（大端 u16，值 1 表示 65536）。 */
function sqliteInfo(head, size, hasWal, hasJournal) {
  const u16 = (offset) => head.readUInt16BE(offset);
  const u32 = (offset) => head.readUInt32BE(offset);
  const encoding = u32(56);

  return {
    size,
    pageSize: head.length >= 18 ? (u16(16) === 1 ? 65536 : u16(16)) : 0,
    pageCount: head.length >= 32 ? u32(28) : 0,
    encoding: encoding === 2 ? "utf-16le" : encoding === 3 ? "utf-16be" : "utf-8",
    journalMode: head.length >= 19 && head[18] === 2 ? "wal" : "rollback",
    schemaVersion: head.length >= 44 ? u32(40) : 0,
    libraryVersion: head.length >= 100 ? u32(96) : 0,
    hasWal,
    hasJournal,
  };
}

async function sqliteFileInfo(abs, rel, stat) {
  const head = await readHead(abs, 100);
  if (!isSqliteFile(head)) return null;
  const hasWal = await exists(`${abs}-wal`);
  const hasJournal = await exists(`${abs}-journal`);
  return sqliteInfo(head, stat.size, hasWal, hasJournal);
}

/** 拿到（必要时打开）一个只读句柄。文件在外部被改过就重开，免得看到旧结构。 */
async function sqliteHandle(relPath) {
  const { abs, rel } = await resolveInsideRoot(relPath, { mode: "read" });

  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw fail("NOT_FOUND", "file not found");
  if (stat.isDirectory()) throw fail("INVALID_PATH", "path is a directory");

  const head = await readHead(abs, 100);
  if (!isSqliteFile(head)) throw fail("NOT_SQLITE", "this file is not a SQLite database");

  const sqlite = loadSqlite();
  if (!sqlite) throw fail("SQLITE_UNAVAILABLE", "this runtime does not provide node:sqlite");

  // 闲置太久就松手：插件进程不该一直攥着别的程序的数据库文件
  const now = Date.now();
  for (const [key, entry] of [...sqliteHandles.entries()]) {
    if (now - entry.usedAt > SQLITE_IDLE_MS) closeSqliteHandle(key);
  }

  const cached = sqliteHandles.get(rel);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cached.usedAt = Date.now();
    return { db: cached.db, rel, abs, stat };
  }
  if (cached) closeSqliteHandle(rel);

  const db = new sqlite.DatabaseSync(abs, { readOnly: true });
  try {
    db.exec("pragma query_only = 1");
    // SQLite 是懒打开：文件头合法但内容损坏时，直到第一次查询才报错。
    // 这里先踹一脚，让失败在 open 阶段就暴露出来。
    db.prepare("select count(*) as n from sqlite_master").get();
  } catch (error) {
    try {
      db.close();
    } catch {
      /* 打不开的句柄只能丢弃 */
    }
    if (error?.code === "ERR_SQLITE_ERROR") {
      throw fail("SQLITE_BROKEN", `SQLite could not read this file: ${error.message}`);
    }
    throw error;
  }

  sqliteHandles.set(rel, { db, mtimeMs: stat.mtimeMs, size: stat.size, usedAt: Date.now() });
  pruneSqliteHandles();
  return { db, rel, abs, stat };
}

function sqliteColumns(db, objectName) {
  const quoted = quoteIdent(objectName);
  let info;
  try {
    info = db.prepare(`pragma table_info(${quoted})`).all();
  } catch {
    return [];
  }
  return info.map((row) => ({
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    pk: Number(row.pk ?? 0) > 0,
    notNull: Number(row.notnull ?? 0) > 0,
  }));
}

/** 客户端取到的一律是字符串或 null（null 才是 SQL 的 NULL，空字符串是真的空串）。 */
function formatCell(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length > SQLITE_MAX_CELL ? `${value.slice(0, SQLITE_MAX_CELL)}…` : value;
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `[blob ${value.length} B]`;
  return String(value);
}

/** 用 iterate 只取需要的行——同步 API 没有中断接口，唯一能做的就是把取的行数掐死。 */
function takeRows(statement, limit) {
  const rows = [];
  let truncated = false;
  for (const row of statement.iterate()) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    rows.push(row.map(formatCell));
  }
  return { rows, truncated };
}

function statementColumns(statement) {
  try {
    const info = statement.columns() ?? [];
    return info.map((column) => ({
      name: String(column.name ?? ""),
      type: String(column.type ?? ""),
      pk: false,
      notNull: false,
    }));
  } catch {
    return [];
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

async function handleSqliteOpen(payload) {
  const { db, rel, abs, stat } = await sqliteHandle(payload?.path ?? "");

  const rows = db
    .prepare("select type, name, tbl_name, sql from sqlite_master order by type, name")
    .all();

  const objects = rows.map((row) => ({
    type: String(row.type ?? ""),
    name: String(row.name ?? ""),
    tableName: String(row.tbl_name ?? ""),
    sql: typeof row.sql === "string" ? row.sql : null,
  }));

  return {
    ok: true,
    path: rel,
    info: sqliteInfo(
      await readHead(abs, 100),
      stat.size,
      await exists(`${abs}-wal`),
      await exists(`${abs}-journal`),
    ),
    objects,
  };
}

async function handleSqliteRows(payload) {
  const { db, rel } = await sqliteHandle(payload?.path ?? "");

  const requested = typeof payload?.object === "string" ? payload.object : "";
  const objects = db
    .prepare("select type, name from sqlite_master where type in ('table','view')")
    .all();
  // 对象名绝不直接进 SQL：先在 schema 清单里核对，再拼引号
  const target = objects.find((row) => String(row.name) === requested);
  if (!target) throw fail("SQLITE_NO_SUCH_OBJECT", `no such table or view: ${requested}`);

  const name = String(target.name);
  const columns = sqliteColumns(db, name);
  const known = new Set(columns.map((column) => column.name));

  let orderBy = typeof payload?.orderBy === "string" ? payload.orderBy : "";
  if (orderBy && orderBy !== ROWID && !known.has(orderBy)) orderBy = "";
  const direction = payload?.direction === "desc" ? "DESC" : "ASC";

  const pageSize = clampInt(payload?.pageSize, 1, SQLITE_MAX_ROWS, 1000);
  const page = clampInt(payload?.page, 1, 1e6, 1);
  const offset = (page - 1) * pageSize;
  if (offset > SQLITE_MAX_OFFSET) {
    throw fail("SQLITE_OFFSET_LIMIT", "this page is beyond the browsing limit");
  }

  const order = orderBy
    ? ` ORDER BY (${quoteIdent(orderBy)} IS NULL), ${quoteIdent(orderBy)} ${direction}`
    : "";
  const limit = pageSize + 1; // 多取一行，用来判断还有没有下一页

  let statement;
  let withRowid = true;
  try {
    statement = db.prepare(
      `SELECT ${ROWID}, * FROM ${quoteIdent(name)}${order} LIMIT ${limit} OFFSET ${offset}`,
    );
  } catch {
    // 视图或 WITHOUT ROWID 表没有 rowid，退回普通取数
    withRowid = false;
    statement = db.prepare(`SELECT * FROM ${quoteIdent(name)}${order} LIMIT ${limit} OFFSET ${offset}`);
  }
  statement.setReturnArrays(true);

  const { rows } = takeRows(statement, limit);
  const hasMore = rows.length > pageSize;

  let estimate = null;
  if (String(target.type) === "table") {
    try {
      const row = db.prepare(`SELECT max(rowid) AS m FROM ${quoteIdent(name)}`).get();
      estimate = typeof row?.m === "number" ? row.m : null;
    } catch {
      estimate = null;
    }
  }

  const resultColumns = withRowid
    ? [{ name: ROWID, type: "INTEGER", pk: true, notNull: true }, ...columns]
    : columns;

  return {
    ok: true,
    path: rel,
    object: name,
    kind: String(target.type),
    columns: resultColumns,
    rows: rows.slice(0, pageSize),
    page,
    pageSize,
    hasMore,
    estimate,
    hasRowid: withRowid,
  };
}

async function handleSqliteQuery(payload) {
  const { db, rel } = await sqliteHandle(payload?.path ?? "");

  const sql = typeof payload?.sql === "string" ? payload.sql.trim() : "";
  assertReadOnlySql(sql);

  const limit = clampInt(payload?.limit, 1, SQLITE_MAX_ROWS, 500);
  const started = Date.now();

  let statement;
  try {
    statement = db.prepare(sql);
  } catch (error) {
    throw fail("SQLITE_SQL_ERROR", String(error?.message ?? error));
  }

  statement.setReturnArrays(true);
  const columns = statementColumns(statement);

  let rows = [];
  let truncated = false;
  try {
    ({ rows, truncated } = takeRows(statement, limit));
  } catch (error) {
    throw fail("SQLITE_SQL_ERROR", String(error?.message ?? error));
  }

  return {
    ok: true,
    path: rel,
    columns,
    rows,
    truncated,
    elapsedMs: Date.now() - started,
  };
}

// ── 偏好 ────────────────────────────────────────────────────────────────────

function sanitizePrefs(partial) {
  const next = { ...prefs };
  if (partial && typeof partial === "object") {
    if (typeof partial.splitRatio === "number" && Number.isFinite(partial.splitRatio)) {
      next.splitRatio = Math.min(Math.max(partial.splitRatio, 0.15), 0.7);
    }
    if (typeof partial.treeCollapsed === "boolean") next.treeCollapsed = partial.treeCollapsed;
    if (typeof partial.showIgnored === "boolean") next.showIgnored = partial.showIgnored;
    if (typeof partial.watchFiles === "boolean") next.watchFiles = partial.watchFiles;
    if (typeof partial.mdPreview === "boolean") next.mdPreview = partial.mdPreview;
    if (typeof partial.csvTable === "boolean") next.csvTable = partial.csvTable;
    if (typeof partial.jsonTree === "boolean") next.jsonTree = partial.jsonTree;
    // 表格每页行数：夹到 100–5000 并对齐到 100。视图的下拉框只提供几档固定值，
    // 这里不跟着枚举走（main.js 不该知道视图的选项表），夹紧就够了。
    if (typeof partial.tablePageSize === "number" && Number.isFinite(partial.tablePageSize)) {
      const rounded = Math.round(partial.tablePageSize / 100) * 100;
      next.tablePageSize = Math.min(Math.max(rounded, 100), 5000);
    }
    // 项目组里「当前在看哪个 folder root」的记忆：projectKey → 绝对路径。
    // 只收字符串值（不做真值转换）、只收绝对路径，并保持有界（LRU，见上）。
    // 值是不是「宿主当前给的某个 root」不在这里判——那是推导基点时的事
    // （selectedRootOf），这里只保证形状。
    if (
      partial.projectRoots &&
      typeof partial.projectRoots === "object" &&
      !Array.isArray(partial.projectRoots)
    ) {
      for (const [key, value] of Object.entries(partial.projectRoots)) {
        if (!key || typeof value !== "string" || !isAbsolutePath(value)) continue;
        next.projectRoots = rememberProjectRoot(next.projectRoots, key, path.resolve(value));
      }
    }
  }
  return next;
}

async function handlePrefsSet(payload) {
  const partial = payload?.partial;
  // 只有动了 root 记忆才需要知道当前项目是谁（并顺手丢掉按相对路径缓存的
  // 搜索会话与 SQLite 句柄——两个 root 下的同名相对路径不是同一个文件）。
  const touchesRoots = Boolean(partial && typeof partial === "object" && "projectRoots" in partial);
  let key = null;
  let previous;
  if (touchesRoots) {
    const workspace = await pi.workspace.get().catch(() => null);
    key = workspace?.path ? projectKeyOf(workspace) : null;
    if (key) previous = (prefs.projectRoots ?? {})[key];
  }

  prefs = sanitizePrefs(partial);

  if (key && (prefs.projectRoots ?? {})[key] !== previous) dropRootScopedCaches();

  await pi.plugin.setSettings({ fmPrefs: prefs });
  return { ok: true, prefs };
}

async function handleHello() {
  // 组形状（主根）+ 偏好。这里**不是**当前基点：视图按 workspace.get 的同一形状
  // 认这个字段，基点由 prefs.projectRoots 推导（两条投递路径形状一致，
  // 「r:<主根路径>」这个记忆键才是稳的）。
  const root = await projectGroup();
  return {
    ok: true,
    root,
    limits: {
      maxReadBytes: MAX_READ_BYTES,
      maxWriteBytes: MAX_WRITE_BYTES,
      maxListEntries: MAX_LIST_ENTRIES,
    },
    ignoreFiles: IGNORE_FILE_NAMES,
    // 这个运行时能不能监听：不能的话视图把「自动刷新」开关显示成不可用，
    // 而不是让用户开了却永远没反应。
    watch: { available: watchSupported && fsWatchFn() !== null },
    // VS Code 命令行探测结果：拿到 null 时视图把入口置灰并说明原因。
    editor: { binary: await resolveEditorBinary() },
    prefs,
  };
}

// ── 打开 VS Code ─────────────────────────────────────────────────────────────

/*
 * 为什么由插件进程自己 spawn，而不是走宿主：
 *   宿主的两个同类能力（fs.openDefault / fs.reveal）只表达「用默认应用打开」与
 *   「在文件管理器里显示」，没有「交给某个具体命令行」这一项，所以这里和 git 是
 *   同一套做法——自己起子进程、拿到「起得来」的信号就 unref 放走，不等它退出。
 *
 * 换来的是路径安全要自己扛（宿主那道闸帮不上忙），所以目标一律先过
 * resolveInsideRoot：根内包含、凭据黑名单、realpath 逃逸校验一条都不少。
 * POSIX 上参数走数组直传；Windows 上 code.cmd 只能经 cmd.exe，那一支拒掉含 % 的路径。
 *
 * 探测只认 PATH：不做安装位置兜底。把 /Applications/Visual Studio Code.app/... 或
 * /snap/bin/code 写死进插件，等于替用户猜他的环境；猜错时的表现是「我明明改过
 * PATH，插件还是打开了那个我早就删掉的 VS Code」，用户没法解释也没法修。PATH 是
 * 用户自己的契约，插件只读它、不绕过它；找不到就把话说清楚（message 里点名 PATH）。
 */

/** 启动 code 的等待上限（毫秒）：只等「进程起得来」这一个信号，不等它跑完。 */
const EDITOR_TIMEOUT_MS = 5000;

/**
 * `code` 命令行的探测结果，进程级缓存一次：
 *   undefined = 还没探测过；null = 探测过但 PATH 上没有；字符串 = 命中的路径。
 * 缓存不只是省开销：插件进程的 PATH 在它整个生命周期里不会变，所以这个结论不会
 * 过期；反过来说，用户改了 PATH 必须重新加载插件才生效——这一点得说在提示里，
 * 否则会被当成插件坏了。
 */
let editorBinary;

/**
 * 在 PATH 列出的目录里找 VS Code 命令行（POSIX `code`、Windows `code.cmd`），
 * 返回命中的路径或 null。纯查找：不启动进程问 `--version`（`code` 在 macOS /
 * Linux 上就是个 shell 脚本，为了探测而启动它纯属浪费），也不看任何安装位置。
 */
async function resolveEditorBinary() {
  // 已经探测过就直接用缓存，含「探测过但没找到」这个结论。
  if (editorBinary !== undefined) return editorBinary;

  // Windows 上找 code.cmd：它是 VS Code 安装程序放进 PATH 的那一个，而 Code.exe
  // 在安装根目录、通常不在 PATH 上。大小写交给文件系统（Windows 默认不敏感）。
  const name = process.platform === "win32" ? "code.cmd" : "code";

  for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
    // PATH 里的空段（连续分隔符 / 结尾分隔符）不是「当前目录」，跳过。
    if (!dir) continue;
    // 该目录下的候选路径；命中判定见 isEditorCandidate（两个平台判的东西不一样）。
    const candidate = path.join(dir, name);
    // 命中即停并缓存；这个结论在本次插件进程里不再复核。
    if (await isEditorCandidate(candidate)) {
      editorBinary = candidate;
      return editorBinary;
    }
  }

  // 一个都没命中：判为「PATH 上没有 code」，同样缓存，别每次调用都重扫一遍。
  editorBinary = null;
  return editorBinary;
}

/**
 * 单个候选的命中判定。POSIX 要求可执行位；Windows 上 `code.cmd` 是批处理文件、
 * 根本没有执行位（`X_OK` 恒真），只能判「存在且是普通文件」。
 */
async function isEditorCandidate(candidate) {
  try {
    // Windows 分支：只认文件，排除同名的目录。
    if (process.platform === "win32") return (await fs.stat(candidate)).isFile();
    await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    // stat / access 抛错只是「这个候选不行」，继续看下一个目录。
    return false;
  }
}

/**
 * Windows 上启动 `code.cmd` 要用的命令解释器。优先取 `ComSpec`（系统自己声明的
 * 那个）；没有它就按 `%SystemRoot%` 拼默认位置——这是 Windows 上唯一有契约保证的
 * 地方。两个环境变量都缺席时返回 null：宁可报「不可用」，也不猜一个别的解释器去跑
 * 用户的项目。
 */
function comSpecPath() {
  if (process.env.ComSpec) return process.env.ComSpec;
  if (process.env.SystemRoot) return path.join(process.env.SystemRoot, "System32", "cmd.exe");
  return null;
}

/**
 * Windows 上不能安全交给 cmd.exe 的路径：`%` 是 cmd 的变量展开符，而它在双引号
 * **内**照旧展开，`"%PATH%"` 一样会被替换。引号屏蔽不掉，所以含 `%` 的路径整条
 * 拒掉，不试图转义（转义规则本身就是 cmd 版本的坑）。
 */
function isUnsafeForCmd(targetPath) {
  return targetPath.includes("%");
}

/**
 * 拼交给 `cmd.exe /c` 的命令串：两个路径各自双引号包裹。
 *
 * 注意这是**内层**形态：`cmd.exe` 的 `/s` 规则是「命令串首字符是引号就剥掉最外层那
 * 一对」，所以真正传给 spawn 的参数要在外面再套一层引号（见 spawnDetached），剥完
 * 剩下的正好是这里的两个带引号路径。
 *
 * 之所以敢这么做：Windows 的文件名不允许 `"`，所以引号跳不出去；`&`、`|`、`>`、
 * `<`、`^` 在双引号内都是字面量。唯一漏下的是 `%`，由 isUnsafeForCmd 提前拦掉。
 */
function windowsCommandLine(codeCmdPath, targetPath) {
  return `"${codeCmdPath}" "${targetPath}"`;
}

/**
 * 起一个脱离插件的 code 进程并立刻返回。
 *
 * POSIX 分支：参数只走数组、`shell: false`，绝不让 Node 从数组拼一根命令串（那样
 * 空格与元字符就又变成语法了）。
 *
 * Windows 分支是刻意的让步：`code.cmd` 是批处理文件，`CreateProcess` 不能直接执行它，
 * `shell: false` 直接 spawn 会以 EINVAL 失败，只能显式启动 `cmd.exe`。这里有两个必须
 * 同时满足的条件，少一个都起不来：
 *   ① 命令串外面再套一层引号——`cmd.exe /s` 会剥掉最外层那一对，剥完剩下的才是
 *      「两个带引号路径」；
 *   ② `windowsVerbatimArguments: true`——否则 libuv 会按 MSVC 规则把我们已经拼好的
 *      引号再转义一遍（内嵌 `"` 变成 `\"`），而 cmd.exe 不认 `\"`，命令行会被毁掉。
 */
async function spawnDetached(binary, targetPath) {
  const spawn = gitSpawnFn();
  // 运行时不给 child_process（非 Node 宿主 / 被裁剪的构建）时按「起不来」失败，
  // 与 git 一侧同样的降级方式。
  if (!spawn) throw fail("EDITOR_UNAVAILABLE", "child processes are unavailable");

  // 只有 Windows 需要先拿到命令解释器；POSIX 直接跑命中的那个可执行文件。
  const isWindows = process.platform === "win32";
  let command;
  let args;
  if (isWindows) {
    command = comSpecPath();
    // ComSpec 与 SystemRoot 都缺席：不猜解释器，直接说不可用。
    if (!command) throw fail("EDITOR_UNAVAILABLE", "no command interpreter is available");
    // /d 关掉 AutoRun（注册表里的 AutoRun 会先于我们跑一遍）；
    // 刻意不传 /v，让 `!` 保持字面量（传了就是延迟展开打开）。
    args = ["/d", "/s", "/c", `"${windowsCommandLine(binary, targetPath)}"`];
  } else {
    // POSIX：命中什么就跑什么，参数是单元素数组，路径原样送达。
    command = binary;
    args = [targetPath];
  }

  // 先声明再在 try 里赋值：这里要接住的是 spawn 的同步抛错。
  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      // Windows 上命令行是我们自己拼的，必须让 libuv 原样传递；POSIX 不需要这个开关。
      windowsVerbatimArguments: isWindows,
    });
  } catch (error) {
    // spawn 同步抛出（参数类型不对之类）：折算成视图能看的失败，别让异常裸奔。
    throw editorSpawnError(error);
  }

  // 交还给系统：插件不持有这个进程，也不等它退出。
  child.unref();
  return waitForSpawn(child);
}

/**
 * 等子进程给出「起得来」或「起不来」的信号。`'spawn'` 事件算成功——目标不存在
 * （ENOENT）、没有执行权限（EACCES）这些只可能从 `'error'` 事件上来，所以不必等
 * `'close'`（code 会把请求转给已有实例后自己退出，等它反而慢）。超时算失败但
 * **不 kill**：进程已经交给系统了，杀它只会杀掉一个正在打开编辑器的 code。
 */
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    // 只认第一个到达的信号：超时与 error 会赛跑，先到的那个决定结果。
    let settled = false;
    const finish = (settle, value) => {
      // 已经有结论就直接返回：晚到的信号不再改判（例如判超时之后 spawn 才到）。
      if (settled) return;
      settled = true;
      // 无论成功、失败还是超时都要清掉定时器，否则它会吊住插件进程不退出。
      clearTimeout(timer);
      settle(value);
    };

    // 计时器与下面两个事件共用 finish 这一个收敛点，谁先到都算数。
    const timer = setTimeout(
      () => finish(reject, fail("EDITOR_TIMEOUT", "timed out starting the code command")),
      EDITOR_TIMEOUT_MS,
    );

    // 起得来：事件一到就放行，不等进程退出（它自己会把请求转给已有实例）。
    child.once("spawn", () => finish(resolve, undefined));
    // 起不来：ENOENT / EACCES 从这里上来，交给 editorSpawnError 折算。
    child.once("error", (error) => finish(reject, editorSpawnError(error)));
  });
}

/**
 * 启动失败的折算。ENOENT / EACCES 说明「这条 code 命令起不来」（探测之后文件被删、
 * 或者路径不可执行），统一报 EDITOR_UNAVAILABLE；其余错误原样上抛，交给 toFailure
 * 归类成 INTERNAL——不把没见过的情况也说成「没装 VS Code」。
 */
function editorSpawnError(error) {
  // 只看 Node 给的 errno 码：靠它区分「这条命令起不来」与「其它没见过的错」。
  const code = error?.code;
  // 两种错误都只是「起不来」，对用户是同一件事：入口不可用。
  if (code === "ENOENT" || code === "EACCES") {
    return fail("EDITOR_UNAVAILABLE", "the code command could not be started");
  }
  return error;
}

/**
 * `fm.editor.open`：把目标路径交给 VS Code。
 */
async function handleEditorOpen(payload) {
  // 省略 / 空串 = 基点文件夹自身（视图在空白处右键走的就是这条分支）。
  const target = typeof payload?.path === "string" ? payload.path : "";
  // 复用唯一入口守卫：根内包含、凭据黑名单、realpath 逃逸校验都在它里面，别重写。
  const { abs } = await resolveInsideRoot(target, { mode: "read", allowRoot: true });

  // Windows 上目标要经过 cmd.exe，含 % 的路径一定被展开：直接拒掉且不 spawn。
  if (process.platform === "win32" && isUnsafeForCmd(abs)) {
    throw fail("EDITOR_UNSUPPORTED_PATH", "this path cannot be opened on Windows");
  }

  const binary = await resolveEditorBinary();
  // message 必须点名 PATH 与 code：用户要读到的是「PATH 里没有 code 命令」而不是
  // 「找不到 VS Code」——后者会把人引向「我明明装了」的死胡同。
  if (!binary) throw fail("EDITOR_UNAVAILABLE", "the code command is not on PATH");

  await spawnDetached(binary, abs);
  return { ok: true, path: abs, binary };
}

// ── 远程仓库首页（0.9.0） ────────────────────────────────────────────────────────

/*
 * 为什么只归一到「仓库首页」这一个粒度：
 *   origin 写成 `git@github.com:owner/repo.git` 还是 `ssh://git@host:2222/o/r.git`，
 *   说的是同一个网页仓库的两种写法。既然只落到首页，就不必判断 host 属于哪家托管
 *   服务（github / gitlab / bitbucket 各有各的文件路径规则）——自建 GitLab、Gitea、
 *   内网 git 于是全都自然可用。不猜平台，就不替用户假设他的环境。
 *
 * 为什么必须是一个纯函数：
 *   输入是仓库里那一行字符串，输出马上要交给宿主去开（`shell.openExternal`）。
 *   这段逻辑必须能在离线夹具里被逐条钉住，所以它不联网、不读文件、不起进程，
 *   也不碰任何模块状态。
 *
 * 凭据：`git remote get-url` 可能带回内嵌凭据（`https://token@github.com/o/r`），
 *   那条地址进了浏览器就会留在地址栏与历史里，所以 userinfo 整段丢掉。
 *
 * 规则顺序以 design.md 3.3 那张表为准：控制字符 → scp → ssh/git → http(s) →
 *   本地路径（顺序上提前，理由见 isLocalRemote 的盘符说明）→ 剪尾部 →
 *   丢 userinfo → 校验。
 */

/** 不可打开的唯一结论：reason 只有一种，视图按它查文案。 */
function remoteNotOpenable() {
  return { ok: false, reason: "notOpenable" };
}

/**
 * 串里有没有控制字符（`U+0000`–`U+001F`、`U+007F`）？
 * 判的是剪掉首尾空白之后**中间**的部分：内嵌的 `\n` 与 NUL 会被抓出来，
 * 而结尾的一个换行只是空白、不算控制字符。
 */
function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    // 逐码元看：控制字符全在 BMP 低段，charCodeAt 够用，不必按码点迭代。
    const code = text.charCodeAt(index);
    // C0 段：内嵌的 `\n` / `\r` / `\t` 都落在这一段里。
    if (code <= 0x1f) return true;
    // DEL：唯一一个不在 C0 段里、却同属控制字符的码点。
    if (code === 0x7f) return true;
  }
  // 整串扫完都没有：这串里没有控制字符。
  return false;
}

/**
 * 这串是不是本地路径（`file://` 或裸路径）？是的话就不该被当成 URL 去拼。
 *
 * 必须抢在 scp 分支**之前**判：`C:\Users\me\repo` 冒号后第一段不是纯数字，
 * 照 scp 规则会被读成「host 是 C」，拼出一条根本不存在的地址——这是盘符陷阱。
 */
function isLocalRemote(text) {
  // file:// 是本地路径的 URL 形态，单独认出来，别让它落到协议分支里。
  if (text.toLowerCase().startsWith("file:")) return true;
  // 以 `/` 开头：POSIX 绝对路径（`//host/share` 这种 UNC 展开式也一并算在内）。
  if (text.startsWith("/")) return true;
  // 以 `\\` 开头：Windows UNC 路径，形如 `\\server\share\repo`。
  if (text.startsWith("\\\\")) return true;
  // 盘符形态：单个字母 + 冒号 + 分隔符（`C:\repo`、`C:/repo`），详见上面的陷阱说明。
  if (/^[A-Za-z]:[\\/]/.test(text)) return true;
  // 其余都不是本地路径。
  return false;
}

/**
 * `scheme://` 之后还紧跟一个斜杠（`https:///owner/repo`、`ssh:///o/r`、`https://\\owner\repo`）？
 *
 * 这类写法绝不能交给 URL 解析器：WHATWG 会把 `://` 之后的**所有**斜杠都吃掉，于是把路径
 * 第一段当成主机名——`https:///owner/repo` 解出来是 `https://owner/repo`，host 变成
 * `owner`，一条凭空捏造出来的域名（很可能是别人家的域名），接着就会交给宿主的
 * `shell.openExternal` 去打开。所以先在形态上拒掉，连解析都不进。反斜杠也算：解析器同样吃它。
 */
function hasSlashRightAfterScheme(text) {
  // 认「协议 + `://`」，紧跟的字符是 `/` 或 `\` 就判为多斜杠形态。
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[\\/]/.test(text);
}

/**
 * 抓 scp 形态 `[user@]host:path`：命中返回 `{ host, path }`，不是这个形态返回 null。
 *
 * 只看**第一个**冒号。冒号后第一段是纯数字时不算 scp——那更像 `host:port/path`，
 * 而 scp 的 `host:path` 里没有端口这回事；误当 scp 会拼出一条带两个冒号的怪地址。
 */
function parseScpRemote(text) {
  // 带 `://` 的一律归协议分支，这里只认「没有协议」的形态。
  if (text.includes("://")) return null;
  // 连冒号都没有就无从分割：`owner/repo` 这种无 host 的串走这里。
  const colon = text.indexOf(":");
  if (colon < 0) return null;
  // 冒号左边是 `[user@]host`、右边是 path；任何一边为空都不成形。
  const left = text.slice(0, colon);
  const right = text.slice(colon + 1);
  if (!left || !right) return null;
  // 冒号左边出现 `/` 说明这是一条普通路径而不是 `host:path`，别硬按 scp 处理。
  if (left.includes("/")) return null;
  // userinfo 在这里就丢掉：`git@` 只是登录名，不是仓库位置的一部分（规则 7）。
  const at = left.lastIndexOf("@");
  const host = at >= 0 ? left.slice(at + 1) : left;
  // `git@:o/r`：`@` 左右都空，host 是空串，拼不出地址。
  // （`@github.com:o/r` 不在这条上被拒：左边那段是 `@github.com`，host 取到 `github.com`，
  //   按 scp 读成 `https://github.com/o/r`——只有 `@` 没有用户名，不等于「没有 host」。）
  if (!host) return null;
  // 冒号后第一段纯数字 = `host:port/path` 的写法，不当 scp（见上面的说明）。
  if (/^[0-9]+$/.test(right.split("/")[0])) return null;
  // scp 的 `/abs/path` 写法指服务器上的绝对路径，开头的 `/` 要剥掉，
  // 否则拼出来是 `https://host//abs/path`，多一个斜杠。
  return { host, path: right.replace(/^\/+/, "") };
}

/**
 * 剪掉仓库路径结尾的 `/` 与 `.git`。两者可能同时出现、还可能叠加
 * （`…/repo.git/`），所以循环剪到不再变化为止。
 */
function trimRepoPathSuffix(pathname) {
  let result = pathname;
  for (;;) {
    const before = result;
    // 结尾的 `/`：`https://host/o/r.git/` 这类写法不该留在地址里（规则 6）。
    while (result.endsWith("/")) result = result.slice(0, -1);
    // 结尾的 `.git`：git 的约定后缀，首页地址不需要它（规则 6）。
    if (result.endsWith(".git")) result = result.slice(0, -4);
    // 这一轮没改掉任何字符就说明收敛了，退出，否则会一直转下去。
    if (result === before) return result;
  }
}

/**
 * origin 地址 → 仓库首页。返回 `{ ok: true, url }` 或 `{ ok: false, reason: "notOpenable" }`。
 * 不联网、不读文件、不碰全局状态、不起进程，也不判 host 属于哪家托管服务：只做形态
 * 归一，所以自建服务与内网地址一视同仁。
 */
function normalizeRemoteUrl(raw) {
  // 首尾空白先剪掉：git 配置里可能留着空格或换行，剪掉之后才是真实地址。
  const text = String(raw).trim();
  // 剪完是空的就没有任何形态可判，直接判不可打开。
  if (!text) return remoteNotOpenable();
  // 控制字符（内嵌 `\n`、NUL、DEL）会让地址在下游被截断或改写，先拒（规则 1）。
  if (hasControlCharacter(text)) return remoteNotOpenable();
  // 本地路径与 file:// 不是网页，也不该被当成 host 去猜（规则 5）。
  if (isLocalRemote(text)) return remoteNotOpenable();
  // 顺序上紧跟本地路径：多斜杠形态一旦进了解析器就会被它把路径第一段当 host，凭空造出一个
  // 域名（见 hasSlashRightAfterScheme），所以必须在拼 URL 之前就拦掉。
  if (hasSlashRightAfterScheme(text)) return remoteNotOpenable();

  // scp 形态没有协议，先摘成 `{ host, path }`，再拼成 `https://…` 走同一套 URL 解析，
  // 免得为它另写一份「拼 host、拼 path」的字符串处理。
  const scp = parseScpRemote(text);
  // 既没有 `://` 又不像 scp：这种串没有可用的 host，直接拒（`owner/repo` 走这里）。
  if (!scp && !text.includes("://")) return remoteNotOpenable();
  const candidate = scp ? `https://${scp.host}/${scp.path}` : text;

  let parsed;
  try {
    // 交给 URL 解析：合法性、host 小写、punycode、路径的百分号编码都由它办。
    parsed = new URL(candidate);
  } catch {
    // 畸形串（没有 host、只有协议、host 里有非法字符）解析不了 = 不可打开。
    return remoteNotOpenable();
  }

  // 协议已经被 URL 归一成小写，所以 `HTTPS://…` 与 `https://…` 在这里是同一条路。
  const scheme = parsed.protocol;
  const isWeb = scheme === "http:" || scheme === "https:";
  const isSsh = scheme === "ssh:" || scheme === "git:";
  // 这四个之外一律拒（规则 8）。带 `://` 的 ftp 能解析出 host，所以它确实会走到这一句——协议白名单
  // 是单独一道守卫，不靠「解析不成功」顺手拦下；不带 `://` 的 `javascript:` / `data:` 落不到这里，
  // 它们被 scp 分支读成 `https://javascript/…` 这类单标签主机的地址（见 parseScpRemote 的说明）。
  if (!isWeb && !isSsh) return remoteNotOpenable();
  // host 为空说明这条地址落不到任何主机上：走到这一句的是「只有协议、没有主机」的串
  // （`https://`、`ssh://`）。`git:/o/r`、`@github.com:o/r` 到不了这里——它们没有 `://`、
  // 冒号左边那段又像主机名，早被 scp 分支读成 `https://git/o/r` / `https://github.com/o/r`，
  // 这与 git 自己对 `host:path` 的解释一致；单标签主机（`git`）那条地址大概率打不开但无害。
  if (!parsed.hostname) return remoteNotOpenable();

  // ssh / git 换协议并丢端口：SSH 的 2222 与网页端口无关，照搬只会打不开（规则 3、4）；
  // http(s) 则原样保留协议与端口（规则 4）。
  const finalScheme = isSsh ? "https" : scheme.slice(0, -1);
  const finalPort = isSsh ? "" : parsed.port;
  const pathname = trimRepoPathSuffix(parsed.pathname);

  // 只用 hostname / port / pathname 手工拼回：userinfo（token、user:pass）与查询串、
  // 锚点都不在这三样里，于是「凭据不进浏览器」是结构上保证的，不靠事后过滤（规则 7、8）。
  const portSuffix = finalPort ? `:${finalPort}` : "";
  const finalUrl = `${finalScheme}://${parsed.hostname}${portSuffix}${pathname}`;

  // 最后把**拼好的地址**再喂一次解析：ssh / git 是非 special scheme，它的 host 允许百分号编码，
  // 换成 `https://` 之后反而可能解析不了（`ssh://a%20b/o/r` → 主机名解码后含空格，是 forbidden
  // host code point）。不复验就会漏出一条不可解析的地址：既违反「只产出可解析的 http(s) 地址」，
  // 也会被宿主的地址白名单拒掉，最后只给用户一句说不清原因的失败。
  try {
    // 解析得动就说明这条地址真能用；返回值不用，只关心它抛不抛。
    void new URL(finalUrl);
  } catch {
    return remoteNotOpenable();
  }
  return { ok: true, url: finalUrl };
}

// ── 通道路由 ────────────────────────────────────────────────────────────────

const CHANNELS = {
  "fm.hello": handleHello,
  "fm.prefs.get": handleHello,
  "fm.prefs.set": handlePrefsSet,
  "fm.list": handleList,
  "fm.read": handleRead,
  "fm.write": handleWrite,
  "fm.create": handleCreate,
  "fm.rename": handleRename,
  "fm.move": handleMove,
  "fm.delete": handleDelete,
  "fm.search": handleSearch,
  "fm.sqlite.open": handleSqliteOpen,
  "fm.sqlite.rows": handleSqliteRows,
  "fm.sqlite.query": handleSqliteQuery,
  "fm.git.diff": handleGitDiff,
  "fm.watch": handleWatch,
  "fm.editor.open": handleEditorOpen,
};

async function onPanelInvoke(channel, payload) {
  const handler = CHANNELS[channel];
  if (!handler) return { ok: false, code: "UNSUPPORTED", message: `unknown channel: ${channel}` };
  try {
    return await handler(payload ?? {});
  } catch (error) {
    return toFailure(error);
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

async function onLoad() {
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    dataPath = null;
  }
  try {
    const settings = await pi.plugin.getSettings();
    prefs = sanitizePrefs(settings?.fmPrefs ?? {});
  } catch {
    /* 保持默认 */
  }
}

async function onUnload() {
  searchSessions.clear();
  for (const key of [...sqliteHandles.keys()]) closeSqliteHandle(key);
  invalidateGitSnapshots();
  // 监听必须随插件一起走：漏关就是一只挂在别人项目上的眼睛（而且是 persistent 的）。
  stopWatching();
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // 纯解析函数：verify-git.mjs 直接拿它们单测（porcelain / numstat / unified
  // diff 的形态很容易在 git 升级时悄悄变一次，解析必须能被断言）。
  internals: {
    parsePorcelainV1,
    classifyRecord,
    parseNumstat,
    parseUnifiedDiff,
    untrackedDiff,
    rollupByChildDirectory,
    GIT_STATUS_RANK,
    GIT_TIMEOUT_MS,
    GIT_SNAPSHOT_TTL_MS,
    MAX_DIFF_LINES,
    MAX_UNTRACKED_DIFF_BYTES,
    // 监听（0.8.0）的纯判定：噪声过滤与自己写入的抑制，verify-watch.mjs 直接断言。
    isWatchIgnored,
    isSelfWrite,
    noteSelfWrite,
    WATCH_DEBOUNCE_MS,
    SELF_WRITE_SUPPRESS_MS,
    WATCH_HISTORY_LIMIT,
    // 用 VS Code 打开（0.9.0）：探测与 Windows 侧的两个纯函数，verify-remote.mjs
    // 直接断言（含 % 的路径必须被拦下；纯函数在任何平台上都能跑）。
    resolveEditorBinary,
    isUnsafeForCmd,
    windowsCommandLine,
    comSpecPath,
    EDITOR_TIMEOUT_MS,
    // origin 地址规范化（0.9.0）：纯形态归一，不联网、也不判 host 属于哪家托管服务；
    // verify-remote.mjs 第 5 节用离线夹具直接断言它的输出与拒绝理由。
    normalizeRemoteUrl,
  },
};
