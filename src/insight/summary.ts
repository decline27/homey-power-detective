/**
 * The weekly summary: the same facts as the settings page, in a few sentences. Written by a
 * template, or, if the user gave an Anthropic API key, by Claude, which is told to use only the
 * numbers it is given. The detection never depends on the AI; the AI only explains.
 */
import * as https from 'https';
import { DayAccount } from './account';
import { Finding } from './findings';

export interface SummaryInput {
  language: 'en' | 'sv';
  currency: string;
  days: number;
  totalKWh: number;
  explainedShare: number;
  /** What used the energy: devices by their own meters, and found loads. */
  loads: Array<{ name: string; kWhPerDay: number; costPerMonth: number | null; confirmed: boolean; metered?: boolean }>;
  findings: Finding[];
  /** Device matches and their scores: how much to trust the names. */
  validation: Array<{ device: string; f1: number }>;
}

const r = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The summary's numbers from the energy account, the same rows the settings page charts: every kWh
 * once, a metered device by its own meter (exact), a found load by what is left. `confirmed` says
 * whether a load row's name is known (named, matched to a device or confirmed by a test).
 */
export function accountFacts(
  accounts: DayAccount[],
  confirmed: (rowKey: string) => boolean,
  avgPrice: number | null
): Pick<SummaryInput, 'days' | 'totalKWh' | 'explainedShare' | 'loads'> {
  const days = accounts.filter(d => d.coveredHours > 0);
  const totalKWh = days.reduce((s, d) => s + d.totalKWh, 0);
  const explained = days.reduce((s, d) => s + d.explainedShare * d.totalKWh, 0);
  const dayCount = Math.max(days.reduce((s, d) => s + d.coveredHours, 0) / 24, 1 / 24);
  const rows = new Map<string, { name: string; kWh: number; metered: boolean }>();
  for (const d of days) {
    for (const row of d.rows) {
      if (row.kind !== 'metered' && row.kind !== 'load') continue;
      const prev = rows.get(row.key);
      rows.set(row.key, { name: row.name, kWh: (prev?.kWh ?? 0) + row.kWh, metered: row.kind === 'metered' });
    }
  }
  const loads = [...rows.entries()]
    .map(([key, x]) => ({
      name: x.name,
      kWhPerDay: x.kWh / dayCount,
      costPerMonth: avgPrice === null ? null : (x.kWh / dayCount) * 30 * avgPrice,
      confirmed: x.metered || confirmed(key),
      metered: x.metered,
    }))
    .sort((a, b) => b.kWhPerDay - a.kWhPerDay);
  return { days: days.length, totalKWh, explainedShare: totalKWh > 0 ? explained / totalKWh : 0, loads };
}

export function templateSummary(s: SummaryInput): string {
  const sv = s.language === 'sv';
  const top = s.findings[0];
  const lines: string[] = [];
  lines.push(
    sv
      ? `Senaste ${s.days} dagarna: ${r(s.totalKWh)} kWh, varav ${r(s.explainedShare * 100)} % förklarat av mätare, hittade laster och baslasten.`
      : `Last ${s.days} days: ${r(s.totalKWh)} kWh, ${r(s.explainedShare * 100)} % of it accounted for by meters, found loads and the base load.`
  );
  const biggest = [...s.loads].sort((a, b) => b.kWhPerDay - a.kWhPerDay).slice(0, 3);
  const tag = (l: SummaryInput['loads'][number]) =>
    l.metered ? (sv ? ' (egen mätare)' : ' (own meter)') : l.confirmed ? '' : sv ? ' (obekräftad)' : ' (unconfirmed)';
  if (biggest.length) {
    lines.push((sv ? 'Störst: ' : 'Biggest: ') + biggest.map(l => `${l.name} ${r(l.kWhPerDay, 1)} kWh/${sv ? 'dygn' : 'day'}${tag(l)}`).join(', ') + '.');
  }
  if (top) {
    const saving = top.savingPerMonth ?? top.costPerMonth;
    lines.push(
      (sv ? 'Gör först: ' : 'Do first: ') +
        top.title +
        (saving !== null ? (sv ? ` (cirka ${r(saving)} ${s.currency}/mån).` : ` (about ${r(saving)} ${s.currency}/month).`) : '.')
    );
    if (top.experimentHours) {
      lines.push(
        sv
          ? `Bekräfta genom att stänga av den du tror det är i ${top.experimentHours} h och starta ett test i appen.`
          : `Confirm it: switch off what you think it is for ${top.experimentHours} h and start a test in the app.`
      );
    }
  }
  return lines.join(' ');
}

export function claudePrompt(s: SummaryInput): { system: string; user: string } {
  return {
    system:
      'You explain a household\'s electricity use to its owner. Use only the numbers in the JSON you are given; never ' +
      'invent or estimate a number. Say plainly when a load is unconfirmed. Lead with the single action worth most money, ' +
      'then at most two more. No more than 120 words, no lists, no headings. ' +
      (s.language === 'sv' ? 'Write in Swedish.' : 'Write in English.'),
    user: JSON.stringify(s),
  };
}

/**
 * Models offered for the summary. Haiku is the default: the job is rewording ~2k tokens of given
 * numbers into 120 words once a week, which needs no reasoning (about $0.02 a year at list price).
 */
export const SUMMARY_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export const DEFAULT_SUMMARY_MODEL = SUMMARY_MODELS[0];

export type Transport = (body: string, apiKey: string) => Promise<{ status: number; body: string }>;

/** POST to the Anthropic Messages API. */
export const httpsTransport: Transport = (body, apiKey) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Anthropic API timed out')));
    req.on('error', reject);
    req.end(body);
  });

/** Claude's summary, or the template's if there is no key or the call fails. */
export async function summarize(
  s: SummaryInput,
  opts: { apiKey?: string; model?: string; transport?: Transport } = {}
): Promise<{ text: string; source: 'claude' | 'template'; error?: string }> {
  const fallback = templateSummary(s);
  if (!opts.apiKey) return { text: fallback, source: 'template' };
  const { system, user } = claudePrompt(s);
  const body = JSON.stringify({
    model: SUMMARY_MODELS.includes(opts.model as (typeof SUMMARY_MODELS)[number]) ? opts.model : DEFAULT_SUMMARY_MODEL,
    // These models think before they answer (thinking cannot be turned off on Opus 5.5), and the
    // thinking counts against max_tokens: with 400 it could take them all and leave no text.
    // Low effort suits rewording given numbers; the room is for the thinking, the answer is short.
    max_tokens: 2000,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  try {
    const res = await (opts.transport ?? httpsTransport)(body, opts.apiKey);
    if (res.status !== 200) return { text: fallback, source: 'template', error: `Anthropic API ${res.status}` };
    const parsed = JSON.parse(res.body) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string };
    const text = (parsed.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('').trim();
    if (text && parsed.stop_reason !== 'refusal') return { text, source: 'claude' };
    return { text: fallback, source: 'template', error: `no answer (stop: ${parsed.stop_reason ?? 'unknown'})` };
  } catch (e) {
    return { text: fallback, source: 'template', error: (e as Error).message };
  }
}
