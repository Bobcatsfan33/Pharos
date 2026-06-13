/**
 * Deadline enforcement for the verdict cascade.
 *
 * The cascade must return within the latency budget (default 800ms). withDeadline races
 * the cascade against a timer; if the timer wins, the caller applies a fail-mode verdict.
 * Fail-open (reversible actions): allow and queue async review. Fail-closed (irreversible
 * actions): escalate to a human. Either way an evidence record explains what happened.
 */
export class DeadlineExceeded extends Error {
  constructor(public readonly budgetMs: number) {
    super(`verdict deadline of ${budgetMs}ms exceeded`);
    this.name = "DeadlineExceeded";
  }
}

export async function withDeadline<T>(budgetMs: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(budgetMs)), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
