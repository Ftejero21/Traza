/**
 * Reproductor del flujo de Nexo IA: paso actual, reproducción, velocidad y límite. Clase pura (sin Angular) con
 * temporizadores inyectables para poder probarla con `fakeAsync`/`tick`.
 *
 * - Recorrido (`runWalk`): avanza cada 2800/velocidad ms y se para en el último paso.
 * - Simular / Logs (`runTo`): reinicia en el paso 0, avanza cada 1500/velocidad ms hasta el paso objetivo, se para ahí
 *   y, 900/velocidad ms después, llama a `onArrive` (el resultado solo aparece al llegar).
 */
export interface FlowPlayerTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const WALK_MS = 2800;
const RUN_MS = 1500;
const ARRIVE_MS = 900;

const defaultTimers: FlowPlayerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class WorkspaceCodeFlowPlayer {
  step = 0;
  playing = false;
  speed: 0.5 | 1 | 2 = 1;
  /** Índice máximo hasta el que avanza la reproducción. */
  limit = 0;
  resultVisible = false;
  total = 0;
  /** Origen del último cambio de paso: la reproducción (`auto`) o el usuario (`manual`). */
  lastChange: 'auto' | 'manual' = 'manual';
  /** Paradas: índices del flujo por los que se mueve el reproductor (`null` = todos los pasos). */
  stops: number[] | null = null;

  private kind: 'walk' | 'run' = 'walk';
  private tick: unknown = null;
  private arriveTimer: unknown = null;
  private target: number | null = null;
  private onArrive: (() => void) | null = null;
  private arrived = false;

  constructor(private onChange: () => void, private timers: FlowPlayerTimers = defaultTimers) {}

  /** Modo Recorrido: `total` pasos, sin objetivo; no arranca solo. */
  runWalk(total: number): void {
    this.stopTimers();
    this.stops = null;
    this.kind = 'walk';
    this.total = Math.max(0, total);
    this.limit = Math.max(0, this.total - 1);
    this.target = null;
    this.onArrive = null;
    this.arrived = false;
    this.resultVisible = false;
    this.playing = false;
    this.step = Math.min(this.step, this.limit);
    this.onChange();
  }

  /** Simular / Logs: reproduce desde el paso 0 hasta `targetIndex` y, al llegar, muestra el resultado. */
  runTo(targetIndex: number, onArrive: () => void, total = this.total): void {
    this.stopTimers();
    this.stops = null;
    this.kind = 'run';
    this.total = Math.max(0, total);
    this.limit = Math.min(Math.max(0, targetIndex), Math.max(0, this.total - 1));
    this.target = this.limit;
    this.onArrive = onArrive;
    this.arrived = false;
    this.resultVisible = false;
    this.step = 0;
    this.lastChange = 'auto';
    if (this.step >= this.target) {
      this.playing = false;
      this.scheduleArrival();
    } else {
      this.playing = true;
      this.schedule();
    }
    this.onChange();
  }

  /** Muestra el resultado sin animación (p. ej. `none` sin pasos vistos). */
  showResultNow(onArrive: () => void): void {
    this.stopTimers();
    this.playing = false;
    this.target = null;
    this.onArrive = null;
    this.arrived = true;
    this.resultVisible = true;
    onArrive();
    this.onChange();
  }

  play(): void {
    if (this.playing || this.total <= 0) return;
    // Al final del recorrido, reproducir vuelve a empezar.
    if (this.step >= this.limit) {
      if (this.kind === 'run' && this.target !== null && !this.arrived) {
        this.scheduleArrival();
        return;
      }
      this.step = this.stops?.[0] ?? 0;
    }
    this.playing = true;
    this.schedule();
    this.onChange();
  }

  /** Pausa. Si el resultado estaba a punto de mostrarse, se muestra ya (no se pierde al ocultar la página). */
  pause(): void {
    const pendingArrival = this.arriveTimer !== null;
    this.stopTimers();
    const wasPlaying = this.playing;
    this.playing = false;
    if (pendingArrival) this.arrive();
    else if (wasPlaying) this.onChange();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  next(): void {
    this.select(this.step + 1);
  }

  prev(): void {
    this.select(this.step - 1);
  }

  goTo(index: number): void {
    this.select(index);
  }

  /** Selección manual: pausa, cancela cualquier temporizador pendiente y fija el paso. */
  select(index: number): void {
    if (this.total <= 0) return;
    let step = Math.min(Math.max(0, index), this.total - 1);
    const stops = this.stops;
    if (stops && !stops.includes(step)) {
      if (step >= this.step) step = stops.find((s) => s >= step) ?? stops[stops.length - 1];
      else step = [...stops].reverse().find((s) => s <= step) ?? stops[0];
    }
    this.stopTimers();
    this.playing = false;
    this.lastChange = 'manual';
    this.step = step;
    if (this.kind === 'run' && this.target !== null && !this.arrived && step >= this.target) this.scheduleArrival();
    this.onChange();
  }

  /** Vuelve al paso 0 y olvida el resultado y el objetivo. */
  reset(): void {
    this.stopTimers();
    this.stops = null;
    this.playing = false;
    this.lastChange = 'manual';
    this.step = 0;
    this.kind = 'walk';
    this.limit = Math.max(0, this.total - 1);
    this.target = null;
    this.onArrive = null;
    this.arrived = false;
    this.resultVisible = false;
    this.onChange();
  }

  /**
   * Limita el reproductor a `stops` (índices del flujo). Con `null` o lista vacía vuelve a recorrer todos los pasos.
   * Si el paso actual no es una parada, salta a la primera parada posterior (o a la última).
   */
  setStops(stops: number[] | null): void {
    this.stopTimers();
    this.playing = false;
    this.kind = 'walk';
    this.target = null;
    this.lastChange = 'manual';
    const max = this.total - 1;
    const list = stops
      ? Array.from(new Set(stops.filter((s) => Number.isInteger(s) && s >= 0 && s <= max))).sort((a, b) => a - b)
      : [];
    this.stops = list.length ? list : null;
    this.limit = this.stops ? this.stops[this.stops.length - 1] : Math.max(0, this.total - 1);
    if (this.stops && !this.stops.includes(this.step)) {
      this.step = this.stops.find((s) => s >= this.step) ?? this.stops[this.stops.length - 1];
    }
    this.onChange();
  }

  /** Posición del paso actual dentro de las paradas (o el propio paso si no hay paradas). */
  get position(): number {
    return this.stops ? this.stops.indexOf(this.step) : this.step;
  }

  /** Número de pasos recorribles. */
  get count(): number {
    return this.stops ? this.stops.length : this.total;
  }

  get atStart(): boolean {
    return this.step <= (this.stops?.[0] ?? 0);
  }

  get atEnd(): boolean {
    return this.step >= (this.stops ? this.stops[this.stops.length - 1] : this.total - 1);
  }

  setSpeed(speed: 0.5 | 1 | 2): void {
    if (this.speed === speed) return;
    this.speed = speed;
    if (this.playing) {
      this.clearTick();
      this.schedule();
    }
    this.onChange();
  }

  dispose(): void {
    this.stopTimers();
    this.playing = false;
    this.onArrive = null;
  }

  private schedule(): void {
    this.clearTick();
    const ms = (this.kind === 'walk' ? WALK_MS : RUN_MS) / this.speed;
    this.tick = this.timers.set(() => {
      this.tick = null;
      if (!this.playing) return;
      this.lastChange = 'auto';
      if (this.step < this.limit) {
        const stops = this.stops;
        this.step = stops ? stops.find((s) => s > this.step) ?? this.limit : this.step + 1;
      }
      if (this.step >= this.limit) {
        this.playing = false;
        if (this.kind === 'run' && this.target !== null && !this.arrived) this.scheduleArrival();
        this.onChange();
        return;
      }
      this.onChange();
      this.schedule();
    }, ms);
  }

  private scheduleArrival(): void {
    if (this.arriveTimer !== null) return;
    this.arriveTimer = this.timers.set(() => {
      this.arriveTimer = null;
      this.arrive();
    }, ARRIVE_MS / this.speed);
  }

  private arrive(): void {
    if (this.arrived) return;
    this.arrived = true;
    this.resultVisible = true;
    const callback = this.onArrive;
    if (callback) callback();
    this.onChange();
  }

  private clearTick(): void {
    if (this.tick !== null) this.timers.clear(this.tick);
    this.tick = null;
  }

  private stopTimers(): void {
    this.clearTick();
    if (this.arriveTimer !== null) this.timers.clear(this.arriveTimer);
    this.arriveTimer = null;
  }
}
