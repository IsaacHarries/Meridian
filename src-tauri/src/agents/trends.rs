use super::dispatch::AiContext;
use crate::commands::workflows::resolve_model_for_context;
use crate::integrations::sidecar::SidecarState;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ── Input schema ──────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrendSprintInput {
    pub name: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub goal: Option<String>,
    pub issues: Vec<TrendIssueInput>,
    /// PRs already filtered to this sprint's date window by the caller.
    pub prs: Vec<TrendPrInput>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrendIssueInput {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub status_category: String,
    pub issue_type: String,
    pub priority: Option<String>,
    pub story_points: Option<f64>,
    pub assignee: Option<String>,
    pub completed_in_sprint: Option<bool>,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrendPrInput {
    pub id: i64,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub created_on: String,
    pub updated_on: String,
    /// Hours between createdOn and updatedOn, pre-computed by the frontend.
    /// Only averaged over MERGED PRs.
    pub cycle_hours: Option<f64>,
    pub comment_count: i64,
}

// ── Stats ─────────────────────────────────────────────────────────────────────

/// Per-sprint computed statistics. Returned to the frontend so saved analyses
/// can re-render charts without recomputing client-side.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SprintStats {
    pub name: String,
    pub committed_points: f64,
    pub completed_points: f64,
    pub velocity_pct: f64,
    pub total_issues: usize,
    pub completed_issues: usize,
    pub completion_rate_pct: f64,
    pub carryover_count: usize,
    pub carryover_pct: f64,
    pub bug_count: usize,
    pub story_count: usize,
    pub task_count: usize,
    pub other_issue_count: usize,
    pub blocker_count: usize,
    pub bug_story_ratio: Option<f64>,
    pub prs_total: usize,
    pub prs_merged: usize,
    pub avg_cycle_hours: Option<f64>,
    pub avg_comments_per_pr: Option<f64>,
    pub unique_pr_authors: usize,
    /// Completed points per assignee this sprint (for per-assignee charts).
    pub assignee_completed_points: Vec<AssigneePoints>,
    pub assignee_assigned_points: Vec<AssigneePoints>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssigneePoints {
    pub name: String,
    pub points: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendAnalysisResult {
    pub markdown: String,
    pub stats: Vec<SprintStats>,
}

fn is_done(i: &TrendIssueInput) -> bool {
    i.completed_in_sprint.unwrap_or(i.status_category == "Done")
}

fn is_bug(t: &str) -> bool {
    t.eq_ignore_ascii_case("Bug")
}
fn is_story(t: &str) -> bool {
    t.eq_ignore_ascii_case("Story")
}
fn is_task(t: &str) -> bool {
    t.eq_ignore_ascii_case("Task") || t.eq_ignore_ascii_case("Sub-task")
}
fn is_blocker_priority(p: Option<&str>) -> bool {
    match p {
        Some(s) => {
            let lc = s.to_ascii_lowercase();
            matches!(lc.as_str(), "blocker" | "highest" | "critical")
        }
        None => false,
    }
}

fn compute_stats(s: &TrendSprintInput) -> SprintStats {
    let total_issues = s.issues.len();
    let completed_count = s.issues.iter().filter(|i| is_done(i)).count();
    let carryover_count = total_issues - completed_count;

    let committed_points: f64 = s.issues.iter().filter_map(|i| i.story_points).sum();
    let completed_points: f64 = s
        .issues
        .iter()
        .filter(|i| is_done(i))
        .filter_map(|i| i.story_points)
        .sum();

    let completion_rate_pct = if total_issues > 0 {
        (completed_count as f64 / total_issues as f64) * 100.0
    } else {
        0.0
    };
    let carryover_pct = if total_issues > 0 {
        (carryover_count as f64 / total_issues as f64) * 100.0
    } else {
        0.0
    };
    let velocity_pct = if committed_points > 0.0 {
        (completed_points / committed_points) * 100.0
    } else {
        0.0
    };

    let bug_count = s.issues.iter().filter(|i| is_bug(&i.issue_type)).count();
    let story_count = s.issues.iter().filter(|i| is_story(&i.issue_type)).count();
    let task_count = s.issues.iter().filter(|i| is_task(&i.issue_type)).count();
    let other_issue_count = total_issues - bug_count - story_count - task_count;
    let blocker_count = s
        .issues
        .iter()
        .filter(|i| is_blocker_priority(i.priority.as_deref()))
        .count();
    let bug_story_ratio = if story_count > 0 {
        Some(bug_count as f64 / story_count as f64)
    } else {
        None
    };

    let prs_total = s.prs.len();
    let merged_cycles: Vec<f64> = s
        .prs
        .iter()
        .filter(|p| p.state.eq_ignore_ascii_case("MERGED"))
        .filter_map(|p| p.cycle_hours)
        .collect();
    let prs_merged = s
        .prs
        .iter()
        .filter(|p| p.state.eq_ignore_ascii_case("MERGED"))
        .count();
    let avg_cycle_hours = if merged_cycles.is_empty() {
        None
    } else {
        Some(merged_cycles.iter().sum::<f64>() / merged_cycles.len() as f64)
    };
    let avg_comments_per_pr = if prs_total > 0 {
        Some(s.prs.iter().map(|p| p.comment_count as f64).sum::<f64>() / prs_total as f64)
    } else {
        None
    };

    let mut authors: HashSet<&str> = HashSet::new();
    for p in &s.prs {
        if let Some(a) = p.author.as_deref() {
            authors.insert(a);
        }
    }
    let unique_pr_authors = authors.len();

    // Per-assignee aggregation for workload chart.
    let mut assigned_map: std::collections::HashMap<String, f64> = Default::default();
    let mut completed_map: std::collections::HashMap<String, f64> = Default::default();
    for issue in &s.issues {
        let name = issue
            .assignee
            .clone()
            .unwrap_or_else(|| "Unassigned".to_string());
        let pts = issue.story_points.unwrap_or(0.0);
        *assigned_map.entry(name.clone()).or_insert(0.0) += pts;
        if is_done(issue) {
            *completed_map.entry(name).or_insert(0.0) += pts;
        }
    }
    let assignee_assigned_points: Vec<AssigneePoints> = assigned_map
        .into_iter()
        .map(|(name, points)| AssigneePoints { name, points })
        .collect();
    let assignee_completed_points: Vec<AssigneePoints> = completed_map
        .into_iter()
        .map(|(name, points)| AssigneePoints { name, points })
        .collect();

    SprintStats {
        name: s.name.clone(),
        committed_points,
        completed_points,
        velocity_pct,
        total_issues,
        completed_issues: completed_count,
        completion_rate_pct,
        carryover_count,
        carryover_pct,
        bug_count,
        story_count,
        task_count,
        other_issue_count,
        blocker_count,
        bug_story_ratio,
        prs_total,
        prs_merged,
        avg_cycle_hours,
        avg_comments_per_pr,
        unique_pr_authors,
        assignee_assigned_points,
        assignee_completed_points,
    }
}

// ── Formatting ────────────────────────────────────────────────────────────────

fn format_stats_table(stats: &[SprintStats]) -> String {
    let mut out = String::new();
    out.push_str(
        "| Sprint | Committed pts | Completed pts | Velocity | Tickets D/T | Completion % | Carry-over | Bugs | Stories | Tasks | Bug:Story | Blockers | PRs | Merged | Avg Cycle (h) | Avg Comments | PR Authors |\n",
    );
    out.push_str(
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n",
    );
    for s in stats {
        let bs = s
            .bug_story_ratio
            .map(|r| format!("{:.2}", r))
            .unwrap_or_else(|| "—".into());
        let cycle = s
            .avg_cycle_hours
            .map(|h| format!("{:.1}", h))
            .unwrap_or_else(|| "—".into());
        let comments = s
            .avg_comments_per_pr
            .map(|c| format!("{:.1}", c))
            .unwrap_or_else(|| "—".into());
        out.push_str(&format!(
            "| {} | {:.1} | {:.1} | {:.0}% | {}/{} | {:.0}% | {} ({:.0}%) | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |\n",
            s.name,
            s.committed_points,
            s.completed_points,
            s.velocity_pct,
            s.completed_issues, s.total_issues,
            s.completion_rate_pct,
            s.carryover_count, s.carryover_pct,
            s.bug_count,
            s.story_count,
            s.task_count,
            bs,
            s.blocker_count,
            s.prs_total,
            s.prs_merged,
            cycle,
            comments,
            s.unique_pr_authors,
        ));
    }
    out
}

fn short_date(s: Option<&str>) -> &str {
    match s {
        Some(d) if d.len() >= 10 => &d[..10],
        Some(d) => d,
        None => "?",
    }
}

fn format_raw_block(sprints: &[TrendSprintInput]) -> String {
    let mut out = String::new();
    for s in sprints {
        out.push_str(&format!("========== {} ==========\n", s.name));
        out.push_str(&format!(
            "Dates: {} → {}\n",
            short_date(s.start_date.as_deref()),
            short_date(s.end_date.as_deref()),
        ));
        if let Some(goal) = s.goal.as_deref() {
            if !goal.is_empty() {
                out.push_str(&format!("Goal: {goal}\n"));
            }
        }
        out.push('\n');

        out.push_str(&format!("ISSUES ({}):\n", s.issues.len()));
        if s.issues.is_empty() {
            out.push_str("  (no issues)\n");
        } else {
            for i in &s.issues {
                let done = if is_done(i) { "DONE" } else { "NOT_DONE" };
                let pts = i.story_points.unwrap_or(0.0);
                let assignee = i.assignee.as_deref().unwrap_or("Unassigned");
                let priority = i.priority.as_deref().unwrap_or("-");
                out.push_str(&format!(
                    "  {} | {} | prio={} | {} | {} | {}pts | {} | {}\n",
                    i.key, i.issue_type, priority, i.status, done, pts, assignee, i.summary
                ));
            }
        }
        out.push('\n');

        out.push_str(&format!("PULL REQUESTS ({}):\n", s.prs.len()));
        if s.prs.is_empty() {
            out.push_str("  (none in sprint window)\n");
        } else {
            for p in &s.prs {
                let cycle = p
                    .cycle_hours
                    .map(|h| format!("{:.0}h", h))
                    .unwrap_or_else(|| "?".into());
                let author = p.author.as_deref().unwrap_or("?");
                out.push_str(&format!(
                    "  #{} | {} | {} → {} ({}) | {} comments | {} | {}\n",
                    p.id,
                    p.state,
                    short_date(Some(&p.created_on)),
                    short_date(Some(&p.updated_on)),
                    cycle,
                    p.comment_count,
                    author,
                    p.title
                ));
            }
        }
        out.push('\n');
    }
    out
}

// ── Command ───────────────────────────────────────────────────────────────────

/// Analyse trends across multiple sprints. Receives structured raw data per
/// sprint, computes a table of hard statistics (velocity, completion rate,
/// carry-over, bug:story ratio, blocker frequency, PR throughput, avg cycle
/// time, comment density) server-side, then sends BOTH the stats table and
/// the raw data to the AI for pattern analysis.
#[tauri::command]
pub async fn generate_multi_sprint_trends(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    sprints: Vec<TrendSprintInput>,
) -> Result<TrendAnalysisResult, String> {
    if sprints.len() < 2 {
        return Err("At least 2 sprints are required for trend analysis.".into());
    }

    // Stats are pure data work — kept in Rust. The LLM-driven analysis is
    // delegated to the sidecar's `multi_sprint_trends` workflow.
    let stats: Vec<SprintStats> = sprints.iter().map(compute_stats).collect();
    let stats_table = format_stats_table(&stats);
    let raw_block = format_raw_block(&sprints);

    let ctx = AiContext::panel("retrospectives");
    let model = resolve_model_for_context(&ctx).await?;

    let input = serde_json::json!({
        "statsTable": stats_table,
        "rawBlock": raw_block,
    });

    let result = crate::integrations::sidecar::run_workflow(
        &app,
        &state,
        "multi-sprint-trends-workflow-event",
        "multi_sprint_trends",
        input,
        model,
        None,
    )
    .await?;

    let markdown = result
        .output
        .as_ref()
        .and_then(|v| v.get("markdown"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(TrendAnalysisResult { markdown, stats })
}
