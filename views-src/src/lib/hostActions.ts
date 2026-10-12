/**
 * 打开动作的调用层：由宿主代为执行的两条，加上由插件进程自己启动的「用 VSCode 打开」。
 *
 * 前两个（用默认应用打开、在文件夹中显示）**必须**走宿主网关：只有宿主进程能调起系统
 * 程序，也只有它能拿到真实路径。因此 manifest 里声明了 `fs.read`（root workspace、
 * scope `**`）——与内置 Files 视图逐项相同——这两个通道会按声明的范围校验，越界会被
 * 宿主自己拒掉。契约（见宿主 plugin-runtime.ts）：参数是**工作区相对路径**，且
 * **只接受文件**，目录会返回 INVALID_ARGUMENT，所以调用方要对目录禁用这两个动作。
 *
 * 第三条（openInEditor）**不受 `manifest.fs` 约束**：宿主 API 里没有「用指定程序打开」
 * 的通道，VS Code 由插件进程自己 spawn（与 git 联动同一套进程能力），因此它既不走宿主
 * 网关，也不是只对文件有效——文件、目录与基点文件夹自身都能打开。它收的是**基点相对
 * 路径**（省略或空串 = 基点文件夹自身），由主进程的 resolveInsideRoot 解析成绝对路径；
 * 送绝对路径会被主进程按 ABSOLUTE_PATH 拒掉。
 *
 * 三条都遵循同一套错误折算：`{ ok: false }` 与抛错统一成抛错，调用方只写一个 catch。
 * 注意「在浏览器打开仓库」不在这里——那条通道同样不受 `manifest.fs` 约束，但目标是
 * 仓库而不是文件，且地址由主进程解析，单放在 lib/remoteOpen.ts。
 */

import { invoke } from "./bridge";
import { channels, type EditorOpenRequest, type EditorOpenResponse } from "./rpc";

type HostResponse = { ok?: boolean; message?: string } | undefined;

/**
 * 宿主通道失败时有两种表现：抛错（preload 拒绝）或返回 `{ ok: false }`。
 * 这里统一成抛错，调用方只写一个 catch。
 */
async function runHostAction(channel: string, path: string): Promise<void> {
  const response = await invoke<HostResponse>(channel, { path });
  if (response && response.ok === false) {
    throw new Error(response.message ?? "the host refused the request");
  }
}

/** 用系统默认关联程序打开一个文件（宿主执行：受 fs.read 范围约束，目录会被宿主拒掉）。 */
export function openWithDefaultApp(path: string): Promise<void> {
  return runHostAction("fs.openDefault", path);
}

/** 在系统文件管理器里定位一个文件（宿主执行，同上）。 */
export function revealInFileManager(path: string): Promise<void> {
  return runHostAction("fs.reveal", path);
}

/**
 * 用 VS Code 打开一个文件、目录或基点文件夹自身（0.9.0）。
 *
 * 失败时把主进程的原因码挂到错误对象上（照 lib/bridge.ts 的 NO_BRIDGE 写法）：
 * 「这条路径在 Windows 上不能交给 cmd.exe」是用户自己能处理的一种失败（换个路径），
 * 与「命令行不在 PATH 上」该说的话不一样，调用方要按码挑文案。
 * 成功时回传主进程实际使用的绝对路径与命令行路径，供校验脚本比对。
 */
export async function openInEditor(path?: string): Promise<{ path: string; binary: string }> {
  // path 省略或空串 = 基点文件夹自身：此时连字段都不带，交给主进程按缺省处理。
  const request: EditorOpenRequest = {};
  if (path) request.path = path;

  const response = await invoke<EditorOpenResponse>(channels.editorOpen, request);
  if (!response.ok) {
    throw Object.assign(new Error(response.message ?? "the editor could not be opened"), {
      code: response.code,
    });
  }
  return { path: response.path, binary: response.binary };
}
