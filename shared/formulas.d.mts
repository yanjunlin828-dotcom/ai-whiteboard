import type {ExcalidrawElement} from '@excalidraw/excalidraw/element/types';
import type {BinaryFiles,BinaryFileData} from '@excalidraw/excalidraw/types';
export interface FormulaInput {latex:string;fontSize?:number;color?:string}
export interface FormulaRender {latex:string;fontSize:number;color:string;width:number;height:number;file:BinaryFileData}
export function formulaSource(text:unknown):string|null;
export function isFormulaPatch(input:unknown,elements:readonly ExcalidrawElement[]):boolean;
export function formulaElement(old:ExcalidrawElement|null,rendered:FormulaRender,id?:string,x?:number,y?:number):ExcalidrawElement;
export function planFormulaPatch(scene:{elements:readonly ExcalidrawElement[];files:BinaryFiles},input:unknown,selectedIds:string[],render:(input:FormulaInput)=>Promise<FormulaRender>):Promise<{elements:ExcalidrawElement[];files:BinaryFiles;affectedIds:string[];createdIds:string[]}>;
