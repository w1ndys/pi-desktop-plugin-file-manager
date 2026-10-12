/**
 * 视图 ↔ 插件主进程的通道契约。这里是唯一真相来源：
 * 任何一侧改字段，都从改这个文件开始。
 *
 * 全部经 window.pluginBridge.invoke("fm.*", payload) 转发到 main.js 的
 * onPanelInvoke。宿主对自定义通道的超时是 30s，所以遍历类操作一律分页。
 */

import type { ProjectWorkspace } from "./roots";
import type { T } from "../i18n";

/**
 * 一行要显示的 git 状态（0.7.0）。文件上是它自己的状态，目录上是整个子树的
 * 汇总（changed = 子树里受影响的文件数）。没有变化 / 这里没有 git 时整列为 null。
 *
 * status 的取值刻意与 git 的两列状态分开：porcelain 的 XY 组合有十几种，界面
 * 只需要「这行发生了什么」这一种说法，其余细节（暂存没暂存、是不是全新文件）
 * 放在 staged / untracked 两个布尔里。
 */
export type GitStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "conflicted"
  | "typechange";

export type GitEntryStatus = {
  status: GitStatusKind;
  /** 暂存区里也有这份改动（git 的 X 列）。 */
  staged: boolean;
  /** 全新文件、git 还不认识（porcelain 的 ??）。 */
  untracked: boolean;
  /** 相对 HEAD 的增删行数；未跟踪文件没有（git 不知道它以前长什么样）。 */
  added: number;
  deleted: number;
  /** 只有目录才有：这个子树里受影响的文件数。 */
  changed?: number;
};

export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mtimeMs: number;
  ignored: boolean;
  isSymlink: boolean;
  /** 符号链接指向根目录之外：不展开、不可读。 */
  outside: boolean;
  /** git 状态徽标；没有变化就是 null（不是 absent，形状是固定的）。 */
  git: GitEntryStatus | null;
};

/** 列表响应里那句「多少处改动」；没有 git / 不是仓库时 available 为 false。 */
export type GitSummary = {
  available: boolean;
  branch?: string | null;
  counts?: { modified: number; added: number; deleted: number; renamed: number; conflicted: number };
  total?: number;
  /** 变化太多，状态输出被截断了：徽标可能不全。 */
  truncated?: boolean;
};

export type DiffLine = {
  type: "add" | "del" | "ctx" | "note";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type DiffHunk = {
  header: string;
  /** @@ 头后面那段上下文（git 放的是所在函数名）。 */
  section: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type DiffSection = {
  /** worktree = 暂存区 → 工作区；staged = HEAD → 暂存区。 */
  scope: "worktree" | "staged";
  /** diff --git / new file mode 这类文件头信息。 */
  meta: string[];
  hunks: DiffHunk[];
  binary: boolean;
  truncated?: boolean;
};

export type GitDiffResponse =
  | {
      ok: true;
      path: string;
      /** none = 这个文件没有改动；binary / tooLarge 另有说明。 */
      kind: "text" | "none" | "binary" | "tooLarge";
      untracked: boolean;
      addedLines: number;
      deletedLines: number;
      sections: DiffSection[];
      truncated: boolean;
      status?: GitEntryStatus | null;
      limit?: number;
      size?: number;
    }
  | Failure;

export type Failure = { ok: false; code: string; message: string };

export type Prefs = {
  splitRatio: number;
  /**
   * 左侧文件列表是否收起。宿主请求打开文件时会强制收起，并随设置持久化；
   * splitRatio 照旧保留，重新展开时按原宽度恢复。
   */
  treeCollapsed: boolean;
  showIgnored: boolean;
  /**
   * 监听外部改动并自动刷新（0.8.0）。关掉之后回到「只有手动刷新」——两个按钮都
   * 一直在，监听只是省掉那一下点击。
   */
  watchFiles: boolean;
  /** Markdown 默认打开为预览还是编辑；只对 .md/.markdown/.mdx 生效。 */
  mdPreview: boolean;
  /** CSV/TSV 默认打开为表格还是源码。 */
  csvTable: boolean;
  /** JSON 默认打开为折叠树还是源码。 */
  jsonTree: boolean;
  /** 表格每页行数（100–5000，100 的整数倍；默认 1000）。 */
  tablePageSize: number;
  /**
   * 项目组里「当前在看哪个 folder root」的记忆：projectKey → 绝对路径。
   * projectKey = `p:<projectId>`（宿主给了 projectId 时）或 `r:<主根路径>`；
   * 值必须命中宿主当前给的 roots 才被信任，否则退回主根；最多 20 条，按最近
   * 写入做 LRU 淘汰（都在 main.js 的 sanitizePrefs / selectedRootOf 里）。
   */
  projectRoots: Record<string, string>;
};

export type Limits = {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxListEntries: number;
};

/** fm.hello 带回的 VS Code 命令行探测结果：视图据此决定菜单项是否可用。 */
export type EditorCapability = {
  /** 探测到的可执行文件路径；null = PATH 上没有 code 命令。 */
  binary: string | null;
};

/**
 * 首次握手：项目组（与 workspace.get 同一个形状——path/name 是组的**主根**）、
 * 当前偏好、上限与忽略规则文件名。「当前在看哪个 folder root」不在这个字段里：
 * 它是 prefs.projectRoots 里的记忆，视图与主进程都用同一套规则从它推导基点。
 */
export type HelloResponse = {
  ok: true;
  root: ProjectWorkspace | null;
  limits: Limits;
  ignoreFiles: string[];
  /** 监听能力：不能监听时视图不给一个永远没反应的开关。 */
  watch: WatchCapability;
  prefs: Prefs;
  /** VS Code 命令行探测结果（0.9.0）；没找到时降级成 binary: null，不挡住握手。 */
  editor: EditorCapability;
};

/** 「在浏览器打开仓库」不可用的原因键；视图据此挑一句提示文案。 */
export type RemoteReason =
  | "noRepo" // 这个文件夹不是 git 仓库
  | "noRemote" // 是仓库，但没有配置 origin
  | "notOpenable" // 取到 origin 了，但规范不成 http(s) 地址
  | "noGit"; // 这台机器上没有 git

/** 基点文件夹的仓库首页能力：不可用时给出原因键，可用时给出将打开的地址。 */
export type RemoteCapability =
  | {
      available: false;
      /** 不可用的成因；四种取值对应四句不同的用户提示。 */
      reason: RemoteReason;
    }
  | {
      available: true;
      /** 规范化后的仓库首页地址（http 或 https）。 */
      url: string;
      /** 地址里的主机名，菜单提示用它（例如 github.com）。 */
      host: string;
    };

export type ListResponse = {
  ok: true;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
  /** 项目里存在生效的忽略规则；false 表示「无规则，全部展示」。 */
  ignoreActive: boolean;
  /** 整个工作区的改动概览（供头部那一句用）；没有 git 时 available 为 false。 */
  git: GitSummary;
  /** 这个基点文件夹能不能打开仓库首页（0.9.0）；判定随基点变化，所以挂在 list 上。 */
  remote: RemoteCapability;
};

export type TextRead = {
  ok: true;
  kind: "text";
  path: string;
  text: string;
  eol: "lf" | "crlf";
  bom: boolean;
  size: number;
  mtimeMs: number;
  /** 这个文件相对 HEAD 的 git 状态（0.7.0）；没有变化或这里没有 git 时是 null。 */
  git: GitEntryStatus | null;
};

/**
 * 图片与音视频把字节以 data URI 带过来——面板是 file:// 的沙箱页，
 * 没有文件系统，相对路径只会指回视图自己。
 */
export type DataRead = {
  ok: true;
  kind: "image" | "media";
  path: string;
  size: number;
  mtimeMs: number;
  /** image/png、video/mp4 这类；视图据此选 <img> 还是 <video>/<audio>。 */
  mime: string;
  dataUri: string;
};

/** 超过该类型的体积上限；limit 是具体的字节数，UI 直接显示给用户。 */
export type TooLargeRead = {
  ok: true;
  kind: "tooLarge";
  path: string;
  size: number;
  mtimeMs: number;
  limit: number;
};

/** zip / apk / exe 这类没有可预览形态的文件。 */
export type BinaryRead = {
  ok: true;
  kind: "binary";
  path: string;
  size: number;
  mtimeMs: number;
};

/** 数据库头部读出来的概览（不含内容——真正的取数走 fm.sqlite.*，一次一页）。 */
export type SqliteInfo = {
  size: number;
  pageSize: number;
  pageCount: number;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  journalMode: "wal" | "rollback";
  schemaVersion: number;
  libraryVersion: number;
  /** 旁边有 -wal 文件：可能有还没合并回去的改动，显示的内容未必是最新。 */
  hasWal: boolean;
  hasJournal: boolean;
};

export type SqliteObject = {
  /** table | view | index | trigger */
  type: string;
  name: string;
  tableName: string;
  sql: string | null;
};

export type SqliteColumn = {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
};

/** SQLite 文件：只带头部信息，字节留在主进程里。 */
export type SqliteRead = {
  ok: true;
  kind: "sqlite";
  path: string;
  size: number;
  mtimeMs: number;
  /** 宿主运行时有没有 node:sqlite；没有就只能看概览。 */
  available: boolean;
  info: SqliteInfo;
};

export type ReadResponse = TextRead | DataRead | TooLargeRead | BinaryRead | SqliteRead;

export type SqliteOpenResponse = {
  ok: true;
  path: string;
  info: SqliteInfo;
  objects: SqliteObject[];
};

export type SqliteRowsResponse = {
  ok: true;
  path: string;
  object: string;
  kind: "table" | "view";
  columns: SqliteColumn[];
  /** 单元格一律是字符串或 null（null 才是 SQL 的 NULL）。 */
  rows: (string | null)[][];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** max(rowid) 的估算，不是精确行数（精确 COUNT(*) 在大表上是全表扫描）。 */
  estimate: number | null;
  hasRowid: boolean;
};

export type SqliteQueryResponse = {
  ok: true;
  path: string;
  columns: SqliteColumn[];
  rows: (string | null)[][];
  truncated: boolean;
  elapsedMs: number;
};

export type SqliteRowsRequest = {
  path: string;
  object: string;
  page: number;
  pageSize: number;
  orderBy?: string;
  direction?: "asc" | "desc";
};

export type SqliteQueryRequest = { path: string; sql: string; limit: number };

export type WriteOk = { ok: true; mtimeMs: number; size: number };

export type ConflictFailure = {
  ok: false;
  code: "CONFLICT";
  message: string;
  mtimeMs: number;
  size: number;
};

export type WriteResponse = WriteOk | ConflictFailure | Failure;

export type EntryResponse = { ok: true; entry: FileEntry | null } | Failure;
export type DeleteResponse = { ok: true } | Failure;

export type SearchHit = { name: string; path: string; isDirectory: boolean };

export type SearchResponse = {
  ok: true;
  matches: SearchHit[];
  nextCursor: string | null;
  done: boolean;
  scanned: number;
};

export type PrefsResponse = { ok: true; prefs: Prefs } | Failure;

/**
 * 外部改动的增量（0.8.0）。视图拿着上次的 revision 来问，主进程只回「这之后变了
 * 哪些根相对路径」。
 *
 * 没有推送通道（宿主只给 ui.showToast 这类单向通知），所以是这个形状：主进程负责
 * 用 fs.watch 盯着，视图低频来取。
 */
export type WatchResponse = {
  ok: true;
  /** 这个运行时能不能监听；false 时视图把「自动刷新」开关显示成不可用。 */
  available: boolean;
  /** 游标：下次带着它来问。 */
  revision: number;
  /** 变了哪些路径（根相对）。空串 = 只知道根底下有东西变了（平台没给文件名）。 */
  changed: string[];
  /** 游标已经落到有界历史之外：可能还有没看到的，视图据此做一次保守刷新。 */
  stale: boolean;
};

/** 首次握手里的监听能力（视图据此决定开关是否可用）。 */
export type WatchCapability = { available: boolean };

export type ReadRequest = {
  path: string;
  /**
   * 宿主请求打开的项目之外绝对路径（会话临时目录 / 附件）：显式声明后主进程
   * 只查黑名单与 realpath，不再要求路径落在项目根内。
   */
  external?: boolean;
};

export type WriteRequest = {
  path: string;
  text: string;
  expectedMtimeMs: number;
  expectedSize: number;
  eol: "lf" | "crlf";
  bom: boolean;
  /** 同 ReadRequest.external：项目之外的绝对路径，主进程按外部路径解析。 */
  external?: boolean;
};

/** CONFLICT 是带当前磁盘状态的失败，需要 discriminated 检查而不是比 code。 */
export function isConflict(response: WriteResponse): response is ConflictFailure {
  return !response.ok && response.code === "CONFLICT" && "mtimeMs" in response;
}

/** 「用 VSCode 打开」请求：path 省略或空串 = 基点文件夹自身（项目根）。 */
export type EditorOpenRequest = { path?: string };

/** 「用 VSCode 打开」的响应；失败分支复用 Failure。 */
export type EditorOpenResponse =
  | {
      ok: true;
      /** 实际交给 code 的绝对路径：省略 path 时就是基点文件夹自身的绝对路径。 */
      path: string;
      /** 实际启动的命令行路径；Windows 上是解析到的 code.cmd。 */
      binary: string;
    }
  | Failure;

/** 「在浏览器打开仓库」的响应；失败分支复用 Failure。 */
export type RemoteOpenResponse =
  | {
      ok: true;
      /** 送进宿主 shell.openExternal 的仓库首页地址，协议一定是 http 或 https。 */
      url: string;
    }
  | Failure;

export const channels = {
  hello: "fm.hello",
  prefsGet: "fm.prefs.get",
  prefsSet: "fm.prefs.set",
  list: "fm.list",
  read: "fm.read",
  write: "fm.write",
  create: "fm.create",
  rename: "fm.rename",
  move: "fm.move",
  delete: "fm.delete",
  search: "fm.search",
  sqliteOpen: "fm.sqlite.open",
  sqliteRows: "fm.sqlite.rows",
  sqliteQuery: "fm.sqlite.query",
  gitDiff: "fm.git.diff",
  watch: "fm.watch",
  editorOpen: "fm.editor.open",
  remoteOpen: "fm.remote.open",
} as const;

/** 把失败响应统一成人话，供 UI 直接展示。 */
export function failureMessage(failure: Failure, t: T): string {
  switch (failure.code) {
    case "NO_WORKSPACE":
      return t("noWorkspace");
    case "DENIED_PATH":
      return t("errDenied");
    case "ESCAPE":
    case "ABSOLUTE_PATH":
    case "SYMLINK_ESCAPE":
      return t("errEscape");
    case "EXISTS":
      return t("errExists");
    case "INVALID_NAME":
      return t("errName");
    case "TOO_LARGE":
      return t("tooLarge");
    case "CONFLICT":
      return t("conflictTitle");
    case "NOT_FOUND":
      return t("errNotFound");
    case "UNSUPPORTED":
      return t("errUnsupported");
    case "NOT_SQLITE":
      return t("sqliteNotADatabase");
    case "SQLITE_UNAVAILABLE":
      return t("sqliteUnavailable");
    case "SQLITE_BROKEN":
      return t("sqliteBroken");
    case "SQLITE_SQL_EMPTY":
      return t("sqliteSqlEmpty");
    case "SQLITE_SQL_TOO_LONG":
      return t("sqliteSqlTooLong");
    case "SQLITE_SQL_MULTIPLE":
      return t("sqliteSqlMultiple");
    case "SQLITE_SQL_NOT_READ_ONLY":
      return t("sqliteSqlReadOnly");
    case "SQLITE_NO_SUCH_OBJECT":
      return t("sqliteNoSuchObject");
    case "SQLITE_OFFSET_LIMIT":
      return t("sqliteOffsetLimit");
    case "GIT_UNAVAILABLE":
      return t("gitUnavailable");
    default:
      // SQLITE_SQL_ERROR 走这里：引擎自己的报错（no such table: …）就是最有用的文案
      return failure.message || failure.code;
  }
}
