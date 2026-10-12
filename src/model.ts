import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';

export interface Scene {
  elements: readonly ExcalidrawElement[];
  appState: Pick<AppState, 'viewBackgroundColor' | 'gridSize' | 'gridModeEnabled' | 'theme' | 'currentItemFontFamily'>;
  files: BinaryFiles;
}
export interface Board {
  schemaVersion: 1; boardId: string; revision: number; title: string; scene: Scene;
  savedAt: string | null; requestId: string | null; archived?: boolean;
}
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    }
    return item;
  });
}
export function captureScene(elements: readonly ExcalidrawElement[], app: AppState, files: BinaryFiles): Scene {
  return { elements, appState: {
    viewBackgroundColor: app.viewBackgroundColor,
    gridSize: app.gridSize, gridModeEnabled: app.gridModeEnabled,
    theme: app.theme, currentItemFontFamily: app.currentItemFontFamily,
  }, files };
}
export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
