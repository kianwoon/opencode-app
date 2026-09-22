# Plugin append to output.messages mutates PERSISTED history

- **Date**: 2026-09-22T09:48:40+0800
- **Type**: lesson

## What happened

Appending a synthetic part to output.messages in experimental.chat.messages.transform looks like a transient tail, but that array holds the PERSISTED message objects. Result: 95 JEV advisory parts and 6456 synthetic parts landed in the DB, and a message whose bytes keep changing pins the provider cached prefix (cache.read plateaued at ~683520 while input grew to ~44732, hit rate decaying toward the gate).

## Root cause / fix

Clone-and-replace the array slot instead of mutating: messages[index] = { ...last, parts: [...last.parts, part] }. Then PROVE transience before trusting any tail delivery: count persisted artifacts for the tag across two turns and require ZERO growth.
