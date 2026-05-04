// Bitbucket REST API client. Split into submodules:
//   - `types`     — public output types (PRs, comments, tasks, users)
//   - `client`    — `BitbucketClient` struct + shared HTTP plumbing
//   - `parsing`   — JSON → typed-struct helpers
//   - `endpoints` — additional `impl BitbucketClient` blocks per resource
//
// The public API is preserved at `crate::integrations::bitbucket::*` via
// the re-exports below.

mod client;
mod endpoints;
mod parsing;
mod types;

pub use client::BitbucketClient;
pub use types::{
    BitbucketComment, BitbucketInlineContext, BitbucketPr, BitbucketReviewer, BitbucketTask,
    BitbucketUser,
};
