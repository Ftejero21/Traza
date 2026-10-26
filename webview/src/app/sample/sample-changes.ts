import { ChangeCompareResponse } from '../workspace-code/ai/nexo-ia.changes.types';
import { P, SAMPLE_FILES, SAMPLE_FLOW, lineOf } from './sample-project';
import { simulatePreset } from './sample-results';

/*
 * Propuesta de cambio del ejemplo (modo navegador y «Traza: Abrir flujo de ejemplo»): el login responde lo mismo cuando
 * el email no existe que cuando la contraseña no coincide. Las líneas del diff salen del archivo virtual real.
 */

const FIND_ANCHOR = 'Usuario usuario = usuarioRepository.findByEmail(email)';
const THROW_ANCHOR = '.orElseThrow(() -> new FreeSocialException("error.usuarioNoEncontrado"));';
const MATCH_ANCHOR = 'if (!passwordEncoder.matches(';

function lineText(anchor: string): string {
  return SAMPLE_FILES[P.service].split('\n')[lineOf(P.service, anchor) - 1];
}

const START = lineOf(P.service, FIND_ANCHOR);
const THROW_LINE = lineText(THROW_ANCHOR);

export const SAMPLE_PROPOSALS: unknown[] = [
  {
    id: 'sample-change-login',
    flowId: SAMPLE_FLOW.id,
    request: 'Que el login no revele si un email está registrado.',
    title: 'Mismo error para email inexistente',
    summary: 'authenticate() lanza «error.login» también cuando no existe el email, así el usuario ve el mismo aviso que con una contraseña incorrecta.',
    risks: ['El frontend deja de distinguir el 404 del 401 en el login.'],
    files: [
      {
        mountId: '',
        path: P.service,
        status: 'modified',
        note: 'no revelar emails',
        hunks: [
          {
            header: '@@ authenticate()',
            oldStart: START,
            newStart: START,
            lines: [
              { kind: 'context', text: lineText(FIND_ANCHOR) },
              { kind: 'del', text: THROW_LINE },
              { kind: 'add', text: THROW_LINE.replace('"error.usuarioNoEncontrado"', '"error.login"') },
              { kind: 'context', text: lineText(MATCH_ANCHOR) },
            ],
          },
        ],
      },
    ],
  },
];

/** Respuesta simulada de `POST …/changes/{id}/compare`: cada preset antes y después del cambio. */
export function sampleCompareResponse(proposalId: string, _contextBase64: string): ChangeCompareResponse {
  const cases = SAMPLE_FLOW.simulationPresets.map((preset) => {
    const before = simulatePreset(preset.id);
    const after = preset.id === 'no-user'
      ? {
        ...before,
        httpStatus: 401,
        badge: 'Error 401',
        title: 'Mismo aviso que una contraseña incorrecta',
        userImpact: 'El usuario ve "Usuario o contraseña incorrectos" sin saber si el email existe.',
        fix: '',
      }
      : before;
    return { presetId: preset.id, before, after };
  });
  return {
    success: true,
    codigo: 'OK',
    mensaje: null,
    comparison: { proposalId, flowId: SAMPLE_FLOW.id, cases },
    model: 'Ejemplo',
    usage: null,
    cached: false,
  };
}
