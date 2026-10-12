import type {ExcalidrawElement} from '@excalidraw/excalidraw/element/types';
export function orderAppended<T extends ExcalidrawElement>(existing:readonly ExcalidrawElement[],added:T[]):T[];
