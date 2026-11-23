/* Interactive prototype engine: click-through, presentation, and review comments. */
(function () {
  'use strict';

  var prototypeId = document.documentElement.getAttribute('data-prototype-id') || 'prototype';
  var threadsStorageKey = 'om-prototype-comments:v2:' + prototypeId;
  var authorStorageKey = 'om-prototype-author';
  var committedDocument = normalizeDocument(window.__OM_PROTOTYPE_COMMENTS__);
  var committedOperations = clone(committedDocument.operations);
  deepFreeze(committedOperations);
  var committedOperationIds = new Set(committedOperations.map(function (operation) { return operation.id; }));
  var localOperations = normalizeOperations(load(threadsStorageKey, { version: 2, operations: [] }).operations)
    .filter(function (operation) { return !committedOperationIds.has(operation.id); });
  var author = load(authorStorageKey, '');
  var threads = [];
  var mode = 'read';
  var focusMode = false;
  var pinsVisible = true;
  var activeId = null;
  var pending = null;
  var reanchorThreadId = null;
  var history = [];
  var panel;
  var panelBody;
  var authorInput;
  var readModeButton;
  var commentModeButton;
  var toastTimer;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return value;
  }

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function save() {
    try {
      localStorage.setItem(threadsStorageKey, JSON.stringify({ version: 2, operations: localOperations }));
      localStorage.setItem(authorStorageKey, JSON.stringify(author));
    } catch (error) {
      return;
    }
  }

  // A committed document that does not belong to this page is dropped rather than shown against
  // the wrong screens — but never silently. A stale prototypeId (a renamed directory, a file
  // copied from another storyboard) otherwise looks exactly like "nobody has commented yet".
  function normalizeDocument(value) {
    var empty = { version: 2, prototypeId: prototypeId, operations: [] };
    if (!value) return empty;
    if (value.version !== 2 || !Array.isArray(value.operations)) {
      warn('comments.js is not a version 2 document with an operations array. Committed review comments were ignored.');
      return empty;
    }
    if (value.prototypeId && value.prototypeId !== prototypeId) {
      warn('comments.js is for prototype "' + value.prototypeId + '" but this page is "' + prototypeId +
        '". Committed review comments were ignored. Set prototypeId in comments.js to "' + prototypeId + '" and re-run generate.mjs.');
      return empty;
    }
    return { version: 2, prototypeId: prototypeId, operations: normalizeOperations(value.operations) };
  }

  function warn(message) {
    if (window.console && typeof console.warn === 'function') console.warn('[storyboard] ' + message);
  }

  function normalizeOperations(operations) {
    var seen = new Set();
    return (Array.isArray(operations) ? operations : []).filter(function (operation) {
      if (!operation || typeof operation.id !== 'string' || seen.has(operation.id)) return false;
      if (!operation.threadId || !operation.type || !operation.at) return false;
      seen.add(operation.id);
      return true;
    });
  }

  function allOperations() {
    return normalizeOperations(committedOperations.concat(localOperations)).sort(function (left, right) {
      return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
    });
  }

  function applyOperations() {
    var byId = new Map();
    var order = [];
    allOperations().forEach(function (operation) {
      var thread = byId.get(operation.threadId);
      if (operation.type === 'create') {
        if (thread || !operation.payload || !operation.payload.message) return;
        thread = {
          id: operation.threadId,
          screen: operation.payload.screen,
          anchor: operation.payload.anchor,
          label: operation.payload.label,
          resolved: false,
          messages: [operation.payload.message],
          deletedAt: null
        };
        byId.set(thread.id, thread);
        order.push(thread.id);
        return;
      }
      if (!thread) return;
      if (operation.type === 'delete') {
        thread.deletedAt = operation.at;
        return;
      }
      if (thread.deletedAt) return;
      if (operation.type === 'reply' && operation.payload && operation.payload.message) {
        var messageExists = thread.messages.some(function (message) {
          return message.id === operation.payload.message.id;
        });
        if (!messageExists) thread.messages.push(operation.payload.message);
      }
      if (operation.type === 'set-resolved' && operation.payload) {
        thread.resolved = !!operation.payload.resolved;
      }
      if (operation.type === 'reanchor' && operation.payload) {
        thread.screen = operation.payload.screen;
        thread.anchor = operation.payload.anchor;
        thread.label = operation.payload.label;
      }
    });
    threads = order.map(function (threadId) { return byId.get(threadId); })
      .filter(function (thread) { return thread && !thread.deletedAt; });
  }

  function addOperation(type, threadId, payload) {
    localOperations.push({
      id: newId('op'),
      type: type,
      threadId: threadId,
      at: new Date().toISOString(),
      payload: payload || {}
    });
    save();
    applyOperations();
  }

  function hasLocalChanges(threadId) {
    return localOperations.some(function (operation) { return operation.threadId === threadId; });
  }

  function element(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      if (key === 'class') node.className = props[key];
      else if (key === 'text') node.textContent = props[key];
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), props[key]);
      else node.setAttribute(key, props[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function nowStamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function newId(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return prefix + '-' + window.crypto.randomUUID();
    }
    return prefix + '-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function screens() {
    return Array.prototype.slice.call(document.querySelectorAll('.screen'));
  }

  function goTo(screenId, record) {
    var target = document.getElementById(screenId);
    if (!target) {
      flashToast('This screen does not exist in the prototype: ' + screenId);
      return;
    }
    markCurrentScreen(screenId);
    // Keep the URL on the screen in view so it stays linkable. replaceState rather than
    // location.hash, which would jump the page and fight the smooth scroll; `history` here is
    // this module's own back stack, hence window.history. A file:// page refuses it.
    try { window.history.replaceState(null, '', '#' + screenId); } catch (error) { /* opaque origin */ }
    if (record !== false) {
      var current = document.querySelector('.screen.is-current');
      if (current && current.id !== screenId) history.push(current.id);
    }
    // .is-current is the screen presentation mode shows, and it moves in both modes: leaving it
    // behind in normal mode would reopen the presentation on a screen the reader has since
    // scrolled away from. Only the CSS under body.proto-focus reads the class.
    screens().forEach(function (screen) { screen.classList.remove('is-current'); });
    target.classList.add('is-current');
    if (focusMode) window.scrollTo(0, 0);
    else target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('proto-arrived');
    void target.offsetWidth;
    target.classList.add('proto-arrived');
    updateBackButton();
  }

  // The screen switcher sits inside .doc-toolbar, which onDocumentClick skips so that a toolbar
  // click never anchors a review comment — so it cannot be a [data-goto] hotspot. Bind it here
  // instead: in presentation mode only goTo() moves .is-current, and a bare #sN anchor would
  // leave the screen you clicked hidden.
  function prepareScreenNav() {
    navLinks().forEach(function (link) {
      link.addEventListener('click', function (event) {
        var screenId = link.getAttribute('href').slice(1);
        if (!document.getElementById(screenId)) return;
        event.preventDefault();
        goTo(screenId);
      });
    });
  }

  function navLinks() {
    return Array.prototype.slice.call(document.querySelectorAll('.screen-nav a[href^="#"]'));
  }

  function markCurrentScreen(screenId) {
    navLinks().forEach(function (link) {
      if (link.getAttribute('href').slice(1) === screenId) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function goBack() {
    var previous = history.pop();
    if (previous) goTo(previous, false);
    updateBackButton();
  }

  function updateBackButton() {
    var button = document.querySelector('.proto-back');
    if (button) button.disabled = history.length === 0;
  }

  function flashToast(text) {
    var existing = document.querySelector('.proto-toast');
    if (existing) existing.remove();
    var toast = element('div', { class: 'toast proto-toast', text: text });
    document.body.appendChild(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.remove(); }, 2600);
  }

  function anchorFor(node, screenElement) {
    var parts = [];
    while (node && node !== screenElement) {
      var parent = node.parentElement;
      if (!parent) return null;
      var tag = node.tagName.toLowerCase();
      var sameTag = Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === node.tagName;
      });
      parts.unshift(sameTag.length > 1 ? tag + ':' + (sameTag.indexOf(node) + 1) : tag);
      node = parent;
    }
    return parts.join('>');
  }

  function resolveAnchor(screenElement, path) {
    if (!path) return null;
    var node = screenElement;
    var parts = path.split('>');
    for (var partIndex = 0; partIndex < parts.length; partIndex += 1) {
      var bits = parts[partIndex].split(':');
      var tag = bits[0];
      var index = bits[1] ? parseInt(bits[1], 10) : 1;
      var matches = Array.prototype.filter.call(node.children, function (child) {
        return child.tagName.toLowerCase() === tag;
      });
      node = matches[index - 1];
      if (!node) return null;
    }
    return node;
  }

  function labelFor(node) {
    var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return '<' + node.tagName.toLowerCase() + '>';
    return text.length > 60 ? text.slice(0, 60) + '…' : text;
  }

  function clearPins() {
    document.querySelectorAll('.anno-pin-layer').forEach(function (layer) { layer.remove(); });
    document.querySelectorAll('.anno-target-active').forEach(function (node) {
      node.classList.remove('anno-target-active');
    });
  }

  function pinLayerFor(frame) {
    var layer = element('div', { class: 'anno-pin-layer', 'aria-hidden': 'false' });
    frame.appendChild(layer);
    return layer;
  }

  function renderPins() {
    clearPins();
    var orphans = [];
    var counters = {};
    var layers = new Map();

    threads.forEach(function (thread) {
      var screenElement = document.getElementById(thread.screen);
      if (!screenElement) {
        thread._orphan = true;
        orphans.push(thread);
        return;
      }
      counters[thread.screen] = (counters[thread.screen] || 0) + 1;
      thread._num = counters[thread.screen];
      if (!thread.anchor) {
        thread._orphan = false;
        return;
      }

      var target = resolveAnchor(screenElement, thread.anchor);
      var frame = target && target.closest('.frame');
      if (!target || !frame) {
        thread._orphan = true;
        orphans.push(thread);
        return;
      }
      thread._orphan = false;
      var layer = layers.get(frame);
      if (!layer) {
        layer = pinLayerFor(frame);
        layers.set(frame, layer);
      }
      var targetRect = target.getBoundingClientRect();
      var frameRect = frame.getBoundingClientRect();
      var classes = ['anno-pin'];
      if (thread.resolved) classes.push('resolved');
      else if (hasLocalChanges(thread.id)) classes.push('unsaved');
      var pin = element('button', {
        class: classes.join(' '),
        type: 'button',
        title: (thread.messages[0] || {}).text || '',
        'aria-label': 'Comment ' + thread._num,
        text: String(thread._num),
        onclick: function (event) {
          event.preventDefault();
          event.stopPropagation();
          activeId = thread.id;
          openPanel();
        }
      });
      pin.style.left = Math.max(0, targetRect.right - frameRect.left - 10) + 'px';
      pin.style.top = Math.max(0, targetRect.top - frameRect.top - 10) + 'px';
      layer.appendChild(pin);
      if (thread.id === activeId) target.classList.add('anno-target-active');
    });
    window.__prototypeOrphans = orphans;
    renderNavigationCounts();
  }

  function renderNavigationCounts() {
    navLinks().forEach(function (link) {
      var oldCount = link.querySelector('.anno-count');
      if (oldCount) oldCount.remove();
      var screenId = link.getAttribute('href').slice(1);
      var openCount = threads.filter(function (thread) {
        return thread.screen === screenId && !thread.resolved;
      }).length;
      if (openCount) link.appendChild(element('span', { class: 'anno-count', text: String(openCount) }));
    });
  }

  function buildPanel() {
    panelBody = element('div', { class: 'anno-panel-body' });
    authorInput = element('input', {
      class: 'input',
      placeholder: 'Your name for review comments',
      value: author || '',
      oninput: function (event) { author = event.target.value; save(); }
    });
    panel = element('aside', { class: 'anno-panel', 'aria-label': 'Prototype comments' }, [
      element('div', { class: 'anno-panel-head' }, [
        element('strong', { class: 't-card-title', text: 'Comments' }),
        element('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Close', onclick: closePanel })
      ]),
      panelBody,
      element('div', { class: 'anno-panel-foot' }, [
        authorInput,
        element('div', { class: 'row' }, [
          element('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Export for repository', onclick: exportRepository }),
          element('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Export Markdown', onclick: exportMarkdown })
        ])
      ])
    ]);
    document.body.appendChild(panel);
  }

  function openPanel() {
    panel.classList.add('open');
    document.body.classList.add('anno-open');
    renderPins();
    renderPanel();
  }

  function closePanel() {
    panel.classList.remove('open');
    document.body.classList.remove('anno-open');
    pending = null;
    activeId = null;
    renderPins();
  }

  function renderPanel() {
    panelBody.textContent = '';
    if (pending) panelBody.appendChild(composerCard());
    if (localOperations.length) {
      panelBody.appendChild(element('div', {
        class: 'anno-dirty-note',
        text: localOperations.length + ' local review operation' + (localOperations.length === 1 ? '' : 's') +
          ' must be exported and committed before the team can see them.'
      }));
    }

    var visibleThreads = threads.filter(function (thread) { return !thread._orphan; });
    if (!visibleThreads.length && !pending) {
      panelBody.appendChild(element('div', {
        class: 'anno-empty',
        text: 'No comments yet. Switch to Comment mode and select an element.'
      }));
    }

    var byScreen = {};
    visibleThreads.forEach(function (thread) {
      (byScreen[thread.screen] = byScreen[thread.screen] || []).push(thread);
    });
    Object.keys(byScreen).forEach(function (screenId) {
      var heading = document.querySelector('#' + screenId + ' .screen-meta h2');
      panelBody.appendChild(element('div', { class: 't-overline', text: heading ? heading.textContent : screenId }));
      byScreen[screenId].forEach(function (thread) { panelBody.appendChild(threadCard(thread)); });
    });

    var orphans = window.__prototypeOrphans || [];
    if (orphans.length) {
      var orphanBox = element('div', { class: 'anno-orphans' }, [
        element('strong', { class: 't-card-title', text: 'Orphaned threads (' + orphans.length + ')' }),
        element('div', {
          class: 't-hint',
          text: 'The original target no longer exists. Re-anchor the thread or resolve it; its content is preserved.'
        })
      ]);
      orphans.forEach(function (thread) { orphanBox.appendChild(threadCard(thread)); });
      panelBody.appendChild(orphanBox);
    }

    var activeCard = panelBody.querySelector('.anno-thread.active');
    if (activeCard) activeCard.scrollIntoView({ block: 'nearest' });
  }

  function composerCard() {
    var input = element('textarea', { placeholder: 'What should change?' });
    var card = element('div', { class: 'anno-thread active' }, [
      element('div', { class: 'anno-thread-head' }, [
        element('span', { class: 'anno-num', text: '+' }),
        element('span', { class: 'anno-anchor', text: pending.label })
      ]),
      element('div', { class: 'anno-composer' }, [
        input,
        element('div', { class: 'anno-composer-actions' }, [
          element('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Add comment', onclick: function () { commitNew(input.value); } }),
          element('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Cancel', onclick: cancelComposer })
        ])
      ])
    ]);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commitNew(input.value);
      if (event.key === 'Escape') cancelComposer();
    });
    setTimeout(function () { input.focus(); }, 0);
    return card;
  }

  function cancelComposer() {
    pending = null;
    renderPanel();
    renderPins();
  }

  function commitNew(text) {
    if (!text.trim()) return;
    var threadId = newId('thread');
    addOperation('create', threadId, {
      screen: pending.screen,
      anchor: pending.anchor,
      label: pending.label,
      message: { id: newId('message'), author: author || 'Anonymous', text: text.trim(), at: nowStamp() }
    });
    pending = null;
    activeId = threadId;
    renderPins();
    renderPanel();
  }

  function threadCard(thread) {
    var classes = ['anno-thread'];
    if (thread.id === activeId) classes.push('active');
    if (thread.resolved) classes.push('resolved');
    var card = element('div', {
      class: classes.join(' '),
      onclick: function (event) {
        if (event.target.closest('textarea, input, button, a, select, label')) return;
        activeId = thread.id;
        renderPins();
        renderPanel();
        if (focusMode) goTo(thread.screen);
        else {
          var screenElement = document.getElementById(thread.screen);
          if (screenElement) screenElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }, [
      element('div', { class: 'anno-thread-head' }, [
        element('span', { class: 'anno-num', text: String(thread._num || '?') }),
        element('span', { class: 'anno-anchor', title: thread.label, text: thread.label }),
        hasLocalChanges(thread.id) ? element('span', { class: 'badge badge-warning', text: 'local' }) : null
      ])
    ]);

    thread.messages.forEach(function (message) {
      card.appendChild(element('div', { class: 'anno-msg' }, [
        element('div', { class: 'anno-msg-meta' }, [
          element('span', { class: 'who', text: message.author }),
          element('span', { text: message.at })
        ]),
        element('div', { class: 'anno-msg-text', text: message.text })
      ]));
    });

    if (thread.id === activeId) {
      var reply = element('textarea', { placeholder: 'Reply…' });
      reply.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) addReply(thread, reply.value);
      });
      card.appendChild(element('div', { class: 'anno-composer' }, [
        reply,
        element('div', { class: 'anno-composer-actions' }, [
          element('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Reply', onclick: function (event) {
            event.stopPropagation();
            addReply(thread, reply.value);
          } }),
          element('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Re-anchor', onclick: function (event) {
            event.stopPropagation();
            beginReanchor(thread);
          } }),
          element('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: thread.resolved ? 'Reopen' : 'Resolve', onclick: function (event) {
            event.stopPropagation();
            addOperation('set-resolved', thread.id, { resolved: !thread.resolved });
            renderPins();
            renderPanel();
          } }),
          element('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Delete', onclick: function (event) {
            event.stopPropagation();
            if (!confirm('Delete this thread? The exported tombstone prevents accidental resurrection.')) return;
            addOperation('delete', thread.id, {});
            activeId = null;
            renderPins();
            renderPanel();
          } })
        ])
      ]));
      setTimeout(function () { reply.focus(); }, 0);
    }
    return card;
  }

  function addReply(thread, text) {
    if (!text.trim()) return;
    addOperation('reply', thread.id, {
      message: { id: newId('message'), author: author || 'Anonymous', text: text.trim(), at: nowStamp() }
    });
    renderPins();
    renderPanel();
  }

  function beginReanchor(thread) {
    reanchorThreadId = thread.id;
    setMode('comment');
    closePanel();
    flashToast('Select the new element for this thread. Press Escape to cancel.');
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = element('a', { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportRepository() {
    var exported = { version: 2, prototypeId: prototypeId, operations: allOperations() };
    var header = [
      '/* Committed prototype review operations.',
      ' * Generated by "Export for repository". Replace this file and commit it.',
      ' * Operations are append-only; delete operations are durable tombstones.',
      ' */',
      'window.__OM_PROTOTYPE_COMMENTS__ = '
    ].join('\n');
    download('comments.js', header + JSON.stringify(exported, null, 2) + ';\n', 'text/javascript');
  }

  function exportMarkdown() {
    var title = (document.querySelector('.doc-head h1') || {}).textContent || 'Prototype';
    var lines = ['# Prototype feedback — ' + title, ''];
    var byScreen = {};
    threads.forEach(function (thread) {
      (byScreen[thread.screen] = byScreen[thread.screen] || []).push(thread);
    });
    Object.keys(byScreen).forEach(function (screenId) {
      var heading = document.querySelector('#' + screenId + ' .screen-meta h2');
      lines.push('## ' + (heading ? heading.textContent : screenId), '');
      byScreen[screenId].forEach(function (thread) {
        lines.push('- **' + (thread.label || 'screen') + '**' + (thread.resolved ? ' _(resolved)_' : ''));
        thread.messages.forEach(function (message) {
          lines.push('  - ' + message.author + ' (' + message.at + '): ' + message.text.replace(/\n/g, ' '));
        });
        lines.push('');
      });
    });
    download('prototype-feedback.md', lines.join('\n'), 'text/markdown');
  }

  function setMode(nextMode) {
    mode = nextMode;
    document.body.classList.toggle('proto-comment', mode === 'comment');
    if (readModeButton) readModeButton.setAttribute('aria-selected', String(mode === 'read'));
    if (commentModeButton) commentModeButton.setAttribute('aria-selected', String(mode === 'comment'));
    if (mode === 'comment' && panel && !reanchorThreadId) openPanel();
  }

  // Comment mode only: a click inside a frame anchors a thread to what was clicked. Clicks on the
  // toolbar are skipped on purpose, so nothing there can ever anchor a comment.
  function onDocumentClick(event) {
    if (mode !== 'comment') return;
    if (event.target.closest('.anno-panel') || event.target.closest('.doc-toolbar')) return;
    if (event.target.closest('.anno-pin')) return;
    if (!event.target.closest('.frame')) return;

    event.preventDefault();
    event.stopPropagation();
    var target = event.target;
    while (target && (target.tagName === 'use' || String(target.tagName).toLowerCase() === 'svg')) {
      target = target.parentElement;
    }
    if (!target || target.classList.contains('anno-pin-layer')) return;
    var screenElement = target.closest('.screen');
    if (!screenElement) return;
    var anchor = { screen: screenElement.id, anchor: anchorFor(target, screenElement), label: labelFor(target) };
    if (reanchorThreadId) {
      var threadId = reanchorThreadId;
      reanchorThreadId = null;
      addOperation('reanchor', threadId, anchor);
      activeId = threadId;
      openPanel();
      flashToast('Thread re-anchored.');
      return;
    }
    pending = anchor;
    activeId = null;
    openPanel();
  }

  function buildToolbar() {
    var bar = document.querySelector('.doc-toolbar');
    if (!bar) return;
    readModeButton = element('button', { type: 'button', text: 'Read', onclick: function () { setMode('read'); } });
    commentModeButton = element('button', { type: 'button', text: 'Comment', onclick: function () { setMode('comment'); } });
    var segmented = element('div', { class: 'segmented' }, [readModeButton, commentModeButton]);
    var focusButton = element('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Presentation', onclick: function () {
      focusMode = !focusMode;
      document.body.classList.toggle('proto-focus', focusMode);
      focusButton.className = 'btn btn-sm ' + (focusMode ? 'btn-primary' : 'btn-outline');
      // Nothing navigated yet: open on the screen the URL names, else the first one.
      if (focusMode && !document.querySelector('.screen.is-current')) {
        var fromHash = document.getElementById(window.location.hash.slice(1));
        var opening = fromHash && fromHash.classList.contains('screen') ? fromHash : screens()[0];
        if (opening) {
          opening.classList.add('is-current');
          markCurrentScreen(opening.id);
        }
      }
      updateBackButton();
    } });
    var threadsButton = element('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Threads', onclick: function () {
      panel.classList.contains('open') ? closePanel() : openPanel();
    } });
    var pinsButton = element('button', { class: 'btn btn-outline btn-sm', type: 'button', text: 'Hide pins', onclick: function () {
      pinsVisible = !pinsVisible;
      document.body.classList.toggle('anno-hidden', !pinsVisible);
      pinsButton.textContent = pinsVisible ? 'Hide pins' : 'Show pins';
    } });
    var group = element('div', { class: 'proto-toolbar' }, [segmented, focusButton, threadsButton, pinsButton]);
    var themeButton = document.getElementById('theme-toggle');
    if (themeButton) {
      bar.insertBefore(group, themeButton);
      themeButton.style.marginLeft = '0';
    } else {
      bar.appendChild(group);
    }
    setMode('read');
  }

  function buildBackButton() {
    document.body.appendChild(element('button', {
      class: 'btn btn-outline proto-back', type: 'button', text: '← Back', onclick: goBack
    }));
    updateBackButton();
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyOperations();
    buildPanel();
    buildToolbar();
    buildBackButton();
    prepareScreenNav();
    renderPins();
    document.addEventListener('click', onDocumentClick, true);
    window.addEventListener('resize', renderPins);
    window.addEventListener('scroll', renderPins, true);
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && reanchorThreadId) {
        reanchorThreadId = null;
        setMode('read');
        flashToast('Re-anchor cancelled.');
        return;
      }
      if (event.key === 'Escape' && panel.classList.contains('open')) closePanel();
      if (event.key === 'Backspace' && focusMode && event.target === document.body) {
        event.preventDefault();
        goBack();
      }
    });
  });
})();
