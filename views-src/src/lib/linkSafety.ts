/**
 * 链接协议白名单。
 *
 * 预览里点链接不能真的导航：视图一旦离开插件页面就回不来。所以点击的语义是
 * 「把地址告诉用户」（走无权限要求的 ui.showToast），而不是替用户把链接打开——
 * 插件虽然申报了 shell.openExternal（0.9.0 起，供右键菜单的「在浏览器打开仓库」
 * 用），但那条权限是给用户显式选中的仓库地址用的，不代表正文里的任意链接都该
 * 被自动打开。
 * 危险协议（javascript: / data: / vbscript: 等）直接标为不支持。
 */

const SAFE = /^(?:https?:|mailto:)/i;
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript|file|blob):/i;

export function isSafeLink(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (UNSAFE_SCHEME.test(trimmed)) return false;
  // 相对路径在 file:// 下没有意义，也不允许当作可点击链接。
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
  return SAFE.test(trimmed);
}
