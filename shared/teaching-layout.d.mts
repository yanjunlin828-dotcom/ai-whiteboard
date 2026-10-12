import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
export function teachingHierarchyPlan(elements: readonly ExcalidrawElement[]): {elements: ExcalidrawElement[]; guides: Parameters<typeof convertToExcalidrawElements>[0]; mainIds:string[]; detailIds:string[]} | null;
export function enlargeTeachingDetails(elements: readonly ExcalidrawElement[]): {elements: readonly ExcalidrawElement[]; detailIds:string[]} | null;
