/**
 * The Ink application: a {@link TuiController} drawn as a {@link Screen}, with the
 * keyboard wired to it. It holds only what is purely of the screen — the text being
 * typed and where the focus is.
 */
import { useApp, useInput } from 'ink';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { TaskDetails } from './components.tsx';
import { Screen } from './components.tsx';
import type { TuiController } from './controller.ts';
import type { FocusAt } from './keys.ts';
import { activeForm, handleKey } from './keys.ts';
import type { TranscriptFocus } from './transcript.tsx';

/** Properties of {@link App}. */
export interface AppProps extends TaskDetails {
  /** The state and operations to draw and drive. When it exits, the application ends. */
  readonly controller: TuiController;
}

/**
 * State that is also readable at once after it is set: several keys can arrive in one
 * read of the terminal, before React has drawn the first of them.
 */
function useLive<T>(initial: T): readonly [T, (value: T) => void, () => T] {
  const [value, setValue] = useState(initial);
  const latest = useRef(initial);
  const set = (next: T): void => {
    latest.current = next;
    setValue(next);
  };
  return [value, set, () => latest.current];
}

/** The terminal UI as an Ink component. */
export function App(props: AppProps): ReactNode {
  const { controller } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [text, setText, latestText] = useLive('');
  const [focus, setFocus, latestFocus] = useLive<FocusAt>({ index: 0, cursor: 0 });
  const { exit } = useApp();
  useEffect(() => {
    if (state.exited) {
      exit();
    }
  }, [state.exited, exit]);

  const form = activeForm(controller, state.view);
  const entry = form?.entries[focus.index - 1];
  useInput((input, key) => {
    const context = {
      controller,
      form,
      text: latestText(),
      focus: latestFocus(),
      setText,
      setFocus,
    };
    handleKey(context, input, key);
  });

  const focused: TranscriptFocus | null =
    form === null || entry === undefined
      ? null
      : {
          itemId: form.itemId,
          surfaceId: entry.surfaceId,
          controlId: entry.control.id,
          cursor: focus.cursor,
        };
  return (
    <Screen
      view={state.view}
      busy={state.busy}
      models={(itemId, batches) => controller.model(itemId, batches)}
      focus={focused}
      text={text}
      focused={focused === null}
      recording={state.recording}
      commands={controller.session.commands}
      state={state.view.state}
      dashboardUrl={controller.session.dashboardUrl}
      taskName={props.taskName ?? null}
      model={props.model ?? null}
      effort={props.effort ?? null}
    />
  );
}
