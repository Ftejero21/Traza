import { Injectable, Pipe, PipeTransform } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { WORKSPACE_CODE_I18N_EN } from './workspace-code-i18n.en';
import { WORKSPACE_CODE_I18N_ES } from './workspace-code-i18n.es';

/** Idiomas de la vista de flujo (en chatFront viene de la configuración del editor). */
export type WorkspaceCodeLanguage = 'es' | 'en';

export type WorkspaceCodeI18nParams = Record<string, string | number | null | undefined>;

const DICTIONARIES: Record<WorkspaceCodeLanguage, Record<string, string>> = {
  es: WORKSPACE_CODE_I18N_ES,
  en: WORKSPACE_CODE_I18N_EN,
};

/**
 * Traducciones de la vista de flujo (copia adaptada de chatFront). El idioma lo fija el host (`init`/`config`)
 * y cambia en caliente.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceCodeI18nService {
  readonly language$ = new BehaviorSubject<WorkspaceCodeLanguage>('es');

  get language(): WorkspaceCodeLanguage {
    return this.language$.value;
  }

  setLanguage(language: WorkspaceCodeLanguage): void {
    const next: WorkspaceCodeLanguage = language === 'en' ? 'en' : 'es';
    if (next !== this.language$.value) this.language$.next(next);
  }

  /** Locale para fechas y números del idioma activo. */
  get locale(): string {
    return this.language === 'en' ? 'en-GB' : 'es-ES';
  }

  /** Texto traducido; con `{param}` sustituidos. Si falta en el idioma activo se usa el español. */
  t(key: string, params?: WorkspaceCodeI18nParams): string {
    const text = DICTIONARIES[this.language][key] ?? WORKSPACE_CODE_I18N_ES[key] ?? key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name: string) => (params[name] === undefined || params[name] === null ? match : String(params[name])));
  }

  /** Igual que `t`, pero devuelve `null` si la clave no existe (etiquetas opcionales). */
  maybe(key: string, params?: WorkspaceCodeI18nParams): string | null {
    return key in WORKSPACE_CODE_I18N_ES || key in DICTIONARIES[this.language] ? this.t(key, params) : null;
  }

  /** Plural sencillo: `key.one` / `key.other`. */
  plural(key: string, count: number, params?: WorkspaceCodeI18nParams): string {
    return this.t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...params });
  }
}

/** `{{ 'menu.file' | wcT }}` · se reevalúa al cambiar de idioma (pipe impuro con caché). */
@Pipe({ name: 'wcT', pure: false })
export class WorkspaceCodeI18nPipe implements PipeTransform {
  private lastKey = '';
  private lastParams = '';
  private lastLanguage = '';
  private lastValue = '';

  constructor(private i18n: WorkspaceCodeI18nService) {}

  transform(key: string, params?: WorkspaceCodeI18nParams): string {
    const serialized = params ? JSON.stringify(params) : '';
    if (key === this.lastKey && serialized === this.lastParams && this.i18n.language === this.lastLanguage) return this.lastValue;
    this.lastKey = key;
    this.lastParams = serialized;
    this.lastLanguage = this.i18n.language;
    this.lastValue = this.i18n.t(key, params);
    return this.lastValue;
  }
}
