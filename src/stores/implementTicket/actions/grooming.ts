import { updateJiraIssue } from "@/lib/tauri/jira";
import { type SuggestedEdit, type SuggestedEditStatus, type TriageMessage, parseAgentJson, runGroomingChatTurn } from "@/lib/tauri/workflows";
import { detectGroomingBlockers } from "../helpers";
import type { ImplementTicketState } from "../types";

type Set = (
  partial:
    | Partial<ImplementTicketState>
    | ((s: ImplementTicketState) => Partial<ImplementTicketState>),
) => void;
type Get = () => ImplementTicketState;

export function createGroomingActions(set: Set, get: Get) {
  return {
    handleApproveEdit: (id: string) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "approved" as SuggestedEditStatus } : e,
        ),
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    handleDeclineEdit: (id: string) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, status: "declined" as SuggestedEditStatus } : e,
        ),
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    handleEditSuggested: (id: string, newSuggested: string) =>
      set((s) => ({
        groomingEdits: s.groomingEdits.map((e) =>
          e.id === id ? { ...e, suggested: newSuggested } : e,
        ),
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    clearEditHighlight: (id: string) =>
      set((s) => ({
        groomingHighlights: {
          ...s.groomingHighlights,
          editIds: s.groomingHighlights.editIds.filter((e) => e !== id),
        },
      })),

    clearAllGroomingHighlights: () =>
      set({
        groomingHighlights: { editIds: [], questions: false },
      }),

    toggleHighlights: () =>
      set((s) => ({ showHighlights: !s.showHighlights })),

    sendGroomingChatMessage: async (input: string) => {
      const {
        groomingChat,
        grooming,
        groomingEdits,
        ticketText,
        selectedIssue,
      } = get();

      if (groomingChat.length === 0 && get().groomingBaseline === null) {
        set({ groomingBaseline: grooming });
      }

      const userMsg: TriageMessage = { role: "user", content: input };
      const newHistory = [...groomingChat, userMsg];
      set({ groomingChat: newHistory });

      const systemContext = [
        "=== TICKET ===",
        ticketText,
        "=== CURRENT GROOMING ANALYSIS ===",
        JSON.stringify(grooming, null, 2),
        "=== CURRENT SUGGESTED EDITS (with IDs — use same IDs to update, new IDs to add) ===",
        JSON.stringify(
          groomingEdits.map(
            ({
              id,
              field,
              section,
              current,
              suggested,
              reasoning,
              status,
            }) => ({
              id,
              field,
              section,
              current,
              suggested,
              reasoning,
              status,
            }),
          ),
          null,
          2,
        ),
      ].join("\n");

      try {
        const response = await runGroomingChatTurn(
          systemContext,
          JSON.stringify(newHistory),
        );
        const parsed = parseAgentJson<{
          message: string;
          updated_edits: Omit<SuggestedEdit, "status">[];
          updated_questions: string[];
        }>(response);

        // If the full JSON failed to parse (most often because the response
        // was truncated mid-object), try to salvage just the prose `message`
        // field so the user sees clean text in the chat instead of raw JSON.
        // The panel won't update in this case — surface that clearly.
        let displayMessage: string;
        if (parsed?.message) {
          displayMessage = parsed.message;
        } else {
          const m = response.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const salvaged = m
            ? (() => {
                try {
                  return JSON.parse(`"${m[1]}"`) as string;
                } catch {
                  return null;
                }
              })()
            : null;
          displayMessage = salvaged
            ? `${salvaged}\n\n_(Note: the agent's response couldn't be fully parsed, so the panel above didn't update. Try asking again.)_`
            : "Sorry — the agent's response couldn't be parsed. Try rephrasing your message.";
        }
        set({
          groomingChat: [
            ...newHistory,
            { role: "assistant", content: displayMessage },
          ],
        });

        if (parsed) {
          const highlightEditIds: string[] = [];
          let questionsChanged = false;

          if (parsed.updated_edits && parsed.updated_edits.length > 0) {
            set((st) => {
              const existingById = new Map(
                st.groomingEdits.map((e) => [e.id, e]),
              );
              const merged = [...st.groomingEdits];
              for (const incoming of parsed.updated_edits) {
                const existing = existingById.get(incoming.id);
                if (existing) {
                  const idx = merged.findIndex((e) => e.id === incoming.id);
                  const textChanged =
                    existing.suggested !== incoming.suggested ||
                    existing.current !== incoming.current;
                  if (textChanged) highlightEditIds.push(incoming.id);
                  merged[idx] = {
                    ...incoming,
                    status: textChanged ? "pending" : existing.status,
                  };
                } else {
                  highlightEditIds.push(incoming.id);
                  merged.push({ ...incoming, status: "pending" });
                }
              }
              return { groomingEdits: merged };
            });
          }
          if (parsed.updated_questions !== undefined) {
            const prior = get().clarifyingQuestions;
            if (
              prior.length !== parsed.updated_questions.length ||
              prior.some((q, i) => q !== parsed.updated_questions[i])
            ) {
              questionsChanged = true;
            }
            set({ clarifyingQuestions: parsed.updated_questions });
          }

          if (highlightEditIds.length > 0 || questionsChanged) {
            set({
              groomingHighlights: {
                editIds: highlightEditIds,
                questions: questionsChanged,
              },
            });
          }
        }

        if (selectedIssue && grooming) {
          set({
            groomingBlockers: detectGroomingBlockers(
              selectedIssue,
              get().grooming!,
            ),
          });
        }
      } catch {
        /* silently handle */
      }
    },

    pushGroomingToJira: async () => {
      const { selectedIssue, groomingEdits, grooming } = get();
      if (!selectedIssue) return;
      const approved = groomingEdits.filter((e) => e.status === "approved");
      if (approved.length === 0) return;

      set({ jiraUpdateStatus: "saving", jiraUpdateError: "" });
      try {
        const descriptionFields: SuggestedEdit["field"][] = [
          "description",
          "acceptance_criteria",
        ];
        const descriptionEdits = approved.filter((e) =>
          descriptionFields.includes(e.field),
        );
        const otherEdits = approved.filter(
          (e) => !descriptionFields.includes(e.field),
        );

        if (descriptionEdits.length > 0 || grooming) {
          const g = grooming;
          const lines: string[] = [];
          if (g) lines.push(g.ticket_summary, "");

          const descEdit = descriptionEdits.find(
            (e) => e.field === "description",
          );
          const acEdit = descriptionEdits.find(
            (e) => e.field === "acceptance_criteria",
          );

          if (descEdit) {
            lines.push(descEdit.suggested, "");
          }
          if (acEdit) {
            lines.push("Acceptance Criteria:", acEdit.suggested, "");
          } else if (g && g.acceptance_criteria.length > 0) {
            lines.push("Acceptance Criteria:");
            g.acceptance_criteria.forEach((ac) => lines.push(`- ${ac}`));
            lines.push("");
          }

          await updateJiraIssue(
            selectedIssue.key,
            null,
            lines.join("\n").trim(),
          );
        }

        if (otherEdits.length > 0) {
          const fieldLabels = otherEdits.map((e) => e.section).join(", ");
          set({
            jiraUpdateError: `Saved. Note: ${fieldLabels} cannot be updated via the API — copy the suggested text and paste it into JIRA manually.`,
            jiraUpdateStatus: "saved",
          });
        } else {
          set({ jiraUpdateStatus: "saved" });
        }
      } catch (e) {
        set({ jiraUpdateError: String(e), jiraUpdateStatus: "error" });
      }
    },
  };
}
