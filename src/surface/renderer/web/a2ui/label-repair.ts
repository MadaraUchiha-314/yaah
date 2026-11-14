/**
 * An accessibility repair for the A2UI basic catalog as shipped in `@a2ui/web_core` 0.15:
 * its text field, slider and date input draw a `<label>` next to the control without
 * tying the two together, so a screen reader announces a nameless field (WCAG 1.3.1,
 * 4.1.2). This names each such control by the label drawn beside it.
 */

let labels = 0;

const CONTROLS = 'input, textarea, select';

/** Ties every loose label under `root` to the control that follows it in the same parent. */
export function nameControls(root: Element): void {
  for (const label of root.querySelectorAll('label:not([for])')) {
    const siblings = [...(label.parentElement?.children ?? [])];
    const control = siblings.find((sibling) => sibling.matches(CONTROLS));
    const named = control?.hasAttribute('aria-labelledby') ?? true;
    if (control !== undefined && !named && label.querySelector(CONTROLS) === null) {
      if (label.id === '') {
        labels += 1;
        label.id = `a2ui-label-${String(labels)}`;
      }
      control.setAttribute('aria-labelledby', label.id);
    }
  }
}

/**
 * Keeps the controls under `root` named as the surface draws and redraws itself. It has
 * the shape of a React ref callback: given the element, it returns what undoes it.
 *
 * @returns A function that stops watching, or nothing when there is no element.
 */
export function watchControls(root: Element | null): (() => void) | undefined {
  if (root === null) {
    return undefined;
  }
  nameControls(root);
  const observer = new MutationObserver(() => {
    nameControls(root);
  });
  observer.observe(root, { childList: true, subtree: true });
  return (): void => {
    observer.disconnect();
  };
}
