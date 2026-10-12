import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
export interface TeachingRegion { id: string; title: string; elementIds: string[];regionId?:string;kind?:'main'|'detail';parentId?:string }
export function teachingRegions(elements: readonly ExcalidrawElement[]): TeachingRegion[];
export function teachingKey(event: KeyboardEvent, editing?: boolean): 'next' | 'previous' | 'overview' | null;
