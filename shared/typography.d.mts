export const NOTE_HAND:10;
export const NOTE_MATH:11;
export function isFormula(text:string):boolean;
export function noteFont(text:string):10|11;
export function isNoteFont(family:number):boolean;
export function editedNoteFont(family:number,text:string):number;
export function noteTokens(line:string):string[];
