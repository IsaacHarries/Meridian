import { Loader2, MessageSquare } from "lucide-react";
import { SlashCommandInput } from "@/components/SlashCommandInput";
import { type SlashCommand } from "@/lib/slashCommands";
import { ToolRequestCard, type ToolRequest } from "@/components/ToolRequestCard";

interface ReviewChatProps {
  reviewChat: { role: "user" | "assistant"; content: string }[];
  reviewChatStreamText: string;
  reviewChatSending: boolean;
  reviewChatInput: string;
  setReviewChatInput: (s: string) => void;
  onSend: (text: string) => Promise<void>;
  commands: SlashCommand[];
  toolRequests: ToolRequest[];
  onDismissToolRequest: (id: string) => void;
  chatBottomRef: React.RefObject<HTMLDivElement>;
}

export function ReviewChat({
  reviewChat,
  reviewChatStreamText,
  reviewChatSending,
  reviewChatInput,
  setReviewChatInput,
  onSend,
  commands,
  toolRequests,
  onDismissToolRequest,
  chatBottomRef,
}: ReviewChatProps) {
  return (
    <div className="border-t">
      {/* Chat header */}
      <div className="px-4 py-3 flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Ask the reviewer
        </p>
      </div>

      {/* Messages */}
      <div className="px-4 space-y-3 pb-3">
        {reviewChat.length === 0 && (
          <p className="text-xs text-muted-foreground italic text-center py-2">
            Ask a question about any finding — why it was raised, whether it applies given your context, or to reassess something.
          </p>
        )}
        {reviewChat.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
              msg.role === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground"
            }`}>
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
        {/* Tool request cards — shown inline after messages */}
        {toolRequests.filter(r => !r.dismissed).map(r => (
          <ToolRequestCard
            key={r.id}
            request={r}
            onDismiss={onDismissToolRequest}
          />
        ))}
        {reviewChatSending && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2 text-sm text-foreground max-w-[90%]">
              {reviewChatStreamText ? (
                <p className="whitespace-pre-wrap leading-relaxed">{reviewChatStreamText}</p>
              ) : (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </span>
              )}
            </div>
          </div>
        )}
        <div ref={chatBottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 pb-4 space-y-2 border-t pt-3">
        <SlashCommandInput
          value={reviewChatInput}
          onChange={setReviewChatInput}
          onSend={onSend}
          commands={commands}
          busy={reviewChatSending}
          placeholder="Ask about a finding. Enter to send. / for commands."
        />
      </div>
    </div>
  );
}
