/**
 * 「在浏览器打开仓库」的调用层，以及两个新菜单项的可用性判定（0.9.0）。
 *
 * 为什么不塞进 lib/hostActions.ts：那个文件的契约是「由宿主代为执行、受 `manifest.fs`
 * 约束、只对文件有效」（fs.openDefault / fs.reveal 两条都如此）。本通道
 * `fm.remote.open` 由插件主进程自己取 origin、自己规范化地址，**不受 `manifest.fs`
 * 约束**，目标也不是某个文件而是整个仓库——混在一起会把那份契约讲歪。
 *
 * 文件后半段是两个纯函数：菜单项「什么时候禁用、悬停提示说什么」这段判断收在这里，
 * App.tsx 只负责调用。App.tsx 是上千行的渲染组件，判定留在组件里就只能靠手点着看，
 * 挪出来才能被 verify-remote.mjs 离线断言（与 lib/git.ts / lib/watch.ts 同一做法）。
 */

import { invoke } from "./bridge";
import { channels, type RemoteCapability, type RemoteOpenResponse, type RemoteReason } from "./rpc";
import type { CopyKey, T } from "../i18n";

/** 菜单项的可用状态：disabled 决定能不能点，hint 是悬停提示（空串 = 不给提示）。 */
export type RemoteMenuState = { disabled: boolean; hint: string };

/**
 * 在浏览器里打开当前基点文件夹的仓库首页。
 *
 * 与 hostActions.ts 同一套错误折算：通道返回 `{ ok: false }` 与直接抛错都变成抛错，
 * 调用方只写一个 catch。成功时回传实际打开的地址（校验脚本要比对它）。
 * 失败不再细分原因：取不到地址与宿主拒掉地址，对用户都是同一句「打不开」。
 */
export async function openRepoInBrowser(): Promise<{ url: string }> {
  const response = await invoke<RemoteOpenResponse>(channels.remoteOpen);
  // 与 hostActions.ts 的 openInEditor 同一写法：把主进程的原因码挂到错误对象上带出去，
  // 调用方才能按码分流（「取不到 origin」与「宿主拒了这个地址」该说的话不一样）。
  if (!response.ok) {
    throw Object.assign(new Error(response.message ?? "the repository could not be opened"), {
      code: response.code,
    });
  }
  return { url: response.url };
}

/** 不可用原因 → 文案键；四种成因各一句不同的话，用户该做的下一步也各不相同。 */
function remoteReasonKey(reason: RemoteReason | undefined): CopyKey {
  switch (reason) {
    // 这台机器上没有 git：判定根本做不出来，用户要装 git 再重新加载插件。
    case "noGit":
      return "remoteNoGit";
    // 是仓库但没有配置 origin：地址无从取得，用户要给仓库加一个远程地址。
    case "noRemote":
      return "remoteNoRemote";
    // 取到 origin 了，但规范化不成 http(s)：这种地址不是网页，打开也没有意义。
    case "notOpenable":
      return "remoteNotOpenable";
    // noRepo 与「判定还没到手、reason 缺席」都落在这里：此时菜单项一律禁用，
    // 用户看到的只是一句解释，不必为「还没算出来」再造一个键。
    default:
      return "remoteNoRepo";
  }
}

/**
 * 「在浏览器打开仓库」这一项的可用状态。
 *
 * 判定来自 fm.list 的 `remote` 字段（它随基点变化，所以挂在列表响应上，而不是握手）。
 */
export function remoteMenuState(remote: RemoteCapability | null | undefined, t: T): RemoteMenuState {
  // 判定没到手（列表还没回来，或极老的宿主没有这个字段）：按不可用处理。
  // 菜单上不该先摆一个点下去才知道失败的可点项。
  if (!remote) return { disabled: true, hint: t(remoteReasonKey(undefined)) };
  // 不可用：四种成因各说一句，告诉用户是「不是仓库」「没有 origin」「地址不是网页」
  // 还是「机器上没有 git」——这四种要用户去做的事完全不同。
  if (!remote.available) return { disabled: true, hint: t(remoteReasonKey(remote.reason)) };
  // 可用：提示里带上 host。菜单只说「在浏览器打开仓库」，看不出将要打开的是哪个站。
  return { disabled: false, hint: t("openRemoteHint", { host: remote.host }) };
}

/**
 * 「用 VSCode 打开」这一项的可用状态。
 *
 * 可用性来自 fm.hello 的 `editor.binary` 探测结果：PATH 上没有 code 命令就禁用，
 * 并把「去补 PATH、然后重新加载插件」这句话放进悬停提示——只说「找不到 VS Code」
 * 会把用户引向「我明明装了」的死胡同。
 */
export function editorMenuState(available: boolean, t: T): RemoteMenuState {
  // 探测不到命令行：禁用并说明原因（此时强行调用只会换回一条失败 toast）。
  if (!available) return { disabled: true, hint: t("editorUnavailable") };
  // 可用：不给提示。标签已经说明白了，处处弹提示反而碍事。
  return { disabled: false, hint: "" };
}

/**
 * 「用 VSCode 打开」要送出去的路径：有目标就送基点相对路径，空白处不带 path。
 *
 * 纯透传，**不做任何绝对化**：树里那个 entry.path 本来就是基点相对路径，主进程会按
 * resolveInsideRoot 把它解析成绝对路径，送绝对路径过去只会换回 ABSOLUTE_PATH。
 * 注意别顺手用 hostActionPath 代替它——那是给宿主执行的 fs.openDefault / fs.reveal 用的，
 * 那两条必须绝对路径，两条通道的路径口径正好相反。
 */
export function editorTargetPath(entryPath: string | null): string | undefined {
  // 空白处右键（null / 空串）不带 path 字段：交给主进程按基点文件夹自身解析。
  if (!entryPath) return undefined;
  // 有目标：原样返回，逐字节送给通道（不拼基点、不改分隔符）。
  return entryPath;
}
