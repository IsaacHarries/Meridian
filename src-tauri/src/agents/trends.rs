use super::dispatch;
use serde::Deserialize;
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

struct SprintStats<'a> {
    name: &'a str,
    committed_points: f64,
    completed_points: f64,
    velocity_pct: f64,
    total_issues: usize,
    completed_issues: usize,
    completion_rate_pct: f64,
    carryover_count: usize,
    carryover_pct: f64,
    bug_count: usize,
    story_count: usize,
    task_count: usize,
    blocker_count: usize,
    bug_story_ratio: Option<f64>,
    prs_total: usize,
    prs_merged: usize,
    avg_cycle_hours: Option<f64>,
    avg_comments_per_pr: Option<f64>,
    unique_pr_authors: usize,
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

fn compute_stats(s: &TrendSprintInput) -> SprintStats<'_> {
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

    SprintStats {
        name: &s.name,
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
        blocker_count,
        bug_story_ratio,
        prs_total,
        prs_merged,
        avg_cycle_hours,
        avg_comments_per_pr,
        unique_pr_authors,
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
    sprints: Vec<TrendSprintInput>,
) -> Result<String, String> {
    if sprints.len() < 2 {
        return Err("At least 2 sprints are required for trend analysis.".into());
    }

    let (client, api_key) = dispatch::llm_client().await?;

    let stats: Vec<SprintStats> = sprints.iter().map(compute_stats).collect();
    let stats_table = format_stats_table(&stats);
    let raw_block = format_raw_block(&sprints);

    let system = "You are an experienced agile coach analysing multiple sprints for a \
        scrum master. Your goal is to help them gauge what the team did well, what needs \
        improvement, and what concrete changes they should try next sprint to succeed. \
        \n\n\
        You receive BOTH pre-computed statistics (verified, computed server-side) AND raw \
        issue/PR data. Use the pre-computed statistics as the authoritative source for \
        numbers. Use the raw data to identify specific patterns: which ticket types recur \
        in carry-over, which assignees are consistently overloaded, which PR authors have \
        long cycle times, which issue keys keep re-appearing, etc. \
        \n\n\
        Be specific and data-driven. Cite ticket keys, sprint names, and numbers from the \
        pre-computed table. Avoid generic agile platitudes. Every recommendation must be \
        grounded in something you observed in the data.";

    let user = format!(
        "Analyse trends across these sprints and produce a retrospective for the scrum master.\n\n\
        # Pre-Computed Statistics (authoritative — use these numbers)\n\n\
        {stats_table}\n\n\
        ## Metric definitions\n\
        - **Velocity**: completed story points / committed story points\n\
        - **Completion %**: completed issues / total issues committed\n\
        - **Carry-over**: issues not done by end of sprint (count and % of committed)\n\
        - **Bug:Story**: bug count / story count (a rough quality vs. feature-work ratio)\n\
        - **Blockers**: issues with priority Blocker, Highest, or Critical\n\
        - **PRs**: pull requests updated within the sprint's date window\n\
        - **Avg Cycle**: mean hours between createdOn → updatedOn for MERGED PRs only\n\
        - **Avg Comments**: mean commentCount across all PRs in the window\n\n\
        # Raw Issue & PR Data (use for pattern identification)\n\n\
        {raw_block}\n\n\
        # Output Format\n\n\
        Respond in markdown with these sections in this order:\n\n\
        ## Overview\n\
        One paragraph: period covered, overall trajectory (improving, declining, stable, volatile).\n\n\
        ## Trends in the Statistics\n\
        Walk through the stats table and call out which metrics are trending up, down, or flat. \
        Quote specific numbers.\n\n\
        ## What's Going Well\n\
        3–5 specific strengths, each backed by numbers from the table or examples from the raw data.\n\n\
        ## What Needs Improvement\n\
        3–5 specific issues, each backed by numbers or recurring patterns. Call out patterns \
        explicitly (e.g. \"3 of 4 sprints had at least one blocker-priority ticket carry over\").\n\n\
        ## Notable Patterns & Observations\n\
        Things the stats table doesn't show on its own — correlations between metrics, specific \
        assignees or authors consistently at the extremes, tickets that re-surfaced across sprints, \
        etc.\n\n\
        ## Recommendations for Next Sprint\n\
        3–5 concrete, testable actions. Each must say *what to try* and *what outcome to look for* \
        to know it worked. No generic advice.\n\n\
        ## Opening Notes for the Retro Meeting\n\
        2–3 sentences the scrum master can read verbatim to open the retrospective."
    );

    dispatch::dispatch(&app, &client, &api_key, system, &user, 4096).await
}
