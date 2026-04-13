/**
 * Self-contained JavaScript string injected into the preview iframe via
 * webFrameMain.executeJavaScript(). No imports — everything is inlined.
 *
 * How it works:
 * - On click, makes a text element contentEditable
 * - Snapshots every individual text node BEFORE editing
 * - On save, walks text nodes again and diffs against snapshots
 * - Only sends the individual text node changes (not the whole paragraph)
 * - This means grep can find "grew up in rural usa" instead of the entire
 *   concatenated textContent of a paragraph with embedded links
 */

export const EDIT_MODE_SCRIPT = `(function() {
  if (window.__2codeEditMode) return;
  window.__2codeEditMode = true;

  var EDITABLE_TAGS = 'h1,h2,h3,h4,h5,h6,p,span,a,li,button,label,blockquote,td,th,caption,figcaption';

  // State
  var activeElement = null;
  var originalHtml = '';
  var snapshotTexts = []; // Array of { text: string } for each text node
  var toolbar = null;
  var linkPanel = null;
  var linkInput = null;
  var highlightOverlay = null;
  var savedSelection = null; // preserved selection range while link panel is open

  // Normalize whitespace for comparison (browser adds/removes whitespace freely)
  function norm(s) {
    return (s || '').replace(/\\s+/g, ' ').trim();
  }

  // Snapshot all text nodes in an element (depth-first order)
  function snapshotTextNodes(el) {
    var result = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var node;
    while (node = walker.nextNode()) {
      var t = node.textContent || '';
      if (t.trim().length > 0) {
        result.push({ text: t });
      }
    }
    return result;
  }

  // Get current text nodes
  function currentTextNodes(el) {
    var result = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var node;
    while (node = walker.nextNode()) {
      var t = node.textContent || '';
      if (t.trim().length > 0) {
        result.push({ text: t });
      }
    }
    return result;
  }

  // ---- Toolbar ----
  function createToolbar() {
    var tb = document.createElement('div');
    tb.id = '__2code-edit-toolbar';
    tb.style.cssText = [
      'position:fixed',
      'z-index:999999',
      'display:none',
      'align-items:center',
      'gap:4px',
      'padding:4px 8px',
      'background:#1a1a2e',
      'border:1px solid #333',
      'border-radius:8px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
      'font-size:13px',
      'color:#e0e0e0',
      'pointer-events:auto',
    ].join(';');

    function btn(label, title, onClick) {
      var b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = [
        'padding:4px 8px',
        'border:none',
        'border-radius:4px',
        'background:transparent',
        'color:#e0e0e0',
        'cursor:pointer',
        'font-size:13px',
        'font-weight:500',
        'transition:background 0.15s',
      ].join(';');
      b.addEventListener('mouseenter', function() { b.style.background = '#333'; });
      b.addEventListener('mouseleave', function() { b.style.background = 'transparent'; });
      b.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); onClick(); });
      return b;
    }

    tb.appendChild(btn('B', 'Bold', function() { document.execCommand('bold'); }));
    tb.appendChild(btn('I', 'Italic', function() { document.execCommand('italic'); }));
    tb.appendChild(btn('Link', 'Insert link', function() { showLinkPanel(); }));

    var sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:16px;background:#444;margin:0 4px;';
    tb.appendChild(sep);

    tb.appendChild(btn('Save', 'Save edit', saveEdit));
    tb.appendChild(btn('Cancel', 'Cancel edit', cancelEdit));

    // Link input panel — hidden row below toolbar buttons
    var lp = document.createElement('div');
    lp.id = '__2code-link-panel';
    lp.style.cssText = [
      'display:none',
      'align-items:center',
      'gap:4px',
      'padding:4px 0 0 0',
      'border-top:1px solid #333',
      'margin-top:4px',
      'width:100%',
    ].join(';');

    var li = document.createElement('input');
    li.type = 'url';
    li.placeholder = 'https://';
    li.style.cssText = [
      'flex:1',
      'padding:4px 8px',
      'border:1px solid #555',
      'border-radius:4px',
      'background:#111',
      'color:#e0e0e0',
      'font-size:12px',
      'font-family:inherit',
      'outline:none',
      'min-width:160px',
    ].join(';');
    li.addEventListener('focus', function() { li.style.borderColor = '#3b82f6'; });
    li.addEventListener('blur', function() { li.style.borderColor = '#555'; });
    li.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    li.addEventListener('click', function(e) { e.stopPropagation(); });
    li.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); applyLink(); }
      if (e.key === 'Escape') { e.preventDefault(); hideLinkPanel(); }
    });
    linkInput = li;

    lp.appendChild(li);
    lp.appendChild(btn('Apply', 'Apply link', applyLink));
    lp.appendChild(btn('X', 'Cancel', hideLinkPanel));
    linkPanel = lp;
    tb.appendChild(lp);

    // Make toolbar a column layout to accommodate the link panel row
    tb.style.flexWrap = 'wrap';

    document.body.appendChild(tb);
    return tb;
  }

  function saveSelectionRange() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedSelection = sel.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelectionRange() {
    if (savedSelection) {
      var sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(savedSelection);
      }
    }
  }

  function showLinkPanel() {
    if (!linkPanel || !linkInput) return;
    // Save selection before focus moves to the input
    saveSelectionRange();
    linkPanel.style.display = 'flex';
    linkInput.value = '';
    linkInput.focus();
  }

  function hideLinkPanel() {
    if (!linkPanel) return;
    linkPanel.style.display = 'none';
    linkInput.value = '';
    savedSelection = null;
    // Refocus the editable element
    if (activeElement) activeElement.focus();
  }

  function applyLink() {
    var url = linkInput ? linkInput.value.trim() : '';
    if (!url) { hideLinkPanel(); return; }
    // Restore selection so createLink applies to the right text
    restoreSelectionRange();
    document.execCommand('createLink', false, url);
    hideLinkPanel();
  }

  function positionToolbar(el) {
    if (!toolbar) return;
    var rect = el.getBoundingClientRect();
    toolbar.style.display = 'flex';
    var top = rect.top - 44;
    if (top < 8) top = rect.bottom + 8;
    var left = rect.left + (rect.width / 2) - 120;
    left = Math.max(8, Math.min(left, window.innerWidth - 260));
    toolbar.style.top = top + 'px';
    toolbar.style.left = left + 'px';
  }

  function hideToolbar() {
    if (linkPanel) { linkPanel.style.display = 'none'; savedSelection = null; }
    if (toolbar) toolbar.style.display = 'none';
  }

  // ---- Highlight ----
  function createHighlightOverlay() {
    var ov = document.createElement('div');
    ov.id = '__2code-edit-highlight';
    ov.style.cssText = [
      'position:fixed',
      'z-index:999998',
      'pointer-events:none',
      'border:2px solid #3b82f6',
      'border-radius:4px',
      'background:rgba(59,130,246,0.08)',
      'display:none',
      'transition:all 0.1s ease-out',
    ].join(';');
    document.body.appendChild(ov);
    return ov;
  }

  function showHighlight(el) {
    if (!highlightOverlay || activeElement) return;
    var rect = el.getBoundingClientRect();
    highlightOverlay.style.display = 'block';
    highlightOverlay.style.top = (rect.top - 2) + 'px';
    highlightOverlay.style.left = (rect.left - 2) + 'px';
    highlightOverlay.style.width = (rect.width + 4) + 'px';
    highlightOverlay.style.height = (rect.height + 4) + 'px';
  }

  function hideHighlight() {
    if (highlightOverlay) highlightOverlay.style.display = 'none';
  }

  // ---- Edit actions ----
  function startEdit(el) {
    if (activeElement) saveEdit();
    activeElement = el;
    originalHtml = el.innerHTML;
    snapshotTexts = snapshotTextNodes(el);
    el.contentEditable = 'true';
    el.style.outline = '2px solid #3b82f6';
    el.style.outlineOffset = '2px';
    el.focus();
    hideHighlight();
    positionToolbar(el);
  }

  function saveEdit() {
    if (!activeElement) return;
    var el = activeElement;
    var savedSnapshot = snapshotTexts;
    var savedHtml = originalHtml;

    // Clear state FIRST
    activeElement = null;
    originalHtml = '';
    snapshotTexts = [];

    el.removeAttribute('contenteditable');
    el.style.outline = '';
    el.style.outlineOffset = '';

    // Concatenate all text nodes to compare total text.
    // contentEditable freely merges/splits text nodes, so we must compare
    // the total concatenated text, not individual nodes.
    var nowNodes = currentTextNodes(el);

    var oldTotal = '';
    for (var oi = 0; oi < savedSnapshot.length; oi++) oldTotal += savedSnapshot[oi].text;
    var newTotal = '';
    for (var ni = 0; ni < nowNodes.length; ni++) newTotal += nowNodes[ni].text;

    if (norm(oldTotal) === norm(newTotal)) {
      hideToolbar();
      return;
    }

    // Find exactly what changed via character-level diff.
    // We ONLY send the changed substring — never the full text, because:
    // - source files have HTML tags that break up DOM text
    // - source text is split across lines; grep searches per-line
    var pLen = 0;
    while (pLen < oldTotal.length && pLen < newTotal.length && oldTotal.charAt(pLen) === newTotal.charAt(pLen)) pLen++;
    var oEnd = oldTotal.length;
    var nEnd = newTotal.length;
    while (oEnd > pLen && nEnd > pLen && oldTotal.charAt(oEnd - 1) === newTotal.charAt(nEnd - 1)) { oEnd--; nEnd--; }

    var oldPart = oldTotal.substring(pLen, oEnd);
    var newPart = newTotal.substring(pLen, nEnd);

    var changes = [];
    if (oldPart.trim().length > 0 || newPart.trim().length > 0) {
      changes.push({ originalText: oldPart, newText: newPart });
    }

    if (changes.length === 0) {
      hideToolbar();
      return;
    }

    var parent = el.parentElement;
    var parentText = parent ? (parent.textContent || '').slice(0, 200) : '';
    var tagName = el.tagName.toLowerCase();

    for (var c = 0; c < changes.length; c++) {
      window.parent.postMessage({
        type: '__2CODE_EDIT',
        originalText: changes[c].originalText,
        newText: changes[c].newText,
        newHtml: '',
        tagName: tagName,
        parentText: parentText,
      }, '*');
    }

    hideToolbar();
  }

  function cancelEdit() {
    if (!activeElement) return;
    var el = activeElement;
    var savedHtml = originalHtml;
    activeElement = null;
    originalHtml = '';
    snapshotTexts = [];
    el.innerHTML = savedHtml;
    el.removeAttribute('contenteditable');
    el.style.outline = '';
    el.style.outlineOffset = '';
    el.offsetHeight; // force reflow
    hideToolbar();
  }

  // ---- Event handlers ----
  function findEditableTarget(el) {
    var node = el;
    for (var i = 0; i < 5 && node; i++) {
      if (node.matches && node.matches(EDITABLE_TAGS)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function handleMouseOver(e) {
    if (activeElement) return;
    var target = findEditableTarget(e.target);
    if (target && !target.closest('#__2code-edit-toolbar')) {
      showHighlight(target);
    } else {
      hideHighlight();
    }
  }

  function handleMouseOut() {
    hideHighlight();
  }

  function handleClick(e) {
    if (e.target.closest && e.target.closest('#__2code-edit-toolbar')) return;

    var target = findEditableTarget(e.target);
    if (target) {
      e.preventDefault();
      e.stopPropagation();
      startEdit(target);
    } else if (activeElement) {
      saveEdit();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape' && activeElement) {
      e.preventDefault();
      cancelEdit();
    }
  }

  // ---- Init ----
  toolbar = createToolbar();
  highlightOverlay = createHighlightOverlay();

  document.addEventListener('mouseover', handleMouseOver, true);
  document.addEventListener('mouseout', handleMouseOut, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
})();`

export const DISABLE_EDIT_MODE_SCRIPT = `(function() {
  if (!window.__2codeEditMode) return;
  window.__2codeEditMode = false;

  var toolbar = document.getElementById('__2code-edit-toolbar');
  if (toolbar) toolbar.remove();
  var highlight = document.getElementById('__2code-edit-highlight');
  if (highlight) highlight.remove();

  document.querySelectorAll('[contenteditable="true"]').forEach(function(el) {
    el.removeAttribute('contenteditable');
    el.style.outline = '';
    el.style.outlineOffset = '';
  });
})();`
