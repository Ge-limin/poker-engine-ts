import type { EngineHooks, HookRegistration, Session } from '../types/session';

type HookList<TPayload> =
  | HookRegistration<TPayload>
  | readonly HookRegistration<TPayload>[]
  | undefined;

export async function invokeHooks<TPayload>(
  registration: HookList<TPayload>,
  payload: TPayload,
  session: Session,
): Promise<void> {
  const hooks = normalizeHooks(registration);
  for (const hook of hooks) {
    await hook.handler(payload, session);
  }
}

export async function invokeEngineHooks(
  hooks: EngineHooks,
  stage: keyof EngineHooks,
  payload: unknown,
  session: Session,
): Promise<void> {
  const registration = hooks[stage];
  await invokeHooks(registration as HookList<unknown>, payload, session);
}

function normalizeHooks<TPayload>(
  registration: HookList<TPayload>,
): readonly HookRegistration<TPayload>[] {
  if (!registration) {
    return [];
  }

  const hooks = Array.isArray(registration)
    ? [...registration]
    : [registration];

  hooks.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.id.localeCompare(b.id);
  });

  return hooks;
}
