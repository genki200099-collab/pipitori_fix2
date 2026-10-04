/* iPhone interaction layer v45. Game messages and rules remain in index.html. */
(() => {
  'use strict';
  const root = document.documentElement;
  const sheets = new Map();
  const gestures = new Map();
  const suppressed = new WeakMap();
  const sheetMedia = '(max-width: 720px), (max-height: 520px) and (pointer: coarse)';
  const actionSelector = '[data-card-id],[data-pass-card-id],[data-pass-submit],[data-initial-card-id],[data-initial-skip],[data-pick-index],[data-pick-target-card-id],[data-pick-target-submit],[data-pair-card-id],[data-pair-skip],.rule-help-btn';
  let scrollY = 0;
  let viewportFrame = 0;
  const editable = el => !!el?.matches?.('input:not([type="radio"]):not([type="checkbox"]):not([type="button"]),textarea,[contenteditable="true"]');

  function updateViewport() {
    viewportFrame = 0;
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const top = viewport?.offsetTop || 0;
    const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.05;
    const inset = !zoomed && editable(document.activeElement) ? Math.max(0, window.innerHeight - height - top) : 0;
    if (!zoomed) root.style.setProperty('--native-visible-height', `${height}px`);
    root.style.setProperty('--native-keyboard-inset', `${inset > 100 ? inset : 0}px`);
    document.body.classList.toggle('native-keyboard-open', inset > 100);
    // Avoid moving the page during pinch zoom or normal reading/scrolling.
    if (inset > 100 && !zoomed && !sheets.size) {
      const field = document.activeElement;
      const rect = field.getBoundingClientRect();
      if (rect.bottom > top + height - 20 || rect.top < top + 12) {
        field.scrollIntoView({block:'center', inline:'nearest', behavior:'auto'});
      }
    }
  }
  function scheduleViewport() {
    if (!viewportFrame) viewportFrame = requestAnimationFrame(updateViewport);
  }
  function openSheet(sheet, opener) {
    if (sheets.has(sheet)) return;
    if (!sheets.size) {
      scrollY = window.scrollY;
      document.body.style.setProperty('--native-page-top', `${-scrollY}px`);
      document.body.classList.add('native-sheet-open');
    }
    sheets.set(sheet, opener);
    if (opener?.matches?.('[data-game-panel],.rule-help-btn')) opener.setAttribute('aria-expanded','true');
    scheduleViewport();
  }
  function closeSheet(sheet) {
    if (!sheets.has(sheet)) return;
    const opener = sheets.get(sheet);
    sheets.delete(sheet);
    opener?.setAttribute?.('aria-expanded','false');
    if (!sheets.size) {
      document.body.classList.remove('native-sheet-open');
      document.body.style.removeProperty('--native-page-top');
      window.scrollTo({top:scrollY, left:0, behavior:'instant'});
    }
  }
  function allowAction(event) {
    if (event.type === 'click' && event.detail === 0) return true; // keyboard / assistive activation
    const target = event.target?.closest?.(actionSelector);
    return !target || (suppressed.get(target) || 0) <= Date.now();
  }
  // Track distance, cancellation and long press, without preventing native scroll.
  document.addEventListener('pointerdown', event => {
    if (event.isPrimary === false) { for (const gesture of gestures.values()) gesture.moved = true; return; }
    const target = event.target?.closest?.(actionSelector);
    if (!target || event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
    suppressed.delete(target);
    gestures.set(event.pointerId, {target, x:event.clientX, y:event.clientY, at:Date.now(), moved:false});
  }, {capture:true, passive:true});
  document.addEventListener('pointermove', event => {
    const gesture = gestures.get(event.pointerId);
    if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 12) gesture.moved = true;
  }, {capture:true, passive:true});
  function endGesture(event) {
    const gesture = gestures.get(event.pointerId);
    if (!gesture) return;
    const moved = gesture.moved || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 12;
    if (event.type === 'pointercancel' || moved || Date.now() - gesture.at >= 550) suppressed.set(gesture.target, Date.now() + 900);
    gestures.delete(event.pointerId);
  }
  document.addEventListener('pointerup', endGesture, {capture:true, passive:true});
  document.addEventListener('pointercancel', endGesture, {capture:true, passive:true});
  window.addEventListener('blur', () => gestures.clear());

  function bindDragHandle(handle) {
    const panel = handle.closest('.utility-sheet,.rule-help-panel');
    const sheet = handle.closest('#gameUtilityPanel,#ruleHelpModal');
    let drag = null;
    let ignoreClickUntil = 0;
    const reset = () => {
      const pointerId = drag?.id;
      drag = null;
      if (pointerId !== undefined && handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      panel.style.removeProperty('--native-drag-y');
      panel.classList.remove('native-dragging');
    };
    const dismiss = () => {
      if (sheet.id === 'gameUtilityPanel') window.closeGameUtilityPanel();
      else window.closeRuleHelp();
    };
    handle.addEventListener('pointerdown', event => {
      if (!window.matchMedia?.(sheetMedia).matches || event.isPrimary === false || event.button !== 0) return;
      drag = {id:event.pointerId, x:event.clientX, y:event.clientY, at:Date.now(), distance:0};
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (Math.abs(event.clientX - drag.x) > 32 && !drag.distance) { ignoreClickUntil = Date.now() + 500; reset(); return; }
      drag.distance = Math.max(0, event.clientY - drag.y);
      panel.classList.add('native-dragging');
      panel.style.setProperty('--native-drag-y', `${Math.min(220, drag.distance)}px`);
    });
    handle.addEventListener('pointerup', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const distance = Math.max(drag.distance, event.clientY - drag.y);
      const duration = Math.max(1, Date.now() - drag.at);
      const shouldClose = distance >= 96 || (distance >= 48 && distance / duration > 0.55) || (distance < 12 && duration < 550);
      ignoreClickUntil = Date.now() + 500;
      reset();
      if (shouldClose) dismiss();
    });
    handle.addEventListener('pointercancel', () => { ignoreClickUntil = Date.now() + 500; reset(); });
    handle.addEventListener('lostpointercapture', reset);
    handle.addEventListener('click', event => {
      event.preventDefault();
      if (event.detail !== 0 && Date.now() < ignoreClickUntil) return;
      dismiss();
    });
  }
  function setup() {
    document.querySelectorAll('[data-native-sheet-handle]').forEach(bindDragHandle);
    document.querySelectorAll('[data-game-panel]').forEach(button => {
      button.setAttribute('aria-controls','gameUtilityPanel');
      button.setAttribute('aria-expanded','false');
      button.setAttribute('aria-haspopup','dialog');
    });
    document.querySelectorAll('.rule-help-btn').forEach(button => {
      button.setAttribute('aria-controls','ruleHelpModal');
      button.setAttribute('aria-expanded','false');
      button.setAttribute('aria-haspopup','dialog');
    });
    window.visualViewport?.addEventListener('resize', scheduleViewport, {passive:true});
    window.visualViewport?.addEventListener('scroll', scheduleViewport, {passive:true});
    window.addEventListener('resize', scheduleViewport, {passive:true});
    document.addEventListener('focusin', scheduleViewport);
    document.addEventListener('focusout', scheduleViewport);
    scheduleViewport();
  }
  window.PipitoriNativeUI = {openSheet, closeSheet, allowAction};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, {once:true});
  else setup();
})();
