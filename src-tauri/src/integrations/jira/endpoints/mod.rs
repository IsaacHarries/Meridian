// Endpoint method implementations for `JiraClient`.
//
// Each submodule defines an `impl JiraClient { … }` block grouping methods
// by JIRA REST resource. The submodules contribute methods only — the
// `JiraClient` type itself lives in `super::client`.

pub mod fields;
pub mod issues;
pub mod sprints;
