import { Injectable } from '@angular/core';

/** Configuración que envía el host (`init`/`config`): idioma y nombre del modelo de VS Code configurado. */
@Injectable({ providedIn: 'root' })
export class NexoConfigService {
  /** Nombre del modelo configurado en `nexo.model` (`null` = se elige al usarlo). */
  modelName: string | null = null;

  setModelName(value: unknown): void {
    const name = typeof value === 'string' ? value.trim().slice(0, 120) : '';
    this.modelName = name || null;
  }
}
