//! JIRA REST API client.
//!
//! Split across submodules:
//! - `types`     — output structs (`JiraSprint`, `JiraIssue`, …) + `CustomFieldConfig`
//! - `client`    — the `JiraClient` HTTP wrapper (auth, error mapping, raw GETs)
//! - `adf`       — Atlassian Document Format → markdown / plain-text rendering
//! - `parsing`   — JSON → struct converters used across endpoints
//! - `endpoints` — per-resource `impl JiraClient` method blocks (sprints, issues, fields)
//!
//! The public API is re-exported below so existing callers continue to use
//! `crate::integrations::jira::Foo` paths unchanged.

mod adf;
mod client;
mod endpoints;
mod parsing;
mod types;

pub use client::JiraClient;
pub use types::{
    CustomFieldConfig, DescriptionSection, JiraFieldMeta, JiraIssue, JiraSprint, JiraUser,
    RawIssueField,
};
