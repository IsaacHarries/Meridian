import { SlashCommandInput } from "@/components/SlashCommandInput";
import {
    gatherNamePool,
    gatherTagPool,
} from "@/lib/meetingPeople";
import {
    createGlobalCommands,
    type SlashCommand,
} from "@/lib/slashCommands";
import { type MeetingRecord } from "@/lib/tauri/meetings";
import { cn } from "@/lib/utils";
import { useMeetingsStore } from "@/stores/meetings/store";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

export function MeetingChatPanel({ record }: { record: MeetingRecord }) {
  const busy = useMeetingsStore((s) => s.busy);
  const streamText = useMeetingsStore((s) => s.chatStreamText);
  const sendChatMessage = useMeetingsStore((s) => s.sendChatMessage);
  const sendCrossMeetingsSearch = useMeetingsStore(
    (s) => s.sendCrossMeetingsSearch,
  );
  const summarizeSelected = useMeetingsStore((s) => s.summarizeSelected);
  const clearSelectedChat = useMeetingsStore((s) => s.clearSelectedChat);
  const dropLastAssistantTurn = useMeetingsStore((s) => s.dropLastAssistantTurn);
  // Live pools for `/search #tag @name` autocomplete inside the chat
  // input. Pulled fresh from the meetings store so newly tagged or
  // mentioned names show up without remounting the panel.
  const allMeetings = useMeetingsStore((s) => s.meetings);
  const tagPool = useMemo(() => gatherTagPool(allMeetings), [allMeetings]);
  const namePool = useMemo(() => gatherNamePool(allMeetings), [allMeetings]);
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isBusy = busy.has(record.id);
  const history = record.chatHistory ?? [];

  // Auto-scroll to the latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, isBusy]);

  // Resolve speaker id → name for the /speakers output.
  const speakerLines = useMemo(() => {
    const lines: string[] = [];
    for (const sp of record.speakers ?? []) {
      lines.push(
        sp.displayName ? `${sp.id} — ${sp.displayName}` : `${sp.id} (unnamed)`,
      );
    }
    return lines;
  }, [record.speakers]);

  // Notes-mode meetings have no transcript, no speakers, no audio timestamps,
  // and no persistent Summary section — so the slash commands tied to those
  // surfaces aren't useful. Hide them so the picker only shows commands that
  // actually do something.
  const isNotesMode = record.kind === "notes";

  const commands: SlashCommand[] = useMemo(() => {
    const transcriptOnly: SlashCommand[] = [
      {
        name: "summarize",
        description: "Regenerate this meeting's summary",
        execute: async () => {
          await summarizeSelected();
          toast.success("Regenerating summary…");
        },
      },
      {
        name: "speakers",
        description: "List speakers and any names assigned",
        execute: ({ toast: t }) => {
          if (speakerLines.length === 0) {
            t.info("No speakers have been detected for this meeting");
            return;
          }
          t("Speakers", { description: speakerLines.join("\n") });
        },
      },
      {
        name: "transcript",
        description: "Ask for the full diarized transcript",
        execute: async () => {
          await sendChatMessage(
            "Please provide the full diarized transcript in a readable form, with speaker names where known.",
          );
        },
      },
      {
        name: "at",
        description: "Focus the next question on a timestamp",
        args: "HH:MM",
        execute: ({ args, setInput }) => {
          const ts = args.trim();
          if (!ts) {
            setInput("/at ");
            return;
          }
          setInput(`At ${ts} — `);
        },
      },
    ];

    const shared: SlashCommand[] = [
      {
        name: "actions",
        description: "Ask for just the action items",
        execute: async () => {
          await sendChatMessage(
            "List just the action items from this meeting as a bulleted list, with the owner if mentioned.",
          );
        },
      },
      {
        name: "decisions",
        description: "Ask for just the decisions made",
        execute: async () => {
          await sendChatMessage(
            "List just the decisions that were made during this meeting as a bulleted list.",
          );
        },
      },
      {
        name: "search",
        description: "Search every indexed meeting and answer with citations",
        args: "<query>",
        execute: async ({ args, setInput, toast: t }) => {
          const q = args.trim();
          if (!q) {
            // Prefill the input so the user types the body and submits.
            setInput("/search ");
            return;
          }
          try {
            await sendCrossMeetingsSearch(q);
          } catch (e) {
            t.error("Cross-meetings search failed", {
              description: e instanceof Error ? e.message : String(e),
            });
          }
        },
      },
    ];

    return [
      ...createGlobalCommands({
        history,
        clearHistory: clearSelectedChat,
        sendMessage: sendChatMessage,
        removeLastAssistantMessage: dropLastAssistantTurn,
      }),
      ...(isNotesMode ? [] : transcriptOnly),
      ...shared,
    ];
  }, [
    history,
    clearSelectedChat,
    sendChatMessage,
    sendCrossMeetingsSearch,
    dropLastAssistantTurn,
    summarizeSelected,
    speakerLines,
    isNotesMode,
  ]);

  return (
    <>
      <div className="shrink-0 px-4 py-2.5 border-b flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Ask about this meeting
        </p>
        {isBusy && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground italic text-center pt-6">
            Ask anything about this meeting — what was discussed, decisions made,
            action items, or details you want to recall. Type <span className="font-mono">/</span> to see commands;
            use <span className="font-mono">/search &lt;query&gt;</span> to search across every indexed meeting
            (filter with <span className="font-mono">#tag</span> or <span className="font-mono">@name</span>, e.g.{" "}
            <span className="font-mono">/search #standup @alice blockers</span>).
          </p>
        ) : (
          history.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                msg.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[90%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}
        {isBusy && (
          <div className="flex justify-start pt-1">
            <div className="bg-muted rounded-lg px-3 py-2 max-w-[90%] text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              {streamText[record.id] ? (
                streamText[record.id]
              ) : (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </span>
              )}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 px-4 pb-4 pt-2 border-t">
        <SlashCommandInput
          value={input}
          onChange={setInput}
          onSend={async (text) => {
            try {
              await sendChatMessage(text);
            } catch (e) {
              toast.error("Chat failed", { description: String(e) });
            }
          }}
          commands={commands}
          busy={isBusy}
          placeholder="Ask about this meeting. Enter to send. / for commands."
          tagPool={tagPool}
          namePool={namePool}
        />
      </div>
    </>
  );
}
