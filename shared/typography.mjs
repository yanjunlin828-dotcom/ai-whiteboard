export const NOTE_HAND=10;
export const NOTE_MATH=11;
export function isFormula(text) {
  // Arrows and numbers alone do not make a label a formula.
  return /[=≠≈≤≥∑∏∫∇∂]|[A-Za-zα-ωΑ-Ω][₀-₉⁰-⁹]|[A-Za-zα-ωΑ-Ω][_^][{\wα-ω]|\\(?:frac|sum|int|sqrt|alpha|theta)\b/u.test(text);
}
export function noteFont(text) {return isFormula(text)?NOTE_MATH:NOTE_HAND;}
export function isNoteFont(family) {return family===5||family===NOTE_HAND||family===NOTE_MATH;}
export function editedNoteFont(family,text) {return family===NOTE_HAND||family===NOTE_MATH?noteFont(text):family;}
export function noteTokens(line){
  const tokens=line.match(/[+\-−]?[A-Za-z0-9α-ωΑ-Ω_⁰-₿.]+|\s+|./gu)??[],result=[];
  for(const token of tokens){if(/^[，。；：！？、,.!?;:%）)\]】》]$/u.test(token)&&result.length&&!/^\s+$/u.test(result.at(-1)))result[result.length-1]+=token;else result.push(token);}
  return result;
}
