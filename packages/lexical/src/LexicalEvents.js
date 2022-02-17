/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type {LexicalEditor} from './LexicalEditor';
import type {RangeSelection} from './LexicalSelection';
import type {ElementNode} from './nodes/base/LexicalElementNode';
import type {TextNode} from './nodes/base/LexicalTextNode';

import {CAN_USE_BEFORE_INPUT, IS_FIREFOX} from 'shared/environment';

import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRootNode,
  $setCompositionKey,
} from '.';
import {
  $flushMutations,
  $isTokenOrInert,
  $setSelection,
  $shouldPreventDefaultAndInsertText,
  $updateSelectedTextFromDOM,
  getEditorsToPropagate,
  isBackspace,
  isBold,
  isDelete,
  isDeleteBackward,
  isDeleteForward,
  isDeleteLineBackward,
  isDeleteLineForward,
  isDeleteWordBackward,
  isDeleteWordForward,
  isEscape,
  isItalic,
  isLineBreak,
  isMoveBackward,
  isMoveDown,
  isMoveForward,
  isMoveUp,
  isOpenLineBreak,
  isParagraph,
  isRedo,
  isTab,
  isUnderline,
  isUndo,
} from './LexicalUtils';

type RootElementRemoveHandles = Array<() => void>;
type RootElementEvents = Array<
  [string, {} | ((event: Event, editor: LexicalEditor) => void)],
>;

const PASS_THROUGH_COMMAND = Object.freeze({});

const rootElementEvents: RootElementEvents = [
  // $FlowIgnore bad event inheritance
  ['keydown', onKeyDown],
  // $FlowIgnore bad event inheritance
  ['compositionstart', onCompositionStart],
  // $FlowIgnore bad event inheritance
  ['compositionend', onCompositionEnd],
  // $FlowIgnore bad event inheritance
  ['input', onInput],
  // $FlowIgnore bad event inheritance
  ['click', onClick],
  ['cut', PASS_THROUGH_COMMAND],
  ['copy', PASS_THROUGH_COMMAND],
  ['dragstart', PASS_THROUGH_COMMAND],
  ['paste', PASS_THROUGH_COMMAND],
  ['focus', PASS_THROUGH_COMMAND],
  ['blur', PASS_THROUGH_COMMAND],
];

if (CAN_USE_BEFORE_INPUT) {
  // $FlowIgnore bad event inheritance
  rootElementEvents.push(['beforeinput', onBeforeInput]);
} else {
  rootElementEvents.push(['drop', PASS_THROUGH_COMMAND]);
}

let lastKeyWasMaybeAndroidSoftKey = false;

function onSelectionChange(editor: LexicalEditor, isActive: boolean): void {
  editor.update(() => {
    // Non-active editor don't need any extra logic for selection, it only needs update
    // to reconcile selection (set it to null) to ensure that only one editor has non-null selection.
    if (!isActive) {
      $setSelection(null);
      return;
    }

    const selection = $getSelection();
    // Update the selection format
    if (selection !== null && selection.isCollapsed()) {
      const anchor = selection.anchor;
      if (anchor.type === 'text') {
        const anchorNode = anchor.getNode();
        selection.format = anchorNode.getFormat();
      } else if (anchor.type === 'element') {
        selection.format = 0;
      }
    }
    editor.execCommand('selectionChange');
  });
}

// This is a work-around is mainly Chrome specific bug where if you select
// the contents of an empty block, you cannot easily unselect anything.
// This results in a tiny selection box that looks buggy/broken. This can
// also help other browsers when selection might "appear" lost, when it
// really isn't.
function onClick(event: MouseEvent, editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection();
    if (selection === null) {
      return;
    }
    const anchor = selection.anchor;
    if (
      anchor.type === 'element' &&
      anchor.offset === 0 &&
      selection.isCollapsed() &&
      $getRoot().getChildrenSize() === 1 &&
      anchor.getNode().getTopLevelElementOrThrow().isEmpty()
    ) {
      const lastSelection = editor.getEditorState()._selection;
      if (lastSelection !== null && selection.is(lastSelection)) {
        window.getSelection().removeAllRanges();
        selection.dirty = true;
      }
    }
  });
}

function $applyTargetRange(selection: RangeSelection, event: InputEvent): void {
  if (event.getTargetRanges) {
    const targetRange = event.getTargetRanges()[0];

    if (targetRange) {
      selection.applyDOMRange(targetRange);
    }
  }
}

function $canRemoveText(
  anchorNode: TextNode | ElementNode,
  focusNode: TextNode | ElementNode,
): boolean {
  return (
    anchorNode !== focusNode ||
    $isElementNode(anchorNode) ||
    $isElementNode(focusNode) ||
    !$isTokenOrInert(anchorNode) ||
    !$isTokenOrInert(focusNode)
  );
}

function onBeforeInput(event: InputEvent, editor: LexicalEditor): void {
  const inputType = event.inputType;

  // We let the browser do its own thing for composition.
  if (
    inputType === 'deleteCompositionText' ||
    inputType === 'insertCompositionText'
  ) {
    return;
  }

  editor.update(() => {
    const selection = $getSelection();

    if (selection === null) {
      return;
    }

    if (inputType === 'deleteContentBackward') {
      // Used for Android
      $setCompositionKey(null);
      event.preventDefault();
      editor.execCommand('deleteCharacter', true);
      return;
    }
    const data = event.data;

    if (
      !selection.dirty &&
      selection.isCollapsed() &&
      !$isRootNode(selection.anchor.getNode())
    ) {
      $applyTargetRange(selection, event);
    }
    const anchor = selection.anchor;
    const focus = selection.focus;
    const anchorNode = anchor.getNode();
    const focusNode = focus.getNode();

    if (inputType === 'insertText') {
      if (data === '\n') {
        event.preventDefault();
        editor.execCommand('insertLineBreak');
      } else if (data === '\n\n') {
        event.preventDefault();
        editor.execCommand('insertParagraph');
      } else if (data == null && event.dataTransfer) {
        // Gets around a Safari text replacement bug.
        const text = event.dataTransfer.getData('text/plain');
        event.preventDefault();
        selection.insertRawText(text);
      } else if (
        data != null &&
        $shouldPreventDefaultAndInsertText(selection, data, true)
      ) {
        event.preventDefault();
        editor.execCommand('insertText', data);
      }
      return;
    }

    // Prevent the browser from carrying out
    // the input event, so we can control the
    // output.
    event.preventDefault();

    switch (inputType) {
      case 'insertFromYank':
      case 'insertFromDrop':
      case 'insertReplacementText': {
        editor.execCommand('insertText', event);
        break;
      }
      case 'insertFromComposition': {
        // This is the end of composition
        $setCompositionKey(null);
        editor.execCommand('insertText', event);
        break;
      }
      case 'insertLineBreak': {
        // Used for Android
        $setCompositionKey(null);
        editor.execCommand('insertLineBreak');
        break;
      }
      case 'insertParagraph': {
        // Used for Android
        $setCompositionKey(null);
        editor.execCommand('insertParagraph');
        break;
      }
      case 'insertFromPaste':
      case 'insertFromPasteAsQuotation': {
        editor.execCommand('paste', event);
        break;
      }
      case 'deleteByComposition': {
        if ($canRemoveText(anchorNode, focusNode)) {
          editor.execCommand('removeText');
        }
        break;
      }
      case 'deleteByDrag':
      case 'deleteByCut': {
        editor.execCommand('removeText');
        break;
      }
      case 'deleteContent': {
        editor.execCommand('deleteCharacter', false);
        break;
      }
      case 'deleteWordBackward': {
        editor.execCommand('deleteWord', true);
        break;
      }
      case 'deleteWordForward': {
        editor.execCommand('deleteWord', false);
        break;
      }
      case 'deleteHardLineBackward':
      case 'deleteSoftLineBackward': {
        editor.execCommand('deleteLine', true);
        break;
      }
      case 'deleteContentForward':
      case 'deleteHardLineForward':
      case 'deleteSoftLineForward': {
        editor.execCommand('deleteLine', false);
        break;
      }
      case 'formatStrikeThrough': {
        editor.execCommand('formatText', 'strikethrough');
        break;
      }
      case 'formatBold': {
        editor.execCommand('formatText', 'bold');
        break;
      }
      case 'formatItalic': {
        editor.execCommand('formatText', 'italic');
        break;
      }
      case 'formatUnderline': {
        editor.execCommand('formatText', 'underline');
        break;
      }
      case 'historyUndo': {
        editor.execCommand('undo');
        break;
      }
      case 'historyRedo': {
        editor.execCommand('redo');
        break;
      }
      default:
      // NO-OP
    }
  });
}

function onInput(event: InputEvent, editor: LexicalEditor): void {
  // We don't want the onInput to bubble, in the case of nested editors.
  event.stopPropagation();
  editor.update(() => {
    const selection = $getSelection();
    const data = event.data;
    if (
      data != null &&
      selection !== null &&
      $shouldPreventDefaultAndInsertText(selection, data, false)
    ) {
      editor.execCommand('insertText', data);
    } else {
      $updateSelectedTextFromDOM(editor, false);
    }
    // Also flush any other mutations that might have occured
    // since the change.
    $flushMutations();
  });
}

function onCompositionStart(
  event: CompositionEvent,
  editor: LexicalEditor,
): void {
  editor.update(() => {
    const selection = $getSelection();
    if (selection !== null && !editor.isComposing()) {
      const anchor = selection.anchor;
      $setCompositionKey(anchor.key);
      if (
        !lastKeyWasMaybeAndroidSoftKey ||
        anchor.type === 'element' ||
        !selection.isCollapsed()
      ) {
        // We insert an empty space, ready for the composition
        // to get inserted into the new node we create. If
        // we don't do this, Safari will fail on us because
        // there is no text node matching the selection.
        editor.execCommand('insertText', ' ');
      }
    }
  });
}

function onCompositionEndInternal(
  event: CompositionEvent,
  editor: LexicalEditor,
): void {
  editor.update(() => {
    $setCompositionKey(null);
    $updateSelectedTextFromDOM(editor, true);
  });
}

function onCompositionEnd(
  event: CompositionEvent,
  editor: LexicalEditor,
): void {
  if (IS_FIREFOX) {
    // The order of onInput and onCompositionEnd is different
    // in FF. Given that onInput will fire after onCompositionEnd
    // in FF, we need to defer the $logic for onCompositionEnd to
    // ensure that any possible onInput events fire before.
    setTimeout(() => {
      onCompositionEndInternal(event, editor);
    }, 0);
  } else {
    onCompositionEndInternal(event, editor);
  }
}

function updateAndroidSoftKeyFlagIfAny(event: KeyboardEvent): void {
  lastKeyWasMaybeAndroidSoftKey =
    event.key === 'Unidentified' && event.keyCode === 229;
}

function onKeyDown(event: KeyboardEvent, editor: LexicalEditor): void {
  updateAndroidSoftKeyFlagIfAny(event);
  if (editor.isComposing()) {
    return;
  }
  const {keyCode, shiftKey, ctrlKey, metaKey, altKey} = event;

  if (isMoveForward(keyCode, ctrlKey, shiftKey, altKey, metaKey)) {
    editor.execCommand('keyArrowRight', event);
  } else if (isMoveBackward(keyCode, ctrlKey, shiftKey, altKey, metaKey)) {
    editor.execCommand('keyArrowLeft', event);
  } else if (isMoveUp(keyCode, ctrlKey, shiftKey, altKey, metaKey)) {
    editor.execCommand('keyArrowUp', event);
  } else if (isMoveDown(keyCode, ctrlKey, shiftKey, altKey, metaKey)) {
    editor.execCommand('keyArrowDown', event);
  } else if (isLineBreak(keyCode, shiftKey)) {
    editor.execCommand('keyEnter', event);
  } else if (isOpenLineBreak(keyCode, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('insertLineBreak', true);
  } else if (isParagraph(keyCode, shiftKey)) {
    editor.execCommand('keyEnter', event);
  } else if (isDeleteBackward(keyCode, altKey, metaKey, ctrlKey)) {
    if (isBackspace(keyCode)) {
      editor.execCommand('keyBackspace', event);
    } else {
      editor.execCommand('deleteCharacter', true);
    }
  } else if (isEscape(keyCode)) {
    editor.execCommand('keyEscape', event);
  } else if (isDeleteForward(keyCode, ctrlKey, shiftKey, altKey, metaKey)) {
    if (isDelete(keyCode)) {
      editor.execCommand('keyDelete', event);
    } else {
      event.preventDefault();
      editor.execCommand('deleteCharacter', false);
    }
  } else if (isDeleteWordBackward(keyCode, altKey, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('deleteWord', true);
  } else if (isDeleteWordForward(keyCode, altKey, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('deleteWord', false);
  } else if (isDeleteLineBackward(keyCode, metaKey)) {
    event.preventDefault();
    editor.execCommand('deleteLine', true);
  } else if (isDeleteLineForward(keyCode, metaKey)) {
    event.preventDefault();
    editor.execCommand('deleteLine', false);
  } else if (isBold(keyCode, metaKey, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('formatText', 'bold');
  } else if (isUnderline(keyCode, metaKey, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('formatText', 'underline');
  } else if (isItalic(keyCode, metaKey, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('formatText', 'italic');
  } else if (isTab(keyCode, altKey, ctrlKey, metaKey)) {
    editor.execCommand('keyTab', event);
  } else if (isUndo(keyCode, shiftKey, metaKey, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('undo');
  } else if (isRedo(keyCode, shiftKey, metaKey, ctrlKey)) {
    event.preventDefault();
    editor.execCommand('redo');
  }
}

function isRootEditable(editor: LexicalEditor): boolean {
  const rootElement = editor.getRootElement();
  return rootElement !== null && rootElement.contentEditable === 'true';
}

function getRootElementRemoveHandles(
  rootElement: HTMLElement,
): RootElementRemoveHandles {
  // $FlowFixMe: internal field
  let eventHandles = rootElement._lexicalEventHandles;
  if (eventHandles === undefined) {
    eventHandles = [];
    // $FlowFixMe: internal field
    rootElement._lexicalEventHandles = eventHandles;
  }
  return eventHandles;
}

function clearRootElementRemoveHandles(rootElement: HTMLElement): void {
  // $FlowFixMe: internal field
  rootElement._lexicalEventHandles = [];
}

// Mapping root editors to their active nested editors, contains nested editors
// mapping only, so if root editor is selected map will have no reference to free up memory
const activeNestedEditorsMap: Map<string, LexicalEditor> = new Map();

function onDocumentSelectionChange(event: Event): void {
  const sel = window.getSelection();
  let node = sel.anchorNode;
  while (node != null) {
    if (node.contentEditable === 'true') {
      const nextActiveEditor = node.__lexicalEditor;
      if (nextActiveEditor !== undefined) {
        // When editor receives selection change event, we're checking if
        // it has any sibling editors (within same parent editor) that were active
        // before, and trigger selection change on it to nullify selection.
        const editors = getEditorsToPropagate(nextActiveEditor);
        const rootEditor = editors[editors.length - 1];
        const rootEditorKey = rootEditor._key;
        const activeNestedEditor = activeNestedEditorsMap.get(rootEditorKey);
        const prevActiveEditor = activeNestedEditor || rootEditor;

        if (prevActiveEditor !== nextActiveEditor) {
          onSelectionChange(prevActiveEditor, false);
        }

        onSelectionChange(nextActiveEditor, true);

        // If newly selected editor is nested, then add it to the map, clean map otherwise
        if (nextActiveEditor !== rootEditor) {
          activeNestedEditorsMap.set(rootEditorKey, nextActiveEditor);
        } else if (activeNestedEditor) {
          activeNestedEditorsMap.delete(rootEditorKey);
        }
        return;
      }
    }
    node = node.parentNode;
  }
}

export function addDocumentSelectionChangeEvent(
  rootElement: HTMLElement,
  editor: LexicalEditor,
): void {
  const doc = rootElement.ownerDocument;
  // $FlowFixMe: internal field
  rootElement.__lexicalEditor = editor;
  // $FlowFixMe: internal field
  if (doc._lexicalEvent === undefined) {
    // $FlowFixMe: internal field
    doc._lexicalEvent = true;
    doc.addEventListener('selectionchange', onDocumentSelectionChange);
  }
}

export function addRootElementEvents(
  rootElement: HTMLElement,
  editor: LexicalEditor,
): void {
  const removeHandles = getRootElementRemoveHandles(rootElement);

  for (let i = 0; i < rootElementEvents.length; i++) {
    const [eventName, onEvent] = rootElementEvents[i];
    const eventHandler =
      typeof onEvent === 'function'
        ? (event: Event) => {
            if (isRootEditable(editor)) {
              onEvent(event, editor);
            }
          }
        : (event: Event) => {
            if (isRootEditable(editor)) {
              editor.execCommand(eventName, event);
            }
          };
    rootElement.addEventListener(eventName, eventHandler);
    removeHandles.push(() => {
      rootElement.removeEventListener(eventName, eventHandler);
    });
  }
}

export function removeRootElementEvents(rootElement: HTMLElement): void {
  // $FlowFixMe: internal field
  cleanActiveNestedEditorsMap(rootElement.__lexicalEditor);
  // $FlowFixMe: internal field
  rootElement.__lexicalEditor = null;
  const removeHandles = getRootElementRemoveHandles(rootElement);
  for (let i = 0; i < removeHandles.length; i++) {
    removeHandles[i]();
  }
  clearRootElementRemoveHandles(rootElement);
}

function cleanActiveNestedEditorsMap(editor: LexicalEditor) {
  // $FlowFixMe: internal field
  if (editor._parentEditor) {
    // For nested editor cleanup map if this editor was marked as active
    const editors = getEditorsToPropagate(editor);
    const rootEditor = editors[editors.length - 1];
    const rootEditorKey = rootEditor._key;
    if (activeNestedEditorsMap.get(rootEditorKey) === editor) {
      activeNestedEditorsMap.delete(rootEditorKey);
    }
  } else {
    // For top-level editors cleanup map
    activeNestedEditorsMap.delete(editor._key);
  }
}