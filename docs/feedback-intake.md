# Unified feedback intake

Agents Relay provides a product-neutral feedback record through `src/feedback.ts`.
Product adapters submit a `FeedbackSubmission` to `materializeFeedback(root, submission)` or `FileFeedbackStore.submit()` after showing their own privacy warning and applying any product-specific redaction.

The materializer writes one JSON record under `records/<feedback-id>.json` and binary uploads under `attachments/<feedback-id>/`. The JSON record contains the stable attachment reference, media type, byte count, SHA-256 digest, and sanitized filename; it never contains base64 or upload/browser/provider metadata. `readFeedbackAttachment()` verifies the reference stays inside the configured root and checks size and digest before downstream agents or reviewers consume it.

The machine-readable marker is `agents-relay:feedback:v1`. It contains system provenance, attachment references, triage state, and downstream Job/Task/PR/Issue references. User text remains a separate `userContent.text` field. `renderFeedbackMarker()` is suitable for safe comments or issue bodies only after the product has decided that the record is safe for that visibility; raw screenshots are never automatically published.

Allowed uploads are PNG, JPEG, WebP, and GIF, up to five attachments and 10 MiB per attachment by default. Limits can be narrowed per product. Invalid or oversized submissions fail before a record is written. An optional idempotency key makes retries return the existing record rather than creating duplicates. Products should rate-limit at their public boundary and may mark later records as `duplicate` during triage.

`systemProvenance` is deliberately allow-listed: source, product, surface, setup step, actor class, version/build, submitted timestamp, and explicitly supplied contact. Child transcripts, secrets, tokens, provider IDs, credentials, and arbitrary upload metadata are not part of the contract. A downstream triage adapter should append a `downstream` reference when it creates a Relay Task or Job, preserving the feedback ID and attachment references as evidence.
