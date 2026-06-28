import React, { useEffect, useRef } from "react";
import type { SlashCommand } from "../commands";

export function SlashMenu(props: {
  commands: SlashCommand[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const { commands, activeIndex, onSelect, onHover } = props;
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  if (commands.length === 0) {
    return (
      <div className="slash-menu" role="listbox" aria-label="Commands">
        <div className="slash-empty">No matching commands</div>
      </div>
    );
  }

  // Render with lightweight group separators while keeping a single flat index
  // space so keyboard navigation maps directly to the filtered array.
  let lastGroup = "";
  return (
    <div className="slash-menu" role="listbox" aria-label="Commands" ref={listRef}>
      {commands.map((c, i) => {
        const showGroup = c.group !== lastGroup;
        lastGroup = c.group;
        return (
          <React.Fragment key={c.id}>
            {showGroup && <div className="slash-group">{c.group}</div>}
            <button
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              data-idx={i}
              className={`slash-item ${i === activeIndex ? "active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); onSelect(i); }}
              onMouseEnter={() => onHover(i)}
            >
              <span className="slash-cmd">/{c.command}</span>
              <span className="slash-title">{c.title}</span>
              {c.hint && <span className="slash-hint">{c.hint}</span>}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
