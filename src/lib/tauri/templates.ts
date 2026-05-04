import { invoke } from "@tauri-apps/api/core";

export type SkillType = "grooming" | "patterns" | "implementation" | "review";

export async function loadAgentSkills(): Promise<Record<SkillType, string>> {
  return invoke<Record<SkillType, string>>("load_agent_skills");
}

export async function saveAgentSkill(
  skillType: SkillType,
  content: string,
): Promise<void> {
  return invoke("save_agent_skill", { skillType, content });
}

export async function deleteAgentSkill(skillType: SkillType): Promise<void> {
  return invoke("delete_agent_skill", { skillType });
}

// ── PR description template ───────────────────────────────────────────────────

/** Mode controlling how strictly the PR Description agent follows the template. */
export type PrTemplateMode = "guide" | "strict";

/** Read the PR description template markdown. Returns "" if not yet set. */
export async function loadPrTemplate(): Promise<string> {
  return invoke<string>("load_pr_template");
}

/** Save the PR description template markdown. Empty content clears it. */
export async function savePrTemplate(content: string): Promise<void> {
  return invoke<void>("save_pr_template", { content });
}

/** Absolute path to the template file on disk (for display in Settings). */
export async function getPrTemplatePath(): Promise<string> {
  return invoke<string>("get_pr_template_path");
}

/** Open the containing folder in the OS file manager. */
export async function revealPrTemplateDir(): Promise<void> {
  return invoke<void>("reveal_pr_template_dir");
}

// ── Grooming format templates ────────────────────────────────────────────────

/** Named grooming format templates. Stored as Markdown files alongside the PR template. */
export type GroomingTemplateKind = "acceptance_criteria" | "steps_to_reproduce";

/** Read a grooming format template. Returns "" if not yet set. */
export async function loadGroomingTemplate(
  kind: GroomingTemplateKind,
): Promise<string> {
  return invoke<string>("load_grooming_template", { kind });
}

/** Save a grooming format template. Empty content clears it. */
export async function saveGroomingTemplate(
  kind: GroomingTemplateKind,
  content: string,
): Promise<void> {
  return invoke<void>("save_grooming_template", { kind, content });
}

/** Absolute path to a grooming template file on disk (for display in Settings). */
export async function getGroomingTemplatePath(
  kind: GroomingTemplateKind,
): Promise<string> {
  return invoke<string>("get_grooming_template_path", { kind });
}

/** Open the templates folder in the OS file manager. */
export async function revealGroomingTemplatesDir(): Promise<void> {
  return invoke<void>("reveal_grooming_templates_dir");
}
