import { memo, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Align, type Block, type Inline, type ListItem } from "@/lib/chat-markdown";

/**
 * Renders an assistant reply as Markdown (tables, lists, bold, code, links).
 * The parser returns a tree and every node becomes a React element, so there
 * is no HTML string anywhere: markup in a reply is shown as text.
 */

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}.${i}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return <br key={key} />;
      case "strong":
        return <strong key={key} className="font-semibold text-text-primary">{renderInline(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "del":
        return <del key={key}>{renderInline(node.children, key)}</del>;
      case "code":
        return <code key={key} className="rounded bg-surface-card px-1 py-0.5 font-mono text-[0.85em] text-text-primary">{node.text}</code>;
      case "link": {
        const external = !node.href.startsWith("/");
        return (
          <a key={key} href={node.href} className="text-accent underline underline-offset-2 break-all"
            {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}>
            {renderInline(node.children, key)}
          </a>
        );
      }
    }
  });
}

const alignClass = (align: Align) => (align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left");

function renderItem(item: ListItem, key: string): ReactNode {
  // The item's first paragraph sits on the bullet's own line; nested lists and
  // further paragraphs follow underneath.
  const first = item.blocks[0]?.type === "paragraph" ? item.blocks[0] : null;
  const rest = first ? item.blocks.slice(1) : item.blocks;
  const body = (
    <>
      {first && renderInline(first.children, key)}
      {rest.length > 0 && <div className="mt-1 space-y-2">{renderBlocks(rest, `${key}n`)}</div>}
    </>
  );
  if (item.checked === null) return <li key={key}>{body}</li>;
  return (
    <li key={key} className="list-none -ml-5 flex gap-2">
      <input type="checkbox" checked={item.checked} readOnly disabled aria-label={item.checked ? "Done" : "Not done"} className="mt-1 shrink-0 accent-[var(--color-accent)]" />
      <div className="min-w-0">{body}</div>
    </li>
  );
}

const HEADING_CLASS = ["", "text-lg", "text-base", "text-sm", "text-sm", "text-sm", "text-sm"];

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (block.type) {
      case "paragraph":
        return <p key={key}>{renderInline(block.children, key)}</p>;
      case "heading":
        // Rendered as styled paragraphs with a heading role: the page already has its own h1/h2.
        return (
          <p key={key} role="heading" aria-level={Math.min(block.level + 2, 6)} className={`${HEADING_CLASS[block.level]} font-semibold text-text-primary`}>
            {renderInline(block.children, key)}
          </p>
        );
      case "code":
        return (
          <pre key={key} className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-card p-3 font-mono text-xs leading-relaxed text-text-primary whitespace-pre">
            <code data-lang={block.lang ?? undefined}>{block.text}</code>
          </pre>
        );
      case "blockquote":
        return <blockquote key={key} className="space-y-2 border-l-2 border-border-subtle pl-3 text-text-tertiary">{renderBlocks(block.blocks, key)}</blockquote>;
      case "hr":
        return <hr key={key} className="border-border-subtle" />;
      case "list": {
        const items = block.items.map((item, n) => renderItem(item, `${key}:${n}`));
        return block.ordered
          ? <ol key={key} start={block.start} className="list-decimal space-y-1 pl-5">{items}</ol>
          : <ul key={key} className="list-disc space-y-1 pl-5">{items}</ul>;
      }
      case "table":
        return (
          <div key={key} className="max-w-full overflow-x-auto rounded-lg border border-border-subtle">
            <table className="w-full border-collapse text-left text-[13px] tabular-nums">
              <thead className="bg-surface-card text-text-primary">
                <tr>
                  {block.header.map((cell, c) => (
                    <th key={c} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium ${alignClass(block.align[c] ?? null)}`}>{renderInline(cell, `${key}h${c}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className="border-t border-border-subtle">
                    {row.map((cell, c) => (
                      <td key={c} className={`px-3 py-2 align-top ${alignClass(block.align[c] ?? null)}`}>{renderInline(cell, `${key}r${r}c${c}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

function ChatMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="space-y-3 break-words">{renderBlocks(blocks, "b")}</div>;
}

export default memo(ChatMarkdown);
