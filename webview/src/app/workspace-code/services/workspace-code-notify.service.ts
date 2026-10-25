import { Injectable } from '@angular/core';
import { NexoBridge } from '../../bridge/nexo-bridge';

/** Avisos: en VS Code los muestra el host (`showInformationMessage`…); en el navegador, el toast de `AppComponent`. */
@Injectable({ providedIn: 'root' })
export class WorkspaceCodeNotifyService {
  constructor(private bridge: NexoBridge) {}

  show(text: string, tone: 'success' | 'warning' | 'danger' | 'info' = 'info'): void {
    this.bridge.post({ type: 'notify', level: tone, text: String(text ?? '').slice(0, 500) });
  }
}
