import { memo, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

/**
 * Morrow's single Markdown rendering path for assistant prose and markdown
 * artifacts. Security posture:
 *
 * - Model output is parsed, never injected: no raw HTML rendering
 *   (rehype-raw is deliberately absent) and rehype-sanitize strips any HTML
 *   that slipped into the source.
 * - Links are protocol-filtered (http/https/mailto only) and external links
 *   get rel="noreferrer noopener" + target="_blank".
 * - Task-list checkboxes render disabled; they are display, not controls.
 *
 * Streaming posture: while `streaming` is true, an unclosed trailing code
 * fence is auto-closed so partial output does not flash broken syntax; the
 * completed render always parses the exact final text.
 */

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-./]],
    input: ["type", "checked", "disabled"],
  },
};

function urlTransform(url: string): string {
  // Block javascript:/data:/vbscript: outright; allow relative + safe protocols.
  const transformed = defaultUrlTransform(url);
  return transformed;
}

/** Close an unterminated trailing fence so streaming output stays parseable. */
export function normalizeStreamingMarkdown(text: string): string {
  let fenceCount = 0;
  for (const match of text.matchAll(/^(`{3,}|~{3,})/gm)) {
    void match;
    fenceCount += 1;
  }
  if (fenceCount % 2 === 0) return text;
  const opener = text.match(/^(`{3,}|~{3,})/m)?.[1] ?? "```";
  const closer = opener[0] === "~" ? "~".repeat(opener.length) : "`".repeat(opener.length);
  return `${text}\n${closer}`;
}

function extractText(node: ReactNode): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (typeof node === "object" && "props" in (node as unknown as Record<string, unknown>)) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return extractText(props?.children);
  }
  return "";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      aria-label="Copy code to clipboard"
      className="morrow-markdown__copy"
      onClick={() => {
        const done = () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_600);
        };
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).then(done, done);
        } else {
          const area = document.createElement("textarea");
          area.value = text;
          document.body.appendChild(area);
          area.select();
          try {
            document.execCommand("copy");
          } catch {
            // best-effort fallback; the button still acknowledges
          }
          document.body.removeChild(area);
          done();
        }
      }}
      type="button"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  // children is the <code> element React Markdown built for this block.
  const codeElement = Array.isArray(children) ? children[0] : children;
  const props = (codeElement as { props?: { className?: string; children?: ReactNode } } | null)?.props;
  const className = props?.className ?? "";
  const language = /language-([\w+-]+)/.exec(className)?.[1] ?? "text";
  const text = extractText(props?.children ?? children).replace(/\n$/, "");
  return (
    <div className="morrow-markdown__codeblock">
      <div className="morrow-markdown__codeblock-header">
        <span className="morrow-markdown__codeblock-lang">{language}</span>
        <CopyButton text={text} />
      </div>
      <pre className="morrow-markdown__pre">
        <code className={className || undefined}>{text}</code>
      </pre>
    </div>
  );
}

export interface MarkdownProps {
  text: string;
  /** True while this message is still streaming; closes dangling fences. */
  streaming?: boolean;
  className?: string;
}

export const Markdown = memo(function Markdown({ text, streaming = false, className }: MarkdownProps) {
  const source = useMemo(
    () => (streaming ? normalizeStreamingMarkdown(text) : text),
    [text, streaming],
  );
  return (
    <div className={`morrow-markdown${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => {
            const safe = href ? urlTransform(href) : "";
            // A URL the sanitizer stripped entirely (javascript:, data:, …)
            // must not render as a link at all — plain text instead.
            if (href && !safe) return <span>{children}</span>;
            const external = /^https?:\/\//i.test(safe);
            return (
              <a
                className="morrow-markdown__link"
                href={safe}
                {...(external ? { rel: "noreferrer noopener", target: "_blank" } : {})}
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="morrow-markdown__table-scroll" role="region" aria-label="Table" tabIndex={0}>
              <table>{children}</table>
            </div>
          ),
          input: ({ checked }) => (
            <input aria-label={checked ? "Completed task" : "Open task"} checked={!!checked} disabled readOnly type="checkbox" />
          ),
        }}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
