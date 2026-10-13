/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define([], () => {
	const ACTION_FIELD_ID = 'custpage_action';
	const MESSAGE_FIELD_ID = 'custpage_message_input';
	const IMAGE_DATA_FIELD_ID = 'custpage_image_data';
	const IMAGE_TYPE_FIELD_ID = 'custpage_image_type';
	const KB_REMOVE_DOC_ID_FIELD_ID = 'custpage_kb_remove_id';
	const KB_UPLOAD_NAME_FIELD_ID = 'custpage_kb_upload_name';
	const KB_UPLOAD_CONTENT_FIELD_ID = 'custpage_kb_upload_content';
	const KB_UPLOAD_SIZE_FIELD_ID = 'custpage_kb_upload_size';
	const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
	const ALLOWED_TYPES = ['image/png', 'image/jpeg'];
	const MAX_KB_FILE_BYTES = 200 * 1000;
	const ALLOWED_KB_EXTENSIONS = ['txt', 'md'];

	// Guards against a double navigation from a fast double-click or an
	// Enter-key repeat landing on top of a button click - the page itself
	// gets replaced by the POST response shortly after, which is the real
	// (and sufficient) protection; this just stops a second submit firing in
	// the brief window before that happens.
	let isSubmitting = false;

	const setHidden = (id, value) => {
		const field = document.getElementById(id);
		if (field) {
			field.value = value;
		}
	};

	const setSendButtonEnabled = (enabled) => {
		const button = document.getElementById('custpage_btn_send');
		if (button) {
			button.disabled = !enabled;
		}
	};

	// This whole page is a classic form-POST/full-reload Suitelet (see
	// submitForm) - there is no XHR, so there is no way to know DURING the
	// wait which pipeline stage (cache check / RAG / tools / generation) is
	// actually running server-side right now. This is intentionally cosmetic:
	// cycling through plausible stage labels while the POST is in flight
	// gives the same kind of "still working, here's roughly what on" feedback
	// modern copilots show, without claiming to know real-time server state
	// it cannot see. Cleared automatically when the page unloads/reloads.
	const THINKING_STAGES = [
		'Reading script source...',
		'Checking cache...',
		'Searching Knowledge Base...',
		'Consulting the model...'
	];
	let thinkingIntervalId = null;

	const setThinking = (active) => {
		const indicator = document.getElementById('dcs_thinking');
		if (!indicator) {
			return;
		}
		indicator.classList.toggle('dcs-active', active);
		if (thinkingIntervalId !== null) {
			window.clearInterval(thinkingIntervalId);
			thinkingIntervalId = null;
		}
		if (!active) {
			return;
		}
		let stageIndex = 0;
		const labelEl = indicator.querySelector('.dcs-thinking-label') || indicator;
		labelEl.textContent = THINKING_STAGES[0];
		thinkingIntervalId = window.setInterval(() => {
			stageIndex = (stageIndex + 1) % THINKING_STAGES.length;
			labelEl.textContent = THINKING_STAGES[stageIndex];
		}, 1100);
	};

	// NetSuite's own page chrome tracks field changes on every Suitelet form
	// and wires window.onbeforeunload to show a native "leave this page?"
	// confirmation on navigation - this is NOT something this script's code
	// ever asked for (no confirm()/onbeforeunload call exists anywhere else
	// in this file), it is platform default behavior for any form with a
	// dirty field, which a typed-into question textarea always triggers.
	// Clearing the handler is the standard, documented workaround for
	// suppressing it on custom Suitelet forms.
	const suppressLeavePageConfirmation = () => {
		window.onbeforeunload = null;
	};

	const submitForm = () => {
		suppressLeavePageConfirmation();
		document.forms[0].submit();
	};

	const setActionAndSubmit = (actionValue) => {
		setHidden(ACTION_FIELD_ID, actionValue);
		submitForm();
	};

	const readAndAttachImage = (onReady) => {
		const fileInput = document.getElementById('dcs_image_input');
		const statusEl = document.getElementById('dcs_image_status');
		const file = fileInput && fileInput.files && fileInput.files[0];

		if (!file) {
			setHidden(IMAGE_DATA_FIELD_ID, '');
			setHidden(IMAGE_TYPE_FIELD_ID, '');
			onReady(true);
			return;
		}

		if (ALLOWED_TYPES.indexOf(file.type) === -1) {
			if (statusEl) {
				statusEl.textContent = 'Only PNG or JPEG screenshots are supported.';
			}
			onReady(false);
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			if (statusEl) {
				statusEl.textContent = 'Screenshot is too large (max 2 MB). Please crop or resize it.';
			}
			onReady(false);
			return;
		}

		if (statusEl) {
			statusEl.textContent = 'Encoding screenshot...';
		}

		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result || '');
			const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
			setHidden(IMAGE_DATA_FIELD_ID, base64);
			setHidden(IMAGE_TYPE_FIELD_ID, file.type);
			onReady(true);
		};
		reader.onerror = () => {
			if (statusEl) {
				statusEl.textContent = 'Could not read the screenshot file.';
			}
			onReady(false);
		};
		reader.readAsDataURL(file);
	};

	// Single entry point for "ask a question" - used by the Send button, the
	// Enter key, and the empty-state suggested-question buttons alike, so
	// all three get the same no-confirmation, disabled-while-submitting,
	// "thinking" behavior instead of three separate implementations.
	const submitQuestion = (presetText) => {
		if (isSubmitting) {
			return;
		}

		const messageField = document.getElementById(MESSAGE_FIELD_ID);
		if (presetText !== undefined && messageField) {
			messageField.value = presetText;
		}
		const value = messageField ? String(messageField.value || '').trim() : '';
		if (!value) {
			return;
		}

		isSubmitting = true;
		setSendButtonEnabled(false);
		setThinking(true);

		readAndAttachImage((ok) => {
			if (!ok) {
				isSubmitting = false;
				setSendButtonEnabled(true);
				setThinking(false);
				return;
			}
			markPendingAnchorScroll();
			setActionAndSubmit('ask');
		});
	};

	const sendMessage = () => submitQuestion();

	// Exposed for the empty-state suggestion buttons' inline onclick - the
	// same global-function convention NetSuite already relies on to wire
	// form.addButton's functionName to this module's exports.
	const askSuggested = (text) => submitQuestion(text);

	// Clearing discards the whole conversation - unlike a normal question,
	// that is a real destructive action, so (per explicit UX direction) this
	// keeps a confirmation while Send/suggested-question sends get none.
	const clearConversation = () => {
		if (isSubmitting) {
			return;
		}
		if (!window.confirm('Clear this conversation? This cannot be undone.')) {
			return;
		}
		isSubmitting = true;
		setActionAndSubmit('clear');
	};

	// Unified script selector (see buildScriptSelectorHtml/scriptOptionValue
	// on the server) - a plain native <select name=custpage_selected_script>,
	// so its chosen value submits with the form on its own; this only needs
	// to set the action and go. A native <select> always fires onchange on
	// selection, unlike the earlier <input>+<datalist> attempt which
	// depended on fragile exact-text matching. The server re-validates the
	// parsed "scriptid::deploymentid::name" value regardless (onRequest's
	// 'switchscript' branch) - this is just the trigger, not the source of
	// truth for validation.
	const switchScript = () => {
		try {
			// eslint-disable-next-line no-console
			console.log('[Debug Copilot] switchScript() fired, value =', document.getElementById('dcs_script_search') && document.getElementById('dcs_script_search').value);
			if (isSubmitting) {
				return;
			}
			isSubmitting = true;
			setActionAndSubmit('switchscript');
		} catch (e) {
			isSubmitting = false;
			// eslint-disable-next-line no-console
			console.error('[Debug Copilot] switchScript() failed', e);
		}
	};

	// Toggles the RAG/JSON checkboxes (data-gptoss-disable, see
	// buildLabPanelHtml) the moment GPT-OSS is selected, instead of only
	// rejecting the combination after a round trip to the server - the
	// server (handleAsk) still independently enforces this regardless of
	// what the client does, so a user who somehow re-enables one via
	// devtools does not get a broken combination silently accepted.
	const onModelChange = () => {
		const select = document.getElementById('dcs_model_select');
		const isGptOss = select && select.value === 'GPT_OSS';
		document.querySelectorAll('[data-gptoss-disable]').forEach((checkbox) => {
			checkbox.disabled = !!isGptOss;
			if (isGptOss) {
				checkbox.checked = false;
			}
		});
	};

	// Mirrors onModelChange for evaluatePrompt (data-promptstudio-disable,
	// see buildLabPanelHtml) - evaluatePrompt bypasses RAG/tools/cache/
	// safety entirely server-side (handleAsk), so leaving those checkboxes
	// checked-but-inert was exactly the "cache doesn't work" confusion this
	// fixes: the checkbox now visibly reflects that it has no effect,
	// instead of silently doing nothing while still showing checked.
	const onPromptStudioChange = () => {
		const promptStudioCheckbox = document.querySelector('input[name="custpage_lab_promptstudio"]');
		const isOn = !!(promptStudioCheckbox && promptStudioCheckbox.checked);
		document.querySelectorAll('[data-promptstudio-disable]').forEach((checkbox) => {
			checkbox.disabled = isOn;
			if (isOn) {
				checkbox.checked = false;
			}
		});
		const note = document.getElementById('dcs_promptstudio_note');
		if (note) {
			note.hidden = !isOn;
		}
	};

	const removeKbDocument = (docId) => {
		if (isSubmitting) {
			return;
		}
		if (!window.confirm('Remove this document from the Knowledge Base? This cannot be undone.')) {
			return;
		}
		isSubmitting = true;
		setHidden(KB_REMOVE_DOC_ID_FIELD_ID, docId);
		setActionAndSubmit('removedoc');
	};

	// Fires the moment a file is chosen (no separate "Upload" button - one
	// action, not two) - reads it as TEXT (not base64; .txt/.md are plain
	// text, so there is no encoding step needed the way the screenshot
	// attach button needs for binary images) directly into hidden fields,
	// then submits like any other action. The server (validateKbUpload)
	// re-checks extension/size/emptiness regardless - this is a fast local
	// check so an obviously-wrong file never round-trips to the server first.
	const onKbFileChosen = () => {
		if (isSubmitting) {
			return;
		}
		const fileInput = document.getElementById('dcs_kb_file_input');
		const nameEl = document.getElementById('dcs_kb_filename');
		const file = fileInput && fileInput.files && fileInput.files[0];
		if (!file) {
			return;
		}

		const extension = (file.name.split('.').pop() || '').toLowerCase();
		if (ALLOWED_KB_EXTENSIONS.indexOf(extension) === -1) {
			if (nameEl) {
				nameEl.textContent = 'Unsupported file type. Supported formats: TXT, MD.';
			}
			fileInput.value = '';
			return;
		}
		if (file.size <= 0) {
			if (nameEl) {
				nameEl.textContent = 'That file appears to be empty.';
			}
			fileInput.value = '';
			return;
		}
		if (file.size > MAX_KB_FILE_BYTES) {
			if (nameEl) {
				nameEl.textContent = `Too large (max ${Math.round(MAX_KB_FILE_BYTES / 1000)}KB).`;
			}
			fileInput.value = '';
			return;
		}

		if (nameEl) {
			nameEl.textContent = `Uploading ${file.name}...`;
		}

		const reader = new FileReader();
		reader.onload = () => {
			isSubmitting = true;
			setHidden(KB_UPLOAD_NAME_FIELD_ID, file.name);
			setHidden(KB_UPLOAD_SIZE_FIELD_ID, String(file.size));
			setHidden(KB_UPLOAD_CONTENT_FIELD_ID, String(reader.result || ''));
			setActionAndSubmit('uploaddoc');
		};
		reader.onerror = () => {
			if (nameEl) {
				nameEl.textContent = 'Could not read that file.';
			}
			fileInput.value = '';
		};
		reader.readAsText(file);
	};

	const handleMessageKeydown = (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submitQuestion();
		}
		// Shift+Enter: no handling needed - the browser's default textarea
		// behavior already inserts a newline.
	};

	// Chat-style input: grows with content up to the CSS max-height (140px),
	// then scrolls internally - matches how the composer textarea is styled
	// (rows="1" by default, not a fixed multi-line box).
	const autoGrowMessageField = () => {
		const messageField = document.getElementById(MESSAGE_FIELD_ID);
		if (!messageField) {
			return;
		}
		messageField.style.height = 'auto';
		messageField.style.height = `${messageField.scrollHeight}px`;
	};

	// The transcript pane has a CSS vh-based fallback height (see
	// .dcs-transcript-pane), but that is only an approximation of "fill the
	// space below the header" since NetSuite's own page chrome (banner, nav)
	// isn't something this script can measure from CSS alone. Setting an
	// explicit pixel height from the pane's actual on-screen position gets
	// much closer to genuinely using the available viewport.
	const resizeTranscriptPane = () => {
		const pane = document.getElementById('dcs_transcript_scroll');
		if (!pane) {
			return;
		}
		const top = pane.getBoundingClientRect().top;
		// Leaves room below the pane for the sticky composer + a little
		// breathing room, so the composer isn't pushed below the fold. AI
		// Units/streaming details now live inside the AI Lab drawer rather
		// than a footer field below the composer, so this reserves just the
		// composer's own height plus a small margin - the pane should fill
		// essentially all remaining vertical space down to the composer.
		const reserveForComposer = 110;
		const available = window.innerHeight - top - reserveForComposer;
		pane.style.height = `${Math.max(available, 320)}px`;
	};

	const scrollTranscriptToBottom = () => {
		const pane = document.getElementById('dcs_transcript_scroll');
		if (pane) {
			pane.scrollTop = pane.scrollHeight;
		}
	};

	// This is a full-page-reload Suitelet (see submitForm) - there is no
	// live DOM to keep scrolled correctly while a response streams in, so
	// "smart scroll" here means getting the LANDING position right on the
	// reload that follows Send, not adjusting scroll mid-stream. Previously
	// every reload landed at the absolute bottom of the transcript, which
	// for a long answer meant the new question scrolled off the top and the
	// user landed mid-answer instead of at its start. Now: right before an
	// 'ask' submit, sessionStorage records that the next load should scroll
	// the new exchange to the TOP of the pane (buildTranscriptHtml tags the
	// most recent user turn with id="dcs_scroll_anchor" whenever the very
	// last turn is that question's assistant reply); every other action
	// (switch script, clear, KB upload/remove) falls back to the previous
	// scroll-to-bottom behavior, which is correct for those.
	const SCROLL_PENDING_KEY = 'dcs_scroll_pending';
	const markPendingAnchorScroll = () => {
		try {
			window.sessionStorage.setItem(SCROLL_PENDING_KEY, 'anchor');
		} catch (e) {
			// Storage unavailable - just falls back to scroll-to-bottom below.
		}
	};
	const restoreScrollPosition = () => {
		let pending = null;
		try {
			pending = window.sessionStorage.getItem(SCROLL_PENDING_KEY);
			window.sessionStorage.removeItem(SCROLL_PENDING_KEY);
		} catch (e) {
			pending = null;
		}
		const anchor = pending === 'anchor' && document.getElementById('dcs_scroll_anchor');
		if (anchor) {
			anchor.scrollIntoView({ block: 'start', behavior: 'auto' });
			return;
		}
		scrollTranscriptToBottom();
	};

	// Light/dark theme - there is no NetSuite user-preference field this
	// Suitelet reads, so the choice is kept in localStorage (per-browser, same
	// pattern already used nowhere else in this file but standard for a
	// client-only UI preference with no server-side consequence). Applied as
	// early as possible in pageInit (before scrollTranscriptToBottom/resize)
	// to minimize the flash of the default theme.
	const THEME_STORAGE_KEY = 'dcs_theme';
	const applyTheme = (theme) => {
		const shell = document.querySelector('.dcs-shell');
		if (shell) {
			shell.setAttribute('data-theme', theme);
		}
		const toggleBtn = document.getElementById('dcs_theme_toggle');
		if (toggleBtn) {
			toggleBtn.textContent = theme === 'dark' ? '☀' : '☽';
			toggleBtn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
		}
	};
	const initTheme = () => {
		let stored = null;
		try {
			stored = window.localStorage.getItem(THEME_STORAGE_KEY);
		} catch (e) {
			stored = null;
		}
		const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
		applyTheme(stored || (prefersDark ? 'dark' : 'light'));
	};
	const toggleTheme = () => {
		const shell = document.querySelector('.dcs-shell');
		const current = (shell && shell.getAttribute('data-theme')) || 'light';
		const next = current === 'dark' ? 'light' : 'dark';
		applyTheme(next);
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch (e) {
			// Private browsing / storage disabled - theme just won't persist
			// across reloads, which is a cosmetic degradation, not a failure.
		}
	};

	// Knowledge Base / AI Lab drawers - purely client-side show/hide (a CSS
	// transform + aria-hidden toggle), not a server round trip. The drawer
	// markup stays in the DOM and inside the same <form> at all times (see
	// buildKbPanelHtml/buildLabPanelHtml's comments), so its checkboxes/
	// upload control still post correctly with the next action regardless of
	// whether the drawer happens to be open when that action fires. A full
	// page reload (any Send/upload/remove/switch-script action) always
	// closes the drawer again - there is no server-side "drawer open" state
	// to restore it, since that would need persisting purely-visual state
	// through the same POST/reload cycle that already carries the real
	// conversation state, for a `state.notice` banner elsewhere that already
	// confirms the upload/remove happened while a KB drawer might be closed.
	let activeDrawerId = null;
	const openDrawer = (name) => {
		const drawerId = name === 'kb' ? 'dcs_kb_drawer' : 'dcs_lab_drawer';
		const drawer = document.getElementById(drawerId);
		const backdrop = document.getElementById('dcs_backdrop');
		if (!drawer) {
			return;
		}
		activeDrawerId = drawerId;
		drawer.classList.add('dcs-open');
		drawer.setAttribute('aria-hidden', 'false');
		if (backdrop) {
			backdrop.classList.add('dcs-open');
		}
		const closeBtn = drawer.querySelector('.dcs-drawer-close');
		if (closeBtn) {
			closeBtn.focus();
		}
	};
	const closeDrawer = () => {
		['dcs_kb_drawer', 'dcs_lab_drawer'].forEach((id) => {
			const drawer = document.getElementById(id);
			if (drawer) {
				drawer.classList.remove('dcs-open');
				drawer.setAttribute('aria-hidden', 'true');
			}
		});
		const backdrop = document.getElementById('dcs_backdrop');
		if (backdrop) {
			backdrop.classList.remove('dcs-open');
		}
		activeDrawerId = null;
	};
	const handleGlobalKeydown = (event) => {
		if (event.key === 'Escape' && activeDrawerId) {
			closeDrawer();
		}
	};

	const pageInit = () => {
		// eslint-disable-next-line no-console
		console.log('[Debug Copilot] client script pageInit() ran - if you do not see this in the console, the browser is serving a stale cached copy of this file.');
		suppressLeavePageConfirmation();
		initTheme();

		const messageField = document.getElementById(MESSAGE_FIELD_ID);
		if (messageField) {
			messageField.addEventListener('keydown', handleMessageKeydown);
			messageField.addEventListener('input', autoGrowMessageField);
		}

		resizeTranscriptPane();
		restoreScrollPosition();
		window.addEventListener('resize', resizeTranscriptPane);
		document.addEventListener('keydown', handleGlobalKeydown);
		onModelChange();
		onPromptStudioChange();
	};

	const entryPoints = {
		pageInit,
		sendMessage,
		askSuggested,
		clearConversation,
		switchScript,
		onModelChange,
		onPromptStudioChange,
		removeKbDocument,
		onKbFileChosen,
		toggleTheme,
		openDrawer,
		closeDrawer
	};

	// Defensive explicit globals: NetSuite's own doc/examples say a Client
	// Script's returned entry points become callable from onclick/onchange
	// attributes in Suitelet-rendered HTML automatically, and the
	// pre-existing sendMessage/clearConversation/askSuggested wiring here
	// relies on exactly that - but that mechanism has not been independently
	// re-verified for the NEWER entry points added alongside the unified
	// layout (switchScript/onModelChange/removeKbDocument/onKbFileChosen).
	// Assigning them onto window explicitly costs nothing if the automatic
	// mechanism already works, and fixes it outright if it doesn't for some
	// reason on this account/UI theme.
	Object.keys(entryPoints).forEach((name) => {
		window[name] = entryPoints[name];
	});

	return entryPoints;
});
