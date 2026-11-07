# Slack notifications

Notifications belong to Software Factory, never to the execution Harness. They
are optional and disabled by default. Configure one Slack bot connection using
the target repository Actions secret `SLACK_BOT_TOKEN` and pass it to the SF Action
as `slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}`. It is supplied only to trusted
manager/notify execution, never to Codex, repository code, or the planner.

## Slack app setup

Create a Slack app, add **Bot Token Scope `chat:write`**, install it in the desired
workspace, and invite the bot to the destination channel. No User Token Scopes,
history access, or channel-listing scopes are needed. Store the Bot User OAuth
Token as the Actions secret, never in YAML. Prefer the channel ID from Slack's
channel details; a `#channel-name` is also accepted by configuration.

```yaml
notifications:
  slack:
    enabled: true
    channel: C0CGJKK3EKS
    maxPerRun: 20
    since: '2026-11-07T00:00:00Z' # Optional UTC cutoff; null includes earlier provable SF events.
    events:
      issue_created:
        enabled: true
        channel: null # Optional override; null inherits the default channel.
      pr_merged:
        enabled: true
        channel: null
        actors: [] # Optional further restriction, e.g. ['github-actions[bot]'].
```

Each event can be enabled independently and routed to a different channel. Bot
authentication comes from the secret; arbitrary API endpoints and tokens in the
project config are deliberately unsupported. Unknown event names fail validation.
Changing notification settings does not invalidate task approvals or active worker
authorization. Existing installations continue with notifications disabled.

## What triggers a message

- `issue_created`: a follow-up actually created by the SF bot, correlated with a
  mandatory trusted creation intent on the parent Issue. No notifications for
  plans, dry runs, denied actions, manually created Issues, or historical Issues
  without SF provenance. The intent is written before creation, independently of
  optional decision audit, so ambiguous creation can be recovered on later runs.
- `pr_merged`: a native GitHub merge of a PR produced by the SF coding publisher,
  correlated with its execution branch and trusted persisted result URL. GitHub
  must identify the merging actor as **Bot**; human merges never match, even if
  the PR was written by AI. `actors` can narrow that bot set. This does not enable
  PR merging. The optional dedicated AI-reviewed merge workflow is configured separately.

Messages contain the event, title, GitHub link, and actor; no issue body or LLM
transcript. Untrusted titles use Slack plain-text blocks with mention parsing and
link previews disabled.

The updated wrapper invokes `notify` for default-branch pushes, so ordinary
merge pushes are observed without invoking the planner or changing task state.
It shares manager concurrency. Normal manager runs also reconcile notifications,
including closed managed Issues, and immediately check after creating follow-ups.
GitHub may suppress pushes made with `GITHUB_TOKEN`; scheduled reconciliation is
the fallback. Deploy the updated wrapper when upgrading, not only the Action pin.
The manual workflow mode `notify` runs just notification reconciliation.
Use mode `check-slack` to validate the bot connection through Slack's `auth.test`
without posting a test message. This checks authentication, not channel membership
or successful message delivery, and requires no additional scopes.

## Delivery and recovery

Confirmed sends store a trusted `notification_sent` journal receipt on the parent
Issue. Repeated runs skip the same repository/event/object/channel delivery, even
when decision audit is disabled. Changing a channel deliberately creates a new
delivery destination; use `since` to prevent unwanted historical delivery.

Slack failures are reported without provider bodies or credentials. They do not
undo or repeat successful repository actions. No receipt is written for a failed
or unconfirmed send; later runs retry it. Requests have a 10-second timeout and
are paced at least 1.1 seconds apart, with at most `maxPerRun` attempts; remaining
events are processed on later runs. There is no immediate transport retry after
an ambiguous timeout or HTTP error. Advisory, dry-run, global disable, and the
notification kill switch never send or write notification receipts.

Delivery is **at least once**, not a cross-service transaction: if Slack accepts a
message and the response or GitHub receipt write is lost, a later retry can duplicate
that message. Ordinary repeated manager runs with persisted receipts do not spam.

Slack API references: https://docs.slack.dev/reference/methods/chat.postMessage/
and https://docs.slack.dev/apis/web-api/rate-limits/.
