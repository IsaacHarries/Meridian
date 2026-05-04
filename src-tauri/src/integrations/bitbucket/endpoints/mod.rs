// Endpoint impl blocks for `BitbucketClient`, grouped by Bitbucket resource.
// These modules contribute methods to `BitbucketClient` via additional
// `impl` blocks; they don't expose new public symbols of their own.

mod comments;
mod prs;
mod tasks;
