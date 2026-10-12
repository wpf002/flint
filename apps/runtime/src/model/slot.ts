/**
 * One local-model request at a time in this process (Machine plan P3): triage's
 * judgement and a goal review's plan stage ask the same Ollama, and two requests
 * at once would each run slower and hold chat up twice as long. Every request
 * either of them makes goes through here, one after another in the order asked.
 *
 * The slot is taken BEFORE the yield-to-chat check, so a request that waited its
 * turn asks about chat when its turn comes, not when it joined the line. A
 * request that fails or times out frees the slot like any other.
 */
let tail: Promise<void> = Promise.resolve();

export function modelSlot<T>(request: () => Promise<T>): Promise<T> {
  const run = tail.then(request, request);
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
