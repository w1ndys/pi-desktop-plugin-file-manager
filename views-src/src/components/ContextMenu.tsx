import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuEntry =
  | { kind: "separator" }
  | {
      kind: "item";
      label: string;
      hint?: string;
      icon?: React.ReactNode;
      disabled?: boolean;
      danger?: boolean;
      onPick: () => void;
    };

type Props = {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
};

/**
 * 右键菜单。
 *
 * 定位用 fixed + 视口夹取：菜单在面板右/下边缘弹出时不会跑到可视区外面。
 * 打开后把焦点放到第一个可用项，支持 ↑↓ / Home / End / Enter / Escape。
 */
export function ContextMenu({ x, y, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // entries / onClose 每次渲染都是新引用，直接放进 effect 依赖会让监听器与
  // 首次聚焦反复重建——按方向键时焦点会被不断拽回第一项。
  // 所以用 ref 取最新值，副作用只在挂载时建立一次。
  const latest = useRef({ entries, onClose });
  latest.current = { entries, onClose };

  // 先量一次真实尺寸再夹取，避免闪一下再跳位。
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    });
  }, [x, y]);

  useEffect(() => {
    const items = () =>
      [...(ref.current?.querySelectorAll<HTMLButtonElement>("button[data-item]:not([disabled])") ?? [])];

    items()[0]?.focus();

    const dismiss = () => latest.current.onClose();

    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) dismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const index = list.indexOf(document.activeElement as HTMLButtonElement);

      if (event.key === "ArrowDown") {
        event.preventDefault();
        list[(index + 1 + list.length) % list.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        list[(index - 1 + list.length) % list.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        list[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        list[list.length - 1]?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  return (
    <div
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      className="fixed z-50 min-w-[178px] rounded-lg border py-1 shadow-2xl"
      style={{
        left: position.left,
        top: position.top,
        borderColor: "var(--border-strong)",
        background: "var(--surface-raised)",
        color: "var(--fg)",
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) => {
        if (entry.kind === "separator") {
          return (
            <div
              key={`sep-${index}`}
              role="separator"
              className="my-1 h-px"
              style={{ background: "var(--border)" }}
            />
          );
        }
        return (
          <button
            key={`${entry.label}-${index}`}
            data-item
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            title={entry.hint}
            onClick={() => {
              onClose();
              entry.onPick();
            }}
            className="flex w-full items-center gap-2 border-0 bg-transparent px-3 py-[5px] text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)] focus-visible:outline-none disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            style={{ minHeight: 26, color: entry.danger ? "var(--danger)" : "var(--secondary)" }}
          >
            <span className="inline-flex w-[15px] flex-none items-center justify-center" aria-hidden="true">
              {entry.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {/* 提示是整句中文（如 PATH 里没有 code 命令那句）时，不加约束会把这个
                178px 宽的菜单一路撑开：菜单比面板还宽时视口夹取会退化成靠左 8px、右侧
                被切掉。所以给一个上限并省略号收尾；完整文案仍在这个按钮的 title 上，
                悬停就能看全，信息不丢。 */}
            {entry.hint ? (
              <span className="max-w-[200px] flex-none truncate text-[10.5px]" style={{ color: "var(--faint)" }}>
                {entry.hint}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
