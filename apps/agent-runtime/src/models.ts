/**
 * OpenRouter identifica i Claude con i punti (`anthropic/claude-opus-4.8`),
 * l'API Anthropic con i trattini (`claude-opus-4-8`). Il Claude Agent SDK
 * vuole la seconda forma.
 *
 * Duplicato voluto rispetto al server: il runtime deve poter girare da solo,
 * senza dipendere dal processo API.
 */
export function toAnthropicModelId(catalogId: string): { model: string; fast: boolean } {
  let id = catalogId.startsWith('anthropic/')
    ? catalogId.slice('anthropic/'.length)
    : catalogId;
  const fast = id.endsWith('-fast');
  if (fast) id = id.slice(0, -'-fast'.length);
  id = id.replace(/\./g, '-');
  return { model: id, fast };
}
