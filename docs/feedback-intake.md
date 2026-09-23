# Unified feedback intake

Agents Relay exposes a product-neutral feedback contract in `src/feedback.ts`. Product surfaces should validate and sanitize the submission before calling `createFeedbackRecord`, then call `materializeFeedback` to persist the durable JSON artifact. The artifact is the durable feedback record; it is not a GitHub PR and does not automatically create a Job or Task.

## Contract

The record uses `agents-relay.feedback/v1` and separates `userContent`, `attachments`, `provenance`, `systemMetadata`, `triage`, and `downstream`. Product adapters must populate `provenance.source`, `product`, `actorClass`, and `submittedAt`; surface, setup step, version, and build are optional. Contact information is optional and must only be passed when the user explicitly supplied it.

Attachments are first-class metadata records. Each has an opaque stable `reference`, MIME type, byte size, optional SHA-256, and optional dimensions. The binary is stored by the product or private object store, never in the marker or JSON as base64. Only PNG, JPEG, WebP, and GIF are accepted, with at most 10 attachments and 10 MiB per attachment. Upload failure rejects the submission; it must not create a partial feedback record.

The reference must not contain query strings, fragments, embedded credentials, or provider tokens. Product surfaces should warn users not to upload secrets, tokens, credentials, private provider IDs, child transcripts, or other sensitive data. Use `sanitize: true` or `submission.sanitized: true` after product-specific redaction before public visibility. Public records require explicit sanitization; private is the default.

`renderFeedbackMarkdown` is a safe human-readable materialization. Its machine-readable marker contains only schema, provenance, attachment IDs, triage, and downstream references; it does not embed binary data. `feedbackWorkProvenance(record)` is the small provenance envelope to copy into a later Task, Job, Issue, PR, or change record so the evidence chain remains `feedback -> triage -> work`.

Adapters should deduplicate using `feedbackFingerprint(record)` and treat malformed input, unsupported images, oversized uploads, and storage errors as rejected submissions with no durable artifact. Triage updates the record's `triage` field and appends only references to `downstream.work`; it should never copy raw private screenshots into a public GitHub surface.
