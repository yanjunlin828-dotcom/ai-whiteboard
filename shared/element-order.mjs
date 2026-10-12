import {generateNKeysBetween} from 'fractional-indexing';
// Append after the existing stack so native normalization does not create a
// second save/history entry. Existing user elements keep their ordering bytes.
export function orderAppended(existing,added){
  const last=existing.map(e=>e.index).filter(x=>typeof x==='string').sort().at(-1)??null;
  const keys=generateNKeysBetween(last,null,added.length);
  for(let i=0;i<added.length;i++)added[i].index=keys[i];
  return added;
}
