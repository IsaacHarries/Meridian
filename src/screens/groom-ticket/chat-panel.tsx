import { SlashCommandInput } from "@/components/SlashCommandInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type SlashCommand } from "@/lib/slashCommands";
import { type GroomingOutput } from "@/lib/tauri/workflows";
import { Loader2, PanelRightClose } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type GroomChatMessage, buildStreamingPreview } from "./_shared";

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: GroomChatMessage }) {
  const isAssistant = msg.role === "assistant";
  return (
    <div className={`flex ${isAssistant ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${isAssistant ? "bg-muted text-foreground rounded-tl-sm" : "bg-primary text-primary-foreground rounded-tr-sm"}`}>
        {msg.content}
      </div>
    </div>
  );
}

// ── Chat panel ────────────────────────────────────────────────────────────────

export function ChatPanel({
  messages,
  thinking,
  probeStatus,
  partialOutput,
  onSend,
  commands,
  onCollapse,
}: {
  messages: GroomChatMessage[];
  thinking: boolean;
  probeStatus: string;
  /** Streaming partial output emitted by the grooming agent while it's
   *  still mid-response. When non-null, the "Thinking…" bubble swaps to
   *  a live preview that grows token-by-token instead of sitting blank. */
  partialOutput: Partial<GroomingOutput> | null;
  onSend: (text: string) => void;
  commands: SlashCommand[];
  /** When provided, renders a collapse button in the header so the user
   *  can hide the chat pane to give the middle column more room. */
  onCollapse?: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, partialOutput]);

  const streamingPreview = thinking && partialOutput
    ? buildStreamingPreview(partialOutput)
    : "";

  return (
    <Card className="flex flex-col min-h-0 flex-1">
      <CardHeader className="pb-2 shrink-0 border-b">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-semibold">Grooming Assistant</CardTitle>
            <p className="text-xs text-muted-foreground">Ask questions or request field changes — e.g. "update the AC to…"</p>
          </div>
          {onCollapse && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              onClick={onCollapse}
              title="Hide chat"
              aria-label="Hide chat"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col flex-1 min-h-0 pt-3">
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 min-h-0">
          {messages.length === 0 && !thinking && (
            <p className="text-xs text-muted-foreground text-center pt-4 leading-relaxed">
              The assistant will appear here after the initial analysis.<br />
              You can ask it to refine any draft field.
            </p>
          )}
          {messages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}
          {thinking && !streamingPreview && (
            <div className="flex justify-start">
              <div className="bg-muted text-muted-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {probeStatus || "Thinking…"}
              </div>
            </div>
          )}
          {thinking && streamingPreview && (
            <div className="flex justify-start">
              <div className="bg-muted text-foreground px-4 py-2.5 rounded-2xl rounded-tl-sm text-sm leading-relaxed whitespace-pre-wrap max-w-[85%]">
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Analyzing…
                </div>
                {streamingPreview}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="pt-3 border-t shrink-0">
          <SlashCommandInput
            value={value}
            onChange={setValue}
            onSend={(text) => onSend(text)}
            commands={commands}
            busy={thinking}
            placeholder='Ask a question or say "update the AC to…". Enter to send. / for commands.'
          />
        </div>
      </CardContent>
    </Card>
  );
}
