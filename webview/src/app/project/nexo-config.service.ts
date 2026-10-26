import { Injectable } from '@angular/core';
import type { NexoTheme } from '../bridge/protocol';

/** Configuración que envía el host (`init`/`config`): idioma, nombre del modelo de VS Code configurado y apariencia. */
@Injectable({ providedIn: 'root' })
export class NexoConfigService {
  /** Nombre del modelo configurado en `nexo.model` (`null` = se elige al usarlo). */
  modelName: string | null = null;

  /** Apariencia activa (`nexo.theme`); se refleja en `data-nexo-theme` de `<html>`. */
  theme: NexoTheme = 'nexo';

  setModelName(value: unknown): void {
    const name = typeof value === 'string' ? value.trim().slice(0, 120) : '';
    this.modelName = name || null;
  }

  setTheme(value: unknown): void {
    this.theme = value === 'vscode' ? 'vscode' : 'nexo';
    document.documentElement.setAttribute('data-nexo-theme', this.theme);
  }
}
