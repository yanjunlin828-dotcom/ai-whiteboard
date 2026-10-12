import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
export type EditOperation = { op: 'set_text'; target: string; text: string } | { op: 'move'; target: string; dx: number; dy: number } | { op: 'connect'; id: string; from: string; to: string; color?: string };
export interface EditInput { requestId: string; edits?: EditOperation[]; selectionIds?: string[] }
export interface TextLayout { text: string; width: number; height: number }
export class EditError extends Error { code: string; status: number }
export function resolveEdits(elements: readonly ExcalidrawElement[], input: EditInput, selectedIds?: string[]): EditOperation[];
export function textWidthLimit(text: ExcalidrawElement, elements: readonly ExcalidrawElement[]): number;
export function applyEdits(elements: readonly ExcalidrawElement[], input: EditInput, selectedIds: string[], layouts?: Record<string, TextLayout>, arrowTemplates?: readonly ExcalidrawElement[]): { elements: ExcalidrawElement[]; affectedIds: string[]; createdIds: string[] };
