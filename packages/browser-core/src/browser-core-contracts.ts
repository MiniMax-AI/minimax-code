/** Provider-neutral page semantics used by Electron and native-headless. */

export interface BrowserDOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  nodeType: number;
  nodeValue?: string;
  attributes?: string[];
  children?: BrowserDOMNode[];
  shadowRoots?: BrowserDOMNode[];
  contentDocument?: BrowserDOMNode;
  frameId?: string;
}

export interface BrowserAXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  properties?: Array<{
    name: string;
    value?: { value?: unknown };
  }>;
  childIds?: string[];
  ignored?: boolean;
}

export interface BrowserSnapshotNode {
  bounds: { x: number; y: number; width: number; height: number } | null;
  coordinateSpace: 'main-frame-viewport' | 'frame-local' | 'unavailable';
  computedStyles: Record<string, string>;
  isClickable: boolean;
  paintOrder: number | null;
  frameId?: string;
  formState?: BrowserFormState;
}

/**
 * Live form-control state (`beta.browserReadV2`): what the page currently holds,
 * which can differ from the serialized `value`/`checked`/`selected` attributes
 * after scripts or the user changed it. Credential fields never carry a value.
 */
export interface BrowserFormState {
  /** input/textarea current value; select: value of the first selected option. */
  value?: string;
  valueTruncated?: true;
  /** checkbox/radio current checkedness. */
  checked?: boolean;
  /** select: label of the first selected option. */
  selectedText?: string;
  /** select: number of selected options, only when more than one. */
  selectedCount?: number;
}

export interface BrowserInteractiveElement {
  index: number;
  backendNodeId: number;
  frameId?: string;
  commandSessionId?: string;
  frameOffset?: { x: number; y: number };
  selector: string;
  tag: string;
  type: string;
  text: string;
  normalizedPosition: { x: number; y: number };
  boundingBox: { x: number; y: number; width: number; height: number };
  coordinateSpace?: 'main-frame-viewport' | 'unavailable';
  isInViewport: boolean;
  isInteractable: boolean;
  attributes: Record<string, string>;
  paintOrder?: number;
  inputStrategy?: 'focused-keyboard';
  semanticBackendNodeId?: number;
  /** Present only for scans that request live form state. */
  formState?: BrowserFormState;
}

export type BrowserWaitState = 'attached' | 'detached' | 'visible' | 'hidden';

export type BrowserWaitInput =
  | { kind: 'timeout'; timeout: number }
  | { kind: 'selector'; selector: string; state?: BrowserWaitState; timeout?: number }
  | { kind: 'text'; text: string; timeout?: number }
  | { kind: 'url'; url: string; timeout?: number }
  | { kind: 'load'; timeout?: number };

export type DOMNode = BrowserDOMNode;
export type AXNode = BrowserAXNode;
export type SnapshotNode = BrowserSnapshotNode;
export type InteractiveElement = BrowserInteractiveElement;
