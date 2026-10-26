import * as vscode from 'vscode';
import { trazaLog } from './host-ai';

/**
 * Migración única de los ajustes de la versión anterior («Nexo Flujo», sección `nexo`) a `traza`. Copia solo valores
 * válidos y nunca sobrescribe un `traza.*` ya definido; los `nexo.*` quedan sin tocar. No escribe valores en el log
 * (solo la clave y el ámbito). Los secretos (SecretStorage) no se migran: están aislados por id de extensión.
 * Los ajustes de ámbito WorkspaceFolder no se migran: todos son de ámbito window.
 */

const KEYS = ['model', 'language', 'databases', 'theme', 'copilotInstructions'] as const;
type Key = (typeof KEYS)[number];

const GLOBAL_FLAG = 'traza.legacyMigrated';

/** Valor ya validado (y mapeado) para `traza.<key>`; `undefined` si no es válido. */
function validated(key: Key, value: unknown): unknown {
  switch (key) {
    case 'model': return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    case 'language': return value === 'es' || value === 'en' ? value : undefined;
    case 'databases': return Array.isArray(value) ? value : undefined;
    case 'copilotInstructions': return typeof value === 'boolean' ? value : undefined;
    case 'theme': return value === 'vscode' ? 'vscode' : value === 'nexo' || value === 'traza' ? 'traza' : undefined;
  }
}

async function migrateScope(scope: 'globalValue' | 'workspaceValue', target: vscode.ConfigurationTarget, label: string): Promise<boolean> {
  const log = trazaLog();
  let ok = true;
  for (const key of KEYS) {
    try {
      const legacy = vscode.workspace.getConfiguration('nexo').inspect<unknown>(key);
      const current = vscode.workspace.getConfiguration('traza').inspect<unknown>(key);
      if (!legacy || !current) continue;
      const legacyValue = legacy[scope];
      if (current[scope] !== undefined || legacyValue === undefined) continue;
      const mapped = validated(key, legacyValue);
      if (mapped === undefined) {
        log.warn(`Ajuste nexo.${key} (${label}) con un valor no válido: no se copia`);
        continue;
      }
      await vscode.workspace.getConfiguration('traza').update(key, mapped, target);
      log.info(`Ajuste nexo.${key} copiado a traza.${key} (${label})`);
    } catch (error: unknown) {
      ok = false;
      log.warn(`No se pudo migrar nexo.${key}`, error instanceof Error ? error.name : '');
    }
  }
  return ok;
}

export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
  try {
    if (!context.globalState.get<boolean>(GLOBAL_FLAG)) {
      if (await migrateScope('globalValue', vscode.ConfigurationTarget.Global, 'Usuario')) {
        await context.globalState.update(GLOBAL_FLAG, true);
      }
    }
    if (vscode.workspace.workspaceFolders?.length && !context.workspaceState.get<boolean>(GLOBAL_FLAG)) {
      if (await migrateScope('workspaceValue', vscode.ConfigurationTarget.Workspace, 'Workspace')) {
        await context.workspaceState.update(GLOBAL_FLAG, true);
      }
    }
  } catch (error: unknown) {
    trazaLog().warn('No se pudo migrar los ajustes de Nexo', error instanceof Error ? error.name : '');
  }
}
