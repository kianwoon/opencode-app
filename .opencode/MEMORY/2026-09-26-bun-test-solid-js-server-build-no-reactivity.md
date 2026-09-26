# bun test resolves solid-js to the non-reactive server build — store reactivity is untestable headlessly

Symptom: `bun test` in packages/app — Solid `createMemo`s compute exactly once and never re-run; store writes land (data reads back correct) but no memo invalidates. Any test conclusion about signals, reconcile signaling, or subscription behavior measured this way is INVALID (cost here: two fix attempts built on a phantom).

Cause: bun's `node` export condition resolves solid-js@1.9.10 to `dist/server.cjs` — the non-reactive SSR build. `createStore` returns plain objects; there is no reactive graph.

Lesson: in this repo, NO bun test can observe Solid store/signal reactivity. Headless tests of reducers stay valid for DATA assertions (write → read back) but never for reactivity; verify store/signal behavior in the browser only (dev server :4444).

Acceptance gate: `bun -e 'require.resolve("solid-js")'` run FROM packages/app prints `.../solid-js/dist/server.cjs` — that resolution is the tell; if it ever resolves to a client build, revisit this lesson.
