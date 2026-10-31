import { BrowserActionSupport } from './browser-actions.js';
import {
  asNumber,
  cdp,
  type CdpExceptionDetails,
  delay,
  describeCdpException,
  stringArray,
  type BrowserSessionState as SessionState,
} from './browser-state.js';
import { IsolatedClipboardProvider, type ClipboardProvider } from './clipboard.js';

const ACTION_SETTLE_DELAY_MS = 100;

interface CheckableState {
  checkable: boolean;
  checked: boolean;
}

interface SelectMutationState {
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
      `function () {
        const type = this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : '';
        const checkable = type === 'checkbox' || type === 'radio';
        return { checkable, checked: checkable ? Boolean(this.checked) : false };
      }`,
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
    if (before.checked !== checked) {
      await session.beforePointerAction?.(
        { action: checked ? 'check' : 'uncheck', point: { x: target.x, y: target.y } },
        session.commandSignal,
      );
      await this.dispatchMouse(session, target.x, target.y, 'mouseMoved');
      await delay(50, session.commandSignal);
      await this.dispatchMouse(session, target.x, target.y, 'mousePressed', {
        button: 'left',
        clickCount: 1,
      });
      await this.dispatchMouse(session, target.x, target.y, 'mouseReleased', {
        button: 'left',
        clickCount: 1,
      });
      await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    }
    const after = await this.callBackendNode<CheckableState>(
      session,
      target.backendNodeId,
      `function () {
        const type = this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : '';
        const checkable = type === 'checkbox' || type === 'radio';
        return { checkable, checked: checkable ? Boolean(this.checked) : false };
      }`,
    );
    const dispatched = before.checked !== checked;
    const verified = after?.checkable === true && after.checked === checked;
    this.invalidateObservation(session);
    const result = {
      success: verified,
      durationMs: Date.now() - startedAt,
      target: { resolved: true, rect: target.rect },
      effect: { dispatched, verified, checked: after?.checked },
    } as Record<string, unknown>;
    if (!verified) {
      result.code = after?.checkable === false ? 'TARGET_NOT_CHECKABLE' : 'CHECK_STATE_NOT_APPLIED';
      result.error =
        after?.checkable === false
          ? 'Browser check target is no longer a checkbox or radio input.'
          : `Browser ${checked ? 'check' : 'uncheck'} was dispatched, but the requested state was not retained.`;
      result.recovery =
        'Inspect the current target state before retrying; the page may reject or control this field.';
    }
    return result;
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
    const mutation = await this.callBackendNode<SelectMutationState>(
      session,
      target.backendNodeId,
      `function (wanted) {
        if (!(this instanceof HTMLSelectElement)) {
          return {
            selectable: false,
            multiple: false,
            missingValues: [],
            selectedValues: [],
          };
        }
        const requestedEntries = Array.from(
          new Set(Array.isArray(wanted) ? wanted.map(String) : []),
        );
        const options = Array.from(this.options || []);
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
          const matchedValues = Array.from(
            new Set(labelMatches.map((option) => String(option.value))),
          );
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
            selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
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
            selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
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
          selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
          resolvedValues: values,
        };
      }`,
      [{ value: values }],
    );
    if (!mutation?.selectable) {
      return {
        success: false,
        code: 'TARGET_NOT_SELECT',
        error: 'Browser select_option target is not a select element.',
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
        effect: { dispatched: false, verified: false, selectedValues: [] },
      };
    }
    if ((mutation.resolvedValues ?? values).length > 1 && mutation.multiple !== true) {
      return {
        success: false,
        code: 'SELECT_MULTIPLE_VALUES_NOT_ALLOWED',
        error: 'Browser select_option received multiple values for a single-select element.',
        durationMs: Date.now() - startedAt,
        target: { resolved: true, rect: target.rect },
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
          rect: target.rect,
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
          rect: target.rect,
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
    await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    const after = await this.callBackendNode<SelectState>(
      session,
      target.backendNodeId,
      `function () {
        if (!(this instanceof HTMLSelectElement)) {
          return { selectable: false, multiple: false, selectedValues: [] };
        }
        return {
          selectable: true,
          multiple: Boolean(this.multiple),
          selectedValues: Array.from(this.selectedOptions, (option) => String(option.value)),
        };
      }`,
    );
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
          : 'Browser select_option was dispatched, but the requested selection was not retained.';
      result.recovery =
        'Inspect the current selected value before retrying; the page may reject or control this field.';
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
      result.retryable = true;
      result.recovery =
        'Inspect the current page before deciding whether the upload should be repeated.';
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
      ? await this.resolveTarget(session, targetInput, true, false)
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
