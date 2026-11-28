import { BrowserActionSupport } from './browser-actions.js';
import {
  aimAtProbe,
  probeBrowserClickTarget,
  targetNotInteractableResult,
} from './browser-click-interactability.js';
import {
  asNumber,
  cdp,
  type CdpExceptionDetails,
  delay,
  describeCdpException,
  stringArray,
  type Rect,
  type BrowserSessionState as SessionState,
} from './browser-state.js';
import { IsolatedClipboardProvider, type ClipboardProvider } from './clipboard.js';
import { unexpectedNavigationRetry } from './browser-write-record.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';
import { CLICK_REACH_SOURCE } from './program/page-script.js';

const ACTION_SETTLE_DELAY_MS = 100;
/** A check whose click reached the input waits this long for a state that follows a server answer. */
const CHECK_SETTLE_MS = 1_000;
const ARM_CLICK_REACH = `function () { return (${CLICK_REACH_SOURCE})(this, true); }`;
const CLICK_REACHED = `function () { return (${CLICK_REACH_SOURCE})(this, false); }`;

interface CheckableState {
  checkable: boolean;
  checked: boolean;
  type: string;
}

/** Reads the live `checked` property; the attribute does not track user changes. */
const READ_CHECKABLE_STATE = `function () {
  const type = this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : '';
  const checkable = type === 'checkbox' || type === 'radio';
  return { checkable, checked: checkable ? Boolean(this.checked) : false, type };
}`;

export interface SelectMutationState {
  selectable: boolean;
  multiple: boolean;
  missingValues: string[];
  selectedValues: string[];
  /** Requested entries mapped to option values (label matches resolve to their value). */
  resolvedValues?: string[];
  /** Bounded option list disclosed when a requested entry matches nothing. */
  availableOptions?: Array<{
    value: string;
    label: string;
    valueTruncated?: true;
    labelTruncated?: true;
  }>;
  availableOptionCount?: number;
  /**
   * Requested labels shared by options with different values; the disclosed
   * `availableOptions` are then exactly those candidates.
   */
  ambiguousValues?: string[];
  /** Accessible identity of the select that was hit, to expose wrong-target selectors. */
  selectIdentity?: string;
}

const MAX_DISCLOSED_SELECT_OPTIONS = 30;
/**
 * Per-option text cap. Labels used to be cut at 80 chars without a marker while
 * recovery asked for an "exact label" (eval 784094: an issue picker label was
 * cut mid-word), so truncation is now flagged and recovery points at `value`.
 */
const MAX_DISCLOSED_SELECT_OPTION_TEXT = 200;

function selectOptionNotFoundRecovery(options: SelectMutationState['availableOptions']): string {
  const base =
    'Retry with a value or exact label from availableOptions. If none of them fit, this is probably the wrong select element; inspect and use the intended select ref.';
  if (!options?.some((option) => option.labelTruncated)) return base;
  return `${base} Labels marked labelTruncated are shortened and will not match as labels; pass that option's value instead.`;
}

interface SelectState {
  selectable: boolean;
  multiple: boolean;
  selectedValues: string[];
}

/**
 * Sets a select's options by value or exact label and reports what it selected;
 * runs with the select as `this`, for select_option and for program ops.
 */
export const SELECT_MUTATION_FUNCTION = `function (wanted) {
        if (!(this instanceof HTMLSelectElement)) {
          return {
            selectable: false,
            multiple: false,
            missingValues: [],
            selectedValues: [],
          };
        }
        // Never use Array.from here: Prototype.js (Magento admin) and MooTools
        // replace it with a version that ignores the map function, so
        // selectedOptions came back as DOM nodes and returnByValue failed with
        // "Object reference chain is too long" after the change already
        // applied (TUI in evaluation; desktop showed the generic failure).
        const requestedEntries = [
          ...new Set(Array.isArray(wanted) ? wanted.map(String) : []),
        ];
        const options = Array.prototype.slice.call(this.options || []);
        const selectedValuesOf = () =>
          options.filter((option) => option.selected).map((option) => String(option.value));
        const multiple = Boolean(this.multiple);
        const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim();
        const optionLabel = (option) => normalize(option.label || option.textContent);
        const byValue = new Set(options.map((option) => String(option.value)));
        // A requested entry is an option value first; when no option has that
        // value, fall back to an exact visible label (models usually read
        // labels, not values, from inspect output). Eval 827211: pickers that
        // render the same option twice (same label, same value) were reported
        // as SELECT_OPTION_NOT_FOUND, so a label resolves when its matches
        // share one value. Disabled duplicates yield to enabled ones; labels
        // still naming several values are ambiguous, never guessed.
        const missingValues = [];
        const ambiguousValues = [];
        const ambiguousOptions = [];
        const values = [];
        // A value and its own label name the same option; keep one entry so
        // the selected set compares equal and single selects accept it.
        const pushValue = (value) => {
          if (!values.includes(value)) values.push(value);
        };
        for (const entry of requestedEntries) {
          if (byValue.has(entry)) {
            pushValue(entry);
            continue;
          }
          const wantedLabel = normalize(entry);
          let labelMatches = options.filter((option) => optionLabel(option) === wantedLabel);
          if (labelMatches.length === 0) {
            const folded = wantedLabel.toLowerCase();
            labelMatches = options.filter(
              (option) => optionLabel(option).toLowerCase() === folded,
            );
          }
          const enabledMatches = labelMatches.filter((option) => !option.disabled);
          if (enabledMatches.length > 0) labelMatches = enabledMatches;
          const matchedValues = [...new Set(labelMatches.map((option) => String(option.value)))];
          if (matchedValues.length === 1) pushValue(matchedValues[0]);
          else if (matchedValues.length === 0) missingValues.push(entry);
          else {
            ambiguousValues.push(entry);
            for (const option of labelMatches) {
              if (!ambiguousOptions.includes(option)) ambiguousOptions.push(option);
            }
          }
        }
        const identity = () =>
          normalize(
            this.getAttribute('aria-label') ||
              (this.labels && this.labels[0] && this.labels[0].textContent) ||
              this.getAttribute('name') ||
              this.id ||
              '',
          ).slice(0, 80);
        if (!multiple && values.length > 1) {
          return {
            selectable: true,
            multiple,
            missingValues: [],
            selectedValues: selectedValuesOf(),
            resolvedValues: values,
          };
        }
        if (missingValues.length > 0 || ambiguousValues.length > 0) {
          const disclosed = missingValues.length > 0 ? options : ambiguousOptions;
          return {
            selectable: true,
            multiple,
            missingValues,
            ambiguousValues,
            selectedValues: selectedValuesOf(),
            availableOptions: disclosed
              .slice(0, ${MAX_DISCLOSED_SELECT_OPTIONS})
              .map((option) => {
                const value = String(option.value);
                const label = optionLabel(option);
                const max = ${MAX_DISCLOSED_SELECT_OPTION_TEXT};
                return {
                  value: value.slice(0, max),
                  label: label.slice(0, max),
                  ...(value.length > max ? { valueTruncated: true } : {}),
                  ...(label.length > max ? { labelTruncated: true } : {}),
                };
              }),
            availableOptionCount: disclosed.length,
            selectIdentity: identity(),
            resolvedValues: values,
          };
        }
        // Duplicate options share a value; select one per value (the first
        // enabled) so a multi-select does not report the value twice.
        const pending = new Set(values);
        for (const option of options) option.selected = false;
        for (const option of options) {
          const value = String(option.value);
          if (!option.disabled && pending.delete(value)) option.selected = true;
        }
        for (const option of options) {
          const value = String(option.value);
          if (pending.delete(value)) option.selected = true;
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          selectable: true,
          multiple,
          missingValues: [],
          selectedValues: selectedValuesOf(),
          resolvedValues: values,
        };
      }`;

/** The failure result of a select mutation that selected nothing; undefined when it applied. */
export function selectMutationFailure(
  mutation: SelectMutationState | undefined,
  values: readonly string[],
  startedAt: number,
  rect: Rect | undefined,
): Record<string, unknown> | undefined {
  if (!mutation?.selectable) {
    return {
      success: false,
      code: 'TARGET_NOT_SELECT',
      error: 'Browser select_option target is not a select element.',
      durationMs: Date.now() - startedAt,
      target: { resolved: true, rect },
      effect: { dispatched: false, verified: false, selectedValues: [] },
    };
  }
  if ((mutation.resolvedValues ?? values).length > 1 && mutation.multiple !== true) {
    return {
      success: false,
      code: 'SELECT_MULTIPLE_VALUES_NOT_ALLOWED',
      error: 'Browser select_option received multiple values for a single-select element.',
      durationMs: Date.now() - startedAt,
      target: { resolved: true, rect },
      effect: {
        dispatched: false,
        verified: false,
        selectedValues: mutation.selectedValues,
      },
      recovery: 'Choose exactly one option value for this select element.',
    };
  }
  if (mutation.missingValues.length > 0) {
    const identity = mutation.selectIdentity ? ` "${mutation.selectIdentity}"` : '';
    const total = mutation.availableOptionCount ?? mutation.availableOptions?.length ?? 0;
    const shown = mutation.availableOptions?.length ?? 0;
    return {
      success: false,
      code: 'SELECT_OPTION_NOT_FOUND',
      error: `Browser select_option could not find requested option value(s) or label(s) in select${identity}: ${mutation.missingValues.join(', ')}`,
      durationMs: Date.now() - startedAt,
      target: {
        resolved: true,
        rect,
        ...(mutation.selectIdentity ? { name: mutation.selectIdentity } : {}),
      },
      effect: {
        dispatched: false,
        verified: false,
        selectedValues: mutation.selectedValues,
      },
      ...(mutation.availableOptions
        ? {
            availableOptions: mutation.availableOptions,
            ...(total > shown
              ? { availableOptionsTruncated: true, availableOptionCount: total }
              : {}),
          }
        : {}),
      recovery: selectOptionNotFoundRecovery(mutation.availableOptions),
    };
  }
  const ambiguousValues = mutation.ambiguousValues ?? [];
  if (ambiguousValues.length > 0) {
    const identity = mutation.selectIdentity ? ` "${mutation.selectIdentity}"` : '';
    const total = mutation.availableOptionCount ?? mutation.availableOptions?.length ?? 0;
    const shown = mutation.availableOptions?.length ?? 0;
    return {
      success: false,
      code: 'SELECT_OPTION_AMBIGUOUS',
      error: `Browser select_option label(s) match several options with different values in select${identity}: ${ambiguousValues.join(', ')}`,
      durationMs: Date.now() - startedAt,
      target: {
        resolved: true,
        rect,
        ...(mutation.selectIdentity ? { name: mutation.selectIdentity } : {}),
      },
      effect: {
        dispatched: false,
        verified: false,
        selectedValues: mutation.selectedValues,
      },
      ...(mutation.availableOptions
        ? {
            availableOptions: mutation.availableOptions,
            ...(total > shown
              ? { availableOptionsTruncated: true, availableOptionCount: total }
              : {}),
          }
        : {}),
      recovery:
        'availableOptions lists the options sharing that label; retry with the value of the intended option.',
    };
  }
  return undefined;
}

export abstract class BrowserExtendedActionSupport extends BrowserActionSupport {
  protected readonly clipboardProvider: ClipboardProvider;

  protected constructor(clipboardProvider: ClipboardProvider = new IsolatedClipboardProvider()) {
    super();
    this.clipboardProvider = clipboardProvider;
  }

  protected async setChecked(
    session: SessionState,
    input: Record<string, unknown>,
    checked: boolean,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const target = await this.resolveTarget(session, input, true, true);
    if (target.backendNodeId === undefined && isCoordinateLocator(input)) {
      const backendNodeId = await this.resolveControlAtPoint(session, target, 'checkable');
      if (backendNodeId === undefined) {
        throw new Error(
          'TARGET_NOT_FOUND: no checkbox or radio input (or its label) is at that position; inspect the page and use the control ref',
        );
      }
      target.backendNodeId = backendNodeId;
    }
    if (target.backendNodeId === undefined) throw new Error('CHECK_REQUIRES_ELEMENT_REF');
    const before = await this.callBackendNode<CheckableState>(
      session,
      target.backendNodeId,
      READ_CHECKABLE_STATE,
    );
    if (!before?.checkable) {
      return {
        success: false,
        code: 'TARGET_NOT_CHECKABLE',
        error: 'Browser check target is not a checkbox or radio input.',
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
        effect: { dispatched: false, verified: false },
      };
    }
    const action = checked ? 'check' : 'uncheck';
    // Pre-click hit test of the input, or of its label when the input itself
    // is invisible. A control inside a collapsed group (a closed tab, an inert
    // or unpainted aria-hidden group) is refused: a pointer click there lands
    // on whatever sits at its box (the row below, the logo at the origin of a
    // display: none box). So is one the page covers (a modal's backdrop): the
    // user cannot reach it either. A control only covered by its own parts (a
    // styled knob over a transparent input), or visually hidden on its own, is
    // set through the input itself, without a pointer click on the cover.
    let aim = target;
    let pointerSkipped = false;
    if (before.checked !== checked && !isCoordinateLocator(input)) {
      const probe = await probeBrowserClickTarget(session, input, { labelFallback: true });
      if (
        (probe.blocked?.reason === 'hidden' && probe.blocked.collapsed === true) ||
        (probe.blocked?.reason === 'covered' && probe.ownCover !== true)
      ) {
        return targetNotInteractableResult(action, probe.blocked, Date.now() - startedAt);
      }
      pointerSkipped = probe.blocked !== undefined;
      aim = aimAtProbe(target, probe);
    }
    const generation = session.generation;
    // A checkbox whose change handler loads another URL (filter facets)
    // replaces the document: report the navigation like a click instead of
    // failing on the read-back of a node that is gone.
    const watch = before.checked !== checked ? await this.watchInputNavigation(session) : undefined;
    const navigated = async (): Promise<Record<string, unknown> | undefined> => {
      if (!watch) return undefined;
      const facts = await watch.settle();
      if (!this.inputNavigated(session, facts, generation)) return undefined;
      return this.navigatedByInputResult(session, action, facts, {
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
        effect: { dispatched: true, verified: false },
      });
    };
    try {
      // Whether the pointer click reaches the input or one of its labels: one
      // that did is not followed by a second click, whose toggle would undo it
      // on a control that shows its state only once its server answers. Not
      // known (undefined) when the listener could not be set or read, or a page
      // handler stopped the click before it: no second click either.
      let reached: boolean | undefined;
      const unknownReach = (error: unknown): undefined => {
        if (isBrowserOperationInterruption(error)) throw error;
        return undefined;
      };
      if (before.checked !== checked && !pointerSkipped) {
        await this.callBackendNode(session, target.backendNodeId, ARM_CLICK_REACH).catch(
          unknownReach,
        );
        await session.beforePointerAction?.(
          { action, point: { x: aim.x, y: aim.y } },
          session.commandSignal,
        );
        await this.dispatchMouse(session, aim.x, aim.y, 'mouseMoved');
        await delay(50, session.commandSignal);
        await this.dispatchMouse(session, aim.x, aim.y, 'mousePressed', {
          button: 'left',
          clickCount: 1,
        });
        await this.dispatchMouse(session, aim.x, aim.y, 'mouseReleased', {
          button: 'left',
          clickCount: 1,
        });
        await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
        const early = await navigated();
        if (early) return early;
        reached = await this.callBackendNode<boolean | undefined>(
          session,
          target.backendNodeId,
          CLICK_REACHED,
        ).catch(unknownReach);
      }
      let after = await this.callBackendNode<CheckableState>(
        session,
        target.backendNodeId,
        READ_CHECKABLE_STATE,
      );
      if (reached === true) {
        const deadline = Date.now() + CHECK_SETTLE_MS;
        while (after?.checkable === true && after.checked !== checked && Date.now() < deadline) {
          await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
          after = await this.callBackendNode<CheckableState>(
            session,
            target.backendNodeId,
            READ_CHECKABLE_STATE,
          );
        }
      }
      let fallbackDispatched = false;
      // A radio cannot be unchecked by activating it.
      const canActivate = checked || before.type !== 'radio';
      if (
        after?.checkable === true &&
        after.checked !== checked &&
        canActivate &&
        (pointerSkipped || reached === false)
      ) {
        // The pointer was skipped above, or it provably missed the input (a
        // styled label of another control took it). Activate the input itself
        // once, which runs the native toggle and the page's click/input/change
        // handlers.
        fallbackDispatched = true;
        await this.callBackendNode(session, target.backendNodeId, 'function () { this.click(); }');
        await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
        after = await this.callBackendNode<CheckableState>(
          session,
          target.backendNodeId,
          READ_CHECKABLE_STATE,
        );
      }
      const dispatched = (before.checked !== checked && !pointerSkipped) || fallbackDispatched;
      const verified = after?.checkable === true && after.checked === checked;
      this.invalidateObservation(session);
      const result = {
        success: verified,
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: aim.rect },
        effect: {
          dispatched,
          verified,
          checked: after?.checked,
          ...(fallbackDispatched ? { fallback: 'element_click' } : {}),
        },
      } as Record<string, unknown>;
      if (!verified && after?.checkable === false) {
        result.code = 'TARGET_NOT_CHECKABLE';
        result.error = 'Browser check target is no longer a checkbox or radio input.';
        result.recovery =
          'effect.checked is the live state now. The page may reject or control this field; inspect it before retrying.';
      } else if (!verified && dispatched && !fallbackDispatched && reached !== false) {
        // The click reached the input, or whether it did is unknown: a page
        // that applies the state when its server answers may still do so, and
        // a second click would undo it.
        result.code = 'CHECK_STATE_UNCONFIRMED';
        result.error =
          reached === true
            ? `Browser ${action} reached the control, but it is still ${after?.checked ? 'checked' : 'unchecked'} ${CHECK_SETTLE_MS} ms later.`
            : `Browser ${action} was dispatched, but the control is still ${after?.checked ? 'checked' : 'unchecked'}; whether the click reached it is unknown.`;
        result.recovery =
          'effect.checked is the live state now. A control that follows a server answer may still change: inspect it before retrying, since another click could toggle it back.';
      } else if (!verified) {
        result.code = 'CHECK_STATE_NOT_APPLIED';
        result.error = `Browser ${action} ${dispatched ? 'was dispatched, but the requested state was not retained' : 'could not change the control'}: the control is ${after?.checked ? 'checked' : 'unchecked'}.`;
        result.recovery =
          'effect.checked is the live state now. The page may reject or control this field; inspect it before retrying.';
      }
      return result;
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      const late = await navigated();
      if (late) return late;
      throw error;
    } finally {
      watch?.dispose();
    }
  }

  protected async selectOption(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const target = await this.resolveTarget(session, input, true, false);
    if (target.backendNodeId === undefined && isCoordinateLocator(input)) {
      const backendNodeId = await this.resolveControlAtPoint(session, target, 'select');
      if (backendNodeId === undefined) {
        throw new Error(
          'TARGET_NOT_FOUND: no select element (or its label) is at that position; inspect the page and use the select ref',
        );
      }
      target.backendNodeId = backendNodeId;
    }
    if (target.backendNodeId === undefined) throw new Error('SELECT_REQUIRES_ELEMENT_REF');
    const values = Array.from(new Set(stringArray(input.values)));
    if (values.length === 0) throw new Error('SELECT_REQUIRES_VALUES');
    const generation = session.generation;
    const watch = await this.watchInputNavigation(session);
    let mutation: SelectMutationState;
    let after: SelectState | undefined;
    try {
      mutation = await this.callBackendNode<SelectMutationState>(
        session,
        target.backendNodeId,
        SELECT_MUTATION_FUNCTION,
        [{ value: values }],
      );
      const refused = selectMutationFailure(mutation, values, startedAt, target.rect);
      if (refused) return refused;
      await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
      // A change handler that loads another URL (sort and page-size pickers)
      // replaces the document: the select can no longer be read back, and the
      // selection the mutation reported is what the new page was asked for.
      const navigated = (): Promise<Record<string, unknown> | undefined> =>
        watch.settle().then((facts) =>
          this.inputNavigated(session, facts, generation)
            ? this.navigatedByInputResult(session, 'select_option', facts, {
                durationMs: Date.now() - startedAt,
                target: { resolved: true, rect: target.rect },
                effect: {
                  dispatched: true,
                  verified: sameStringSet(
                    mutation.selectedValues,
                    mutation.resolvedValues ?? values,
                  ),
                  selectedValues: mutation.selectedValues,
                },
              })
            : undefined,
        );
      const early = await navigated();
      if (early) return early;
      try {
        after = await this.callBackendNode<SelectState>(
          session,
          target.backendNodeId,
          `function () {
        if (!(this instanceof HTMLSelectElement)) {
          return { selectable: false, multiple: false, selectedValues: [] };
        }
        return {
          selectable: true,
          multiple: Boolean(this.multiple),
          selectedValues: Array.prototype.filter
            .call(this.options || [], (option) => option.selected)
            .map((option) => String(option.value)),
        };
      }`,
        );
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        const late = await navigated();
        if (late) return late;
        throw error;
      }
    } finally {
      watch.dispose();
    }
    const selectedValues = after?.selectedValues ?? [];
    const verified =
      after?.selectable === true &&
      after.multiple === mutation.multiple &&
      sameStringSet(selectedValues, mutation.resolvedValues ?? values);
    this.invalidateObservation(session);
    const result = {
      success: verified,
      durationMs: Date.now() - startedAt,
      target: { resolved: true, rect: target.rect },
      effect: { dispatched: true, verified, selectedValues },
    } as Record<string, unknown>;
    if (!verified) {
      result.code = after?.selectable === false ? 'TARGET_NOT_SELECT' : 'SELECT_STATE_NOT_APPLIED';
      result.error =
        after?.selectable === false
          ? 'Browser select_option target is no longer a select element.'
          : `Browser select_option was dispatched, but the requested selection was not retained: selected value(s) are ${JSON.stringify(selectedValues.slice(0, 10))}.`;
      result.recovery =
        'effect.selectedValues is the live selection now. The page may reject or control this field; inspect it before retrying.';
    }
    return result;
  }

  protected async uploadFiles(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const beforeGeneration = session.generation;
    const target = await this.resolveTarget(session, input, false, false);
    if (target.backendNodeId === undefined) throw new Error('UPLOAD_REQUIRES_ELEMENT_REF');
    const authorizedFiles = Array.isArray(input.files)
      ? input.files
          .filter((file): file is Record<string, unknown> =>
            Boolean(file && typeof file === 'object' && !Array.isArray(file)),
          )
          .map((file) => (typeof file.filePath === 'string' ? file.filePath : ''))
          .filter(Boolean)
      : [];
    const paths = stringArray(input.paths).concat(authorizedFiles);
    if (paths.length === 0) throw new Error('UPLOAD_REQUIRES_PATHS');
    const requestedTimeout = Number(input.timeout);
    const chooserTimeoutMs =
      Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(120_000, Math.floor(requestedTimeout))
        : 30_000;
    // The mature chooser workflow currently operates on the root CDP session.
    // Preserve the existing session-scoped direct input behavior for OOPIFs;
    // main-frame buttons and custom controls use the chooser-aware path.
    const upload = session.commandSessionId
      ? await this.uploadFilesInAttachedFrame(session, target.backendNodeId, paths)
      : await session.cdpHelper.uploadFilesByBackendNodeId(target.backendNodeId, paths, {
          timeoutMs: chooserTimeoutMs,
          ...(session.commandSignal ? { signal: session.commandSignal } : {}),
        });
    const observedGeneration = session.generation;
    const navigationDetected = observedGeneration !== beforeGeneration;
    const verified = upload.filesAttached === paths.length && !navigationDetected;
    this.invalidateObservation(session);
    const result = {
      success: verified,
      durationMs: Date.now() - startedAt,
      filesAttached: upload.filesAttached,
      chooserOpened: upload.chooserOpened,
      target: { resolved: true, rect: target.rect },
      effect: {
        dispatched: true,
        verified,
        fileCount: upload.filesAttached,
        chooserOpened: upload.chooserOpened,
      },
      navigation: {
        detected: navigationDetected,
        generation: observedGeneration,
      },
    } as Record<string, unknown>;
    if (navigationDetected) {
      result.code = 'UNEXPECTED_NAVIGATION';
      result.error = 'File upload changed the active Browser page unexpectedly.';
      // The files were already handed to the page, so the upload may have taken effect.
      Object.assign(result, unexpectedNavigationRetry('upload_files', { dispatched: true }));
    }
    return result;
  }

  private async uploadFilesInAttachedFrame(
    session: SessionState,
    backendNodeId: number,
    paths: string[],
  ): Promise<{ filesAttached: number; chooserOpened: false }> {
    await cdp(session, 'DOM.setFileInputFiles', { backendNodeId, files: paths });
    const filesAttached = await this.callBackendNode<number>(
      session,
      backendNodeId,
      'function () { return this.files ? this.files.length : 0; }',
    );
    if (filesAttached !== paths.length) {
      throw new Error('FILE_UPLOAD_NOT_OBSERVED: selected file count did not match');
    }
    return { filesAttached, chooserOpened: false };
  }

  protected async paste(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const targetInput = input.ref || input.selector ? input : undefined;
    const target = targetInput
      ? await this.resolveTarget(session, targetInput, true, false, true)
      : { x: 0, y: 0, rect: undefined, backendNodeId: undefined };
    if (target.backendNodeId !== undefined) {
      await cdp(session, 'DOM.focus', { backendNodeId: target.backendNodeId });
      if (input.clear === true) {
        await session.cdpHelper.selectAllAtCurrentFocus({
          ...(session.commandSignal ? { signal: session.commandSignal } : {}),
          ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
        });
        await this.dispatchKey(session, 'Backspace', []);
      }
    }
    const explicitText = typeof input.text === 'string' ? input.text : undefined;
    const text = explicitText ?? (await this.clipboardProvider.read()).text;
    if (text.length === 0 && typeof input.html !== 'string') {
      throw new Error('PASTE_REQUIRES_CONTENT');
    }
    if (typeof input.html === 'string' && text.length === 0) {
      throw new Error('PASTE_HTML_REQUIRES_PLAIN_TEXT_FALLBACK');
    }
    await cdp(session, 'Input.insertText', { text });
    const waitMs = Math.max(0, Math.floor(asNumber(input.waitMs, ACTION_SETTLE_DELAY_MS)));
    if (waitMs > 0) await delay(waitMs, session.commandSignal);
    this.invalidateObservation(session);
    return {
      success: true,
      durationMs: Date.now() - startedAt,
      target: { resolved: Boolean(targetInput), ...(target.rect ? { rect: target.rect } : {}) },
      effect: {
        dispatched: true,
        verified: false,
        verificationRequired: true,
        textLength: text.length,
      },
    };
  }

  protected async callBackendNode<T = unknown>(
    session: SessionState,
    backendNodeId: number,
    functionDeclaration: string,
    args: Array<Record<string, unknown>> = [],
  ): Promise<T> {
    const resolved = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('TARGET_NOT_RESOLVED');
    try {
      const result = await cdp<{
        result?: { value?: unknown };
        exceptionDetails?: CdpExceptionDetails;
      }>(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(describeCdpException(result.exceptionDetails, 'TARGET_SCRIPT_FAILED'));
      }
      return result.result?.value as T;
    } finally {
      await cdp(session, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

function isCoordinateLocator(input: Record<string, unknown>): boolean {
  return (
    (input.position !== undefined || input.normalized_position !== undefined) &&
    typeof input.ref !== 'string' &&
    typeof input.selector !== 'string'
  );
}
