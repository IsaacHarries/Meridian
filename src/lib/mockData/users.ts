import { type BitbucketUser } from "@/lib/tauri/bitbucket";
import { type JiraUser } from "@/lib/tauri/jira";

// ── Users ─────────────────────────────────────────────────────────────────────
export const ME: JiraUser = {
  accountId: "user-1",
  displayName: "Isaac Chen",
  emailAddress: "isaac@example.com",
};

export const ALICE: JiraUser = {
  accountId: "user-2",
  displayName: "Alice Park",
  emailAddress: "alice@example.com",
};

export const BOB: JiraUser = {
  accountId: "user-3",
  displayName: "Bob Reyes",
  emailAddress: "bob@example.com",
};

export const CAROL: JiraUser = {
  accountId: "user-4",
  displayName: "Carol Nguyen",
  emailAddress: "carol@example.com",
};

export const DAN: JiraUser = {
  accountId: "user-5",
  displayName: "Dan Kowalski",
  emailAddress: "dan@example.com",
};

// Sprint 24 — Platform Reliability team (separate from sprint 23 team)
export const EVE: JiraUser = {
  accountId: "user-6",
  displayName: "Eve Lambert",
  emailAddress: "eve@example.com",
};

export const FRANK: JiraUser = {
  accountId: "user-7",
  displayName: "Frank Torres",
  emailAddress: "frank@example.com",
};

export const GRACE: JiraUser = {
  accountId: "user-8",
  displayName: "Grace Kim",
  emailAddress: "grace@example.com",
};

export const HENRY: JiraUser = {
  accountId: "user-9",
  displayName: "Henry Walsh",
  emailAddress: "henry@example.com",
};

// ── Bitbucket users ───────────────────────────────────────────────────────────

export const makeBbUser = (displayName: string, nickname: string): BitbucketUser => ({
  displayName,
  nickname,
  accountId: null,
});

export const BB_ME = makeBbUser("Isaac Chen", "isaac.chen");
export const BB_ALICE = makeBbUser("Alice Park", "alice.park");
export const BB_BOB = makeBbUser("Bob Reyes", "bob.reyes");
export const BB_CAROL = makeBbUser("Carol Nguyen", "carol.nguyen");
