import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Shared renderer for AI-generated markdown (retro summaries, trend analyses,
 * etc.). Uses react-markdown + remark-gfm so inline formatting, lists, and
 * tables render correctly. Styling tuned to match the surrounding prose.
 */
export function MarkdownBlock({ text }: { text: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h3 className="font-semibold text-foreground mt-4 mb-2 text-base" {...props} />,
          h2: (props) => <h3 className="font-semibold text-foreground mt-4 mb-2 text-base" {...props} />,
          h3: (props) => <h4 className="font-semibold text-foreground mt-3 mb-1 text-sm" {...props} />,
          h4: (props) => <h5 className="font-semibold text-foreground mt-3 mb-1 text-sm" {...props} />,
          p: (props) => <p className="text-muted-foreground my-2" {...props} />,
          strong: (props) => <strong className="font-semibold text-foreground" {...props} />,
          ul: (props) => <ul className="list-disc pl-5 space-y-1 my-2 text-muted-foreground" {...props} />,
          ol: (props) => <ol className="list-decimal pl-5 space-y-1 my-2 text-muted-foreground" {...props} />,
          li: (props) => <li className="marker:text-muted-foreground/60" {...props} />,
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            return isInline ? (
              <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono" {...props}>
                {children}
              </code>
            ) : (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          table: (props) => (
            <div className="overflow-x-auto my-3">
              <table className="w-full text-xs border-collapse" {...props} />
            </div>
          ),
          thead: (props) => <thead className="border-b border-border" {...props} />,
          th: (props) => <th className="px-2 py-1.5 text-left font-medium text-foreground" {...props} />,
          td: (props) => <td className="px-2 py-1 border-t border-border/50 text-muted-foreground" {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
