/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import * as Strings from './Strings';
import { ITerminal, IBuffer } from './Types';
import { isMac } from './shared/utils/Browser';
import { RenderDebouncer } from './utils/RenderDebouncer';
import { addDisposableListener } from './utils/Dom';
import { IDisposable } from 'xterm';

const MAX_ROWS_TO_READ = 20;

const enum BoundaryPosition {
  TOP,
  BOTTOM
}

export class AccessibilityManager implements IDisposable {
  private _accessibilityTreeRoot: HTMLElement;
  private _rowContainer: HTMLElement;
  private _rowElements: HTMLElement[];
  private _liveRegion: HTMLElement;
  private _liveRegionLineCount: number = 0;

  private _renderRowsDebouncer: RenderDebouncer;

  private _topBoundaryFocusListener: (e: FocusEvent) => void;
  private _bottomBoundaryFocusListener: (e: FocusEvent) => void;

  private _disposables: IDisposable[] = [];

  /**
   * This queue has a character pushed to it for keys that are pressed, if the
   * next character added to the terminal is equal to the key char then it is
   * not announced (added to live region) because it has already been announced
   * by the textarea event (which cannot be canceled). There are some race
   * condition cases if there is typing while data is streaming, but this covers
   * the main case of typing into the prompt and inputting the answer to a
   * question (Y/N, etc.).
   */
  private _charsToConsume: string[] = [];

  constructor(private _terminal: ITerminal) {
    this._accessibilityTreeRoot = document.createElement('div');
    this._accessibilityTreeRoot.classList.add('xterm-accessibility');

    this._rowContainer = document.createElement('div');
    this._rowContainer.classList.add('xterm-accessibility-tree');
    this._rowElements = [];
    for (let i = 0; i < this._terminal.rows; i++) {
      this._rowElements[i] = this._createAccessibilityTreeNode();
      this._rowContainer.appendChild(this._rowElements[i]);
    }

    this._topBoundaryFocusListener = e => this._onBoundaryFocus(e, BoundaryPosition.TOP);
    this._bottomBoundaryFocusListener = e => this._onBoundaryFocus(e, BoundaryPosition.BOTTOM);
    this._rowElements[0].addEventListener('focus', this._topBoundaryFocusListener);
    this._rowElements[this._rowElements.length - 1].addEventListener('focus', this._bottomBoundaryFocusListener);

    this._refreshRowsDimensions();
    this._accessibilityTreeRoot.appendChild(this._rowContainer);

    this._renderRowsDebouncer = new RenderDebouncer(this._terminal, this._renderRows.bind(this));
    this._refreshRows();

    this._liveRegion = document.createElement('div');
    this._liveRegion.classList.add('live-region');
    this._liveRegion.setAttribute('aria-live', 'assertive');
    this._accessibilityTreeRoot.appendChild(this._liveRegion);

    this._terminal.element.insertAdjacentElement('afterbegin', this._accessibilityTreeRoot);

    this._disposables.push(this._renderRowsDebouncer);
    this._disposables.push(this._terminal.addDisposableListener('resize', data => this._onResize(data.cols, data.rows)));
    this._disposables.push(this._terminal.addDisposableListener('refresh', data => this._refreshRows(data.start, data.end)));
    this._disposables.push(this._terminal.addDisposableListener('scroll', data => this._refreshRows()));
    // Line feed is an issue as the prompt won't be read out after a command is run
    this._disposables.push(this._terminal.addDisposableListener('a11y.char', (char) => this._onChar(char)));
    this._disposables.push(this._terminal.addDisposableListener('linefeed', () => this._onChar('\n')));
    this._disposables.push(this._terminal.addDisposableListener('a11y.tab', spaceCount => this._onTab(spaceCount)));
    this._disposables.push(this._terminal.addDisposableListener('key', keyChar => this._onKey(keyChar)));
    this._disposables.push(this._terminal.addDisposableListener('blur', () => this._clearLiveRegion()));
    // TODO: Maybe renderer should fire an event on terminal when the characters change and that
    //       should be listened to instead? That would mean that the order of events are always
    //       guarenteed
    this._disposables.push(this._terminal.addDisposableListener('dprchange', () => this._refreshRowsDimensions()));
    this._disposables.push(this._terminal.renderer.addDisposableListener('resize', () => this._refreshRowsDimensions()));
    // This shouldn't be needed on modern browsers but is present in case the
    // media query that drives the dprchange event isn't supported
    this._disposables.push(addDisposableListener(window, 'resize', () => this._refreshRowsDimensions()));
  }

  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables.length = 0;
    this._terminal.element.removeChild(this._accessibilityTreeRoot);
    this._rowElements.length = 0;
  }

  private _onBoundaryFocus(e: FocusEvent, position: BoundaryPosition): void {
    const boundaryElement = <HTMLElement>e.target;
    const beforeBoundaryElement = this._rowElements[position === BoundaryPosition.TOP ? 1 : this._rowElements.length - 2];

    // Don't scroll if the buffer top has reached the end in that direction
    const posInSet = boundaryElement.getAttribute('aria-posinset');
    const lastRowPos = position === BoundaryPosition.TOP ? '1' : `${this._terminal.buffer.lines.length}`;
    if (posInSet === lastRowPos) {
      return;
    }

    // Don't scroll when the last focused item was not the second row (focus is going the other
    // direction)
    if (e.relatedTarget !== beforeBoundaryElement) {
      return;
    }

    // Remove old boundary element from array
    let topBoundaryElement: HTMLElement;
    let bottomBoundaryElement: HTMLElement;
    if (position === BoundaryPosition.TOP) {
      topBoundaryElement = boundaryElement;
      bottomBoundaryElement = this._rowElements.pop()!;
      this._rowContainer.removeChild(bottomBoundaryElement);
    } else {
      topBoundaryElement = this._rowElements.shift()!;
      bottomBoundaryElement = boundaryElement;
      this._rowContainer.removeChild(topBoundaryElement);
    }

    // Remove listeners from old boundary elements
    topBoundaryElement.removeEventListener('focus', this._topBoundaryFocusListener);
    bottomBoundaryElement.removeEventListener('focus', this._bottomBoundaryFocusListener);

    // Add new element to array/DOM
    if (position === BoundaryPosition.TOP) {
      const newElement = this._createAccessibilityTreeNode();
      this._rowElements.unshift(newElement);
      this._rowContainer.insertAdjacentElement('afterbegin', newElement);
    } else {
      const newElement = this._createAccessibilityTreeNode();
      this._rowElements.push(newElement);
      this._rowContainer.appendChild(newElement);
    }

    // Add listeners to new boundary elements
    this._rowElements[0].addEventListener('focus', this._topBoundaryFocusListener);
    this._rowElements[this._rowElements.length - 1].addEventListener('focus', this._bottomBoundaryFocusListener);

    // Scroll up
    this._terminal.scrollLines(position === BoundaryPosition.TOP ? -1 : 1);

    // Focus new boundary before element
    this._rowElements[position === BoundaryPosition.TOP ? 1 : this._rowElements.length - 2].focus();

    // Prevent the standard behavior
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private _onResize(cols: number, rows: number): void {
    // Remove bottom boundary listener
    this._rowElements[this._rowElements.length - 1].removeEventListener('focus', this._bottomBoundaryFocusListener);

    // Grow rows as required
    for (let i = this._rowContainer.children.length; i < this._terminal.rows; i++) {
      this._rowElements[i] = this._createAccessibilityTreeNode();
      this._rowContainer.appendChild(this._rowElements[i]);
    }
    // Shrink rows as required
    while (this._rowElements.length > rows) {
      this._rowContainer.removeChild(this._rowElements.pop()!);
    }

    // Add bottom boundary listener
    this._rowElements[this._rowElements.length - 1].addEventListener('focus', this._bottomBoundaryFocusListener);

    this._refreshRowsDimensions();
  }

  public _createAccessibilityTreeNode(): HTMLElement {
    const element = document.createElement('div');
    element.setAttribute('role', 'listitem');
    element.tabIndex = -1;
    this._refreshRowDimensions(element);
    return element;
  }

  private _onTab(spaceCount: number): void {
    for (let i = 0; i < spaceCount; i++) {
      this._onChar(' ');
    }
  }

  private _onChar(char: string): void {
    if (this._liveRegionLineCount < MAX_ROWS_TO_READ + 1) {
      if (this._charsToConsume.length > 0) {
        // Have the screen reader ignore the char if it was just input
        const shiftedChar = this._charsToConsume.shift();
        if (shiftedChar !== char) {
          this._announceCharacter(char);
        }
      } else {
        this._announceCharacter(char);
      }

      if (char === '\n') {
        this._liveRegionLineCount++;
        if (this._liveRegionLineCount === MAX_ROWS_TO_READ + 1) {
          this._liveRegion.textContent += Strings.tooMuchOutput;
        }
      }

      // Only detach/attach on mac as otherwise messages can go unaccounced
      if (isMac) {
        if (this._liveRegion.textContent && this._liveRegion.textContent.length > 0 && !this._liveRegion.parentNode) {
          setTimeout(() => {
            this._accessibilityTreeRoot.appendChild(this._liveRegion);
          }, 0);
        }
      }
    }
  }

  private _clearLiveRegion(): void {
    this._liveRegion.textContent = '';
    this._liveRegionLineCount = 0;

    // Only detach/attach on mac as otherwise messages can go unaccounced
    if (isMac) {
      if (this._liveRegion.parentNode) {
        this._accessibilityTreeRoot.removeChild(this._liveRegion);
      }
    }
  }

  private _onKey(keyChar: string): void {
    this._clearLiveRegion();
    this._charsToConsume.push(keyChar);
  }

  private _refreshRows(start?: number, end?: number): void {
    this._renderRowsDebouncer.refresh(start, end);
  }

  private _renderRows(start: number, end: number): void {
    const buffer: IBuffer = this._terminal.buffer;
    const setSize = buffer.lines.length.toString();
    for (let i = start; i <= end; i++) {
      const lineData = buffer.translateBufferLineToString(buffer.ydisp + i, true);
      const posInSet = (buffer.ydisp + i + 1).toString();
      const element = this._rowElements[i];
      element.textContent = lineData.length === 0 ? Strings.blankLine : lineData;
      element.setAttribute('aria-posinset', posInSet);
      element.setAttribute('aria-setsize', setSize);
    }
  }

  private _refreshRowsDimensions(): void {
    if (!this._terminal.renderer.dimensions.actualCellHeight) {
      return;
    }
    for (let i = 0; i < this._terminal.rows; i++) {
      this._refreshRowDimensions(this._rowElements[i]);
    }
  }

  private _refreshRowDimensions(element: HTMLElement): void {
    element.style.height = `${this._terminal.renderer.dimensions.actualCellHeight}px`;
  }

  private _announceCharacter(char: string): void {
    if (char === ' ') {
      // Always use nbsp for spaces in order to preserve the space between characters in
      // voiceover's caption window
      this._liveRegion.innerHTML += '&nbsp;';
    } else {
      this._liveRegion.textContent += char;
    }
  }
}
