import type {ExcalidrawElement,ExcalidrawTextElement} from '@excalidraw/excalidraw/element/types';
export function teachingDensityPlan(elements:readonly ExcalidrawElement[],measure:(element:ExcalidrawTextElement,size:number,width:number)=>{text:string;width:number;height:number}):{elements:ExcalidrawElement[];affectedIds:string[]}|null;
