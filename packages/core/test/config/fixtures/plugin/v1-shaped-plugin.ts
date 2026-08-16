// V1-shaped plugin: default export is a factory function, not { id, effect/setup }.
// The V2 directory glob picks this up too; it must be quietly skipped (the
// legacy V1 loader owns it) instead of logging a decode error per boot.
export default async function v1Plugin() {
  return {}
}
