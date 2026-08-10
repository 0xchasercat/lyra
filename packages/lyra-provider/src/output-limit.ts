import { isOutputCapMessage, type ProviderFault } from "./errors.ts";

/**
 * How many output tokens a request asks for when nothing knows the model's real ceiling.
 *
 * The rule, in one line: **every request asks for the model's maximum.** A known model gets
 * its published cap from `ModelInfo.maxOutputTokens`; an unknown model gets this number,
 * which is deliberately at the top of what any current model offers rather than a cautious
 * guess. The cautious guess is what this whole file exists to delete — the Anthropic
 * transport defaulted to 4096, nothing upstream ever set the field, and a long reply from a
 * frontier model was cut off at ~4k and reported to the user as `truncated`. A silent
 * ceiling nobody chose is a §3.8 loss, not a safety margin.
 *
 * Asking too high is recoverable and asking too low is not, which is why the asymmetry runs
 * this way: a provider that cannot serve this many says so in a 400 that *names its own
 * limit*, and {@link parseOutputCap} reads the number straight back out. See
 * {@link OutputCapMemory} for why that 400 is paid once per model rather than per turn.
 */
export const MAX_OUTPUT_TOKENS_ASK = 128_000;

/**
 * The number an output-cap rejection names as the model's own limit.
 *
 * Anthropic's message is `max_tokens: 128000 > 64000, which is the maximum allowed number of
 * output tokens for claude-haiku-4-5` — the ask first, the real cap second. OpenAI phrases it
 * as `max_tokens is too large: 200000. This model supports at most 32768 completion tokens`.
 *
 * Read by anchored patterns first, because the naive "smallest integer in the sentence"
 * reading is wrong on exactly the message that matters: `claude-haiku-4-5` contributes a 4
 * and a 5, and the smallest candidate is then 4. The unanchored scan survives as a fallback
 * for phrasings neither pattern covers, floored well above any digit a model name can
 * contribute, and a retry that is still too high is simply rejected again.
 */
const CAP_ANCHORS: readonly RegExp[] = [
  // `max_tokens: 128000 > 64000, …` — the ask, then the ceiling.
  />\s*(\d[\d_,]*)/,
  /\b(?:at most|no more than|maximum of|max(?:imum)? (?:is|of)|supports?(?: up to)?|limited to)\s+(\d[\d_,]*)/,
];

/** Below this, an integer in a provider message is a version or a model-name fragment. */
const SMALLEST_PLAUSIBLE_CAP = 256;

export function parseOutputCap(message: string, asked: number | undefined): number | undefined {
  const usable = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= SMALLEST_PLAUSIBLE_CAP && (asked === undefined || value < asked);

  for (const anchor of CAP_ANCHORS) {
    const captured = anchor.exec(message)?.[1];
    if (captured === undefined) continue;
    const value = Number(captured.replaceAll(/[_,]/g, ""));
    if (usable(value)) return value;
  }

  const candidates: number[] = [];
  for (const match of message.matchAll(/\d[\d_,]*/g)) {
    const value = Number(match[0].replaceAll(/[_,]/g, ""));
    if (usable(value)) candidates.push(value);
  }
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

/** Whether a fault is the provider refusing our own `max_tokens`, rather than the prompt. */
export function isOutputCapFault(fault: ProviderFault): boolean {
  if (fault.status !== undefined && fault.status !== 400 && fault.status !== 422) return false;
  return isOutputCapMessage(fault.providerMessage.toLowerCase());
}

/**
 * What a provider taught us about one of its models' output ceilings, for this session.
 *
 * Scoped per provider *and* model because it is a fact about exactly that pair: the same id
 * behind two gateways can be served with different caps, and one instance of this lives on
 * each `ReliableProvider`, which is already per-provider. Without the memory the discovery
 * 400 is paid on every single turn — a round trip and a full input-token charge each time —
 * which would trade one visible bug for a slower invisible one.
 */
export class OutputCapMemory {
  readonly #caps = new Map<string, number>();

  /** The learned cap for a model, when a provider has already refused a larger ask. */
  get(model: string): number | undefined {
    return this.#caps.get(model);
  }

  /** Records a ceiling. The lowest one a provider has stated wins; it never rises again. */
  learn(model: string, cap: number): void {
    if (!Number.isSafeInteger(cap) || cap <= 0) return;
    const known = this.#caps.get(model);
    if (known !== undefined && known <= cap) return;
    this.#caps.set(model, cap);
  }

  /** The ask, lowered to whatever this provider has already proven it will accept. */
  clamp(model: string, requested: number | undefined): number | undefined {
    const learned = this.#caps.get(model);
    if (learned === undefined) return requested;
    return requested === undefined ? learned : Math.min(requested, learned);
  }
}

/**
 * The next ask after a refusal, when the provider did not name its limit.
 *
 * Halving is the fallback rather than the rule: it costs one extra round trip per step and
 * converges on a number that is merely *accepted* rather than the model's actual maximum,
 * so it only runs when {@link parseOutputCap} found nothing to read.
 */
export function halveOutputCap(asked: number): number {
  return Math.max(1_024, Math.floor(asked / 2));
}

/**
 * The output-token ask for one request: the model's published maximum, or the deliberately
 * high {@link MAX_OUTPUT_TOKENS_ASK} when nothing published one.
 */
export function resolveMaxOutputTokens(modelMaxOutputTokens?: number): number {
  return modelMaxOutputTokens !== undefined
      && Number.isSafeInteger(modelMaxOutputTokens)
      && modelMaxOutputTokens > 0
    ? modelMaxOutputTokens
    : MAX_OUTPUT_TOKENS_ASK;
}
