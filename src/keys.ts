// Model identity helpers shared by stats and view layers.

export type ModelIdent = { providerID: string; id: string; variant?: string }

/** Canonical grouping key for a model reference (no `modelID` field exists). */
export function modelKey(model: ModelIdent): string {
  const base = `${model.providerID}/${model.id}`
  return model.variant ? `${base}@${model.variant}` : base
}
