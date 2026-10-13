/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * SuiteScript Debug Copilot - main orchestrator.
 *
 * ENTRY POINT: this Suitelet is self-service, not launched from a button on
 * the Script Deployment record. NetSuite's own record metadata shows
 * scriptdeployment has scripting level "Read and Search Only" (no
 * create/edit/save lifecycle), so a User Event script cannot attach to it -
 * there is no beforeLoad/beforeSubmit to hook a button into. Loading the
 * Suitelet with no ?scriptid= param instead renders a picker (buildPickerHtml)
 * sourced from the same script/scriptdeployment SuiteQL tables the
 * getExecutionLogForScript tool uses, which links into the chat view with
 * scriptid/deploymentid/scriptname pre-filled - functionally equivalent to a
 * button, without depending on an unsupported UE attachment point.
 *
 * Uses N/llm end to end. The chat composer exposes an N/llm lab so each
 * turn can opt into native documents/citations, tools, embeddings cache,
 * safetyMode, responseFormat JSON, Prompt Studio evaluatePrompt, and
 * Cohere vs GPT-OSS. Streaming is attempted only on text-only calls -
 * generateTextStreamed() plus tools/documents throws UNEXPECTED_ERROR on
 * this account (see generateOnce). Script source is still inlined into
 * the user prompt; knowledge/ files are passed as llm.createDocument
 * when RAG is on so response.citations can be shown.
 *
 * SELECTED-SCRIPT SOURCE PIPELINE (loadScriptSourceContext and friends,
 * "Selected-script source pipeline" section): the selected script's actual
 * source is the primary subject of every conversation, not just its name/id.
 * scriptId -> SuiteQL `script` row (id, name, scriptfile) -> file.load() on
 * scriptfile (the real File Cabinet id from the script record) -> parse the
 * loaded file's own define([...]) call for same-folder './x' dependencies
 * and load those too, capped at MAX_SOURCE_FILES/MAX_SOURCE_CHARS_PER_FILE/
 * MAX_TOTAL_SOURCE_CHARS -> assembled into one labeled text block ->
 * inlined directly into the prompt text built by buildInstructionPrompt (not
 * added as a `documents` RAG entry, so the model gets the full text rather
 * than a retrieval excerpt). Resolved once per request in onRequest and
 * passed down to handleAsk/buildForm, rather than reloaded per function, so
 * the chat header and the actual generation call always agree on what was
 * loaded. A missing/unreadable source degrades to a visible in-transcript
 * warning (turn.sourceWarning) plus tools/reference-docs-only answering,
 * never a silent generic refusal.
 *
 * KNOWN PLATFORM ISSUE - generateTextStreamed() + tools/documents: this
 * account throws a generic UNEXPECTED_ERROR out of the streamed response's
 * iterator() when the call also includes `tools`/`documents` - a combination
 * no other script in this project had ever exercised (llm_streaming_test.js
 * proves streaming alone; llm_tool_call_test.js and llm_rag_test.js prove
 * tools/documents only with the non-streaming generateText()). generateOnce()
 * still tries generateTextStreamed() first every turn (streaming is NOT
 * disabled), but drainStreamed() tags any failure with a `stage`
 * (stream_initialization / stream_iteration / response_assembly) and
 * generateOnce() falls back to generateText() for that call - proven safe
 * since generateText() independently supports both ingredients. Once a turn
 * falls back, the rest of that turn's tool-loop iterations skip straight to
 * generateText() too (see the `streamingBroken` flag in runConversationTurn)
 * rather than repeatedly re-attempting a stream already known to be broken
 * this turn; the next user turn tries streaming fresh.
 *
 * RESOLVED - safetyMode: diagnostic logging proved real source content
 * (thousands of characters, all 4 files present) reaching a 26,945-character
 * prompt on both the streamed and non-streamed calls, while the model still
 * returned the literal "I can't determine that..." fallback every time.
 * safetyMode: 'CONTEXTUAL' was the one remaining unverified ingredient
 * (unused by every other script in this project) and Cohere's documented
 * SAFETY_MODE parameter is specifically designed to make the model hedge/
 * refuse when it isn't confident a claim is well-grounded - it has been
 * removed from buildTextOnlyOptions (see that function's comment). Scope
 * control now relies solely on the prompt instructions themselves, the same
 * technique llm_salesorder_rag_assistant.js already uses successfully
 * without safetyMode.
 *
 * UNVERIFIED SURFACE: the vision (image) content-block shape is not
 * exercised by any other script in this project and could not be confirmed
 * against this account's live N/llm module before this file was written. If
 * the vision attempt fails - either while building the chat message
 * (buildVisionOptions) or anywhere inside generateOnce - runTurnWithVisionFallback
 * retries once as text-only and surfaces a visible "screenshot couldn't be
 * processed" banner in the transcript (see the turn.imageWarning field /
 * .dcs-warning-banner CSS class), rather than silently dropping the
 * screenshot or failing the whole turn. Verify against Test Checklist item 5
 * in the write-up before pilot rollout.
 *
 * 2026 UI/UX PASS - unified page, Knowledge Base uploads, context-aware
 * cache, dead tool plumbing removed:
 *
 * - UNIFIED PAGE: the standalone buildPickerPage() HTML page is gone. The
 *   script/deployment picker is now a searchable field (native <input> +
 *   <datalist>, no external JS) at the top of the same chat form, submitting
 *   action=switchscript. Loading the Suitelet with no ?scriptid= now renders
 *   the same form with an empty-selection state instead of a different,
 *   unstyled page - see buildScriptOptions/buildScriptSelectorHtml and the
 *   'switchscript' branch in onRequest. Deep links (?scriptid=&deploymentid=&
 *   scriptname=) still work unchanged for backward compatibility.
 * - LAYOUT: buildForm's HTML now composes one CSS Grid shell (.dcs-shell)
 *   with a left sidebar (script info/source files/suggested questions), a
 *   center chat column, and a right panel (Knowledge Base + N/llm lab),
 *   collapsible on narrow screens. The shell <div> is opened in the header
 *   field and closed in the composer field - the only two field boundaries
 *   that matter, since serverWidget INLINEHTML fields render their
 *   defaultValue as raw HTML in page order with no field-label chrome, so
 *   plain HTML nesting across a few adjacent fields renders correctly.
 * - KNOWLEDGE BASE UPLOADS: previously the only "documents" were the 4
 *   hardcoded KNOWLEDGE_FILES. Users can now upload their own (.txt/.md
 *   only - see ALLOWED_KB_EXTENSIONS comment for why other formats are
 *   rejected rather than silently mishandled), see them listed, and remove
 *   them, tracked in customrecord_dcs_document with the file itself in
 *   SuiteScripts/debug-copilot/knowledge/uploads/.
 * - CACHE: added an exact-match tier (findExactCachedAnswer) ahead of the
 *   existing cosine-similarity tier (findSemanticCachedAnswer, the renamed
 *   findCachedAnswer) so a byte-identical repeat question no longer pays for
 *   an llm.embed call at all. Both tiers are now also scoped by
 *   computeContextHash() (active knowledge documents + model), not just
 *   scriptId, so an answer cached before a document was added/removed/
 *   toggled is never served as if that document had been considered. The
 *   embed call itself is now also skipped entirely when the "embed cache"
 *   lab toggle is off - previously it ran unconditionally every turn
 *   regardless of that toggle.
 * - REMOVED DEAD CODE: buildTools()/buildToolParameter()/
 *   SUPPORTED_TOOL_PARAMETER_TYPES and the llm.createToolResult tool-call
 *   loop in runConversationTurn are gone. They were never reachable - the
 *   `tools` option passed to generateText was always `[]` (see the file's
 *   original KNOWN PLATFORM ISSUE note on generateText({tools}) failing on
 *   this account), so response.toolCalls could never be populated and that
 *   loop could never run. The mechanism that actually works - SuiteScript
 *   prefetching getExecutionLogForScript/lookupRecordFieldSchema results via
 *   keyword matching and injecting them as text (prefetchLiveToolResults) -
 *   is unchanged and is the only "tool calling" this Suitelet does.
 */
define([
	'N/llm',
	'N/query',
	'N/record',
	'N/file',
	'N/runtime',
	'N/cache',
	'N/log',
	'N/ui/serverWidget'
], (llm, query, record, file, runtime, cache, log, serverWidget) => {
	const CACHE_RECORD_TYPE = 'customrecord_debug_session';
	const KB_DOCUMENT_RECORD_TYPE = 'customrecord_dcs_document';
	const KNOWLEDGE_FOLDER = 'SuiteScripts/debug-copilot/knowledge/';
	// Uploads live in the SAME folder as the 4 built-ins, not a dedicated
	// "uploads" subfolder - N/file has no API to create a new folder (only
	// file.create into an EXISTING folder id), so a subfolder would have to
	// be created by hand before this could ever work. Reusing
	// KNOWLEDGE_FOLDER sidesteps that entirely: its id is resolved from one
	// of the already-guaranteed-to-exist KNOWLEDGE_FILES (see
	// resolveKnowledgeFolderId), the same anchor-file trick
	// resolveSuiteScriptsFolderId already uses for the SuiteScripts root.
	const KNOWLEDGE_UPLOAD_FOLDER = KNOWLEDGE_FOLDER;
	const KNOWLEDGE_FILES = [
		{ id: 'safe_guide', file: 'safe_guide.txt' },
		{ id: 'owasp_secure_coding', file: 'owasp_secure_coding.txt' },
		{ id: 'records_reference', file: 'records_reference.txt' },
		{ id: 'roles_permissions', file: 'roles_permissions.txt' }
	];
	// Only formats this codebase can actually prove work: every proven
	// llm.createDocument call anywhere in this project (this file,
	// llm_rag_test.js, llm_salesorder_rag_assistant.js, ...) passes plain
	// text/string data. NetSuite has no built-in PDF/DOCX-to-text extraction
	// API this project uses, and file.load().getContents() on a binary file
	// does not yield clean extractable text - so PDF/DOC/DOCX/images are
	// rejected at upload with a clear message rather than silently producing
	// garbage RAG context (or worse, failing deep inside llm.createDocument).
	// If this account ever proves PDF/DOCX text extraction works, add the
	// extension here AND update the validation message in
	// validateKbUpload/the "Supported formats" copy in buildKbPanelHtml.
	const ALLOWED_KB_EXTENSIONS = ['txt', 'md'];
	const MAX_KB_DOCUMENT_BYTES = 200000; // ~200KB - generous for reference text, small enough to stay well under MAX_TOTAL_SOURCE_CHARS-scale prompt budgets
	const MAX_KB_DOCUMENTS = 20; // uploaded documents, on top of the 4 built-in KNOWLEDGE_FILES
	const MAX_RAG_DOCUMENTS_PER_TURN = 12; // built-in + active uploads combined, bounds prompt size/governance regardless of how many are active overall
	// Stored conversation turns are never summarized away (see file header
	// "CACHE/MEMORY" note) - full history is kept for readability - but an
	// unbounded state.turns array round-trips through a hidden page field on
	// every POST (see STATE_FIELD_ID), so a pathologically long single
	// session is capped here as a page-size/governance safety net, not a
	// relevance decision. Well under this in any normal conversation.
	const MAX_STORED_TURNS = 60;

	const PROMPT_STUDIO_PARAM = 'custscript_dcs_prompt_id';
	const DEFAULT_LAB = {
		useRag: true,
		useTools: true,
		useCache: true,
		useSafety: false,
		useJson: false,
		usePromptStudio: false,
		// Default OFF - see attemptNativeToolCalling's comment. The file header's
		// "KNOWN PLATFORM ISSUE" note documents generateText({tools}) throwing
		// UNEXPECTED_ERROR on this account once the prompt grows past ~12k chars,
		// and this Suitelet's prompts (full script source inlined) routinely
		// exceed that. This toggle lets a user re-verify live, turn by turn,
		// whether that bug is still present, without changing default behavior
		// for anyone who leaves it off - any failure falls back automatically to
		// the proven SuiteScript keyword-prefetch path (prefetchLiveToolResults).
		useNativeTools: false,
		modelKey: 'COHERE'
	};
	const MAX_NATIVE_TOOL_ITERATIONS = 4;
	const STRUCTURED_RESPONSE_FORMAT = {
		type: 'object',
		required: ['answer'],
		properties: {
			purpose: { type: 'string' },
			modules: { type: 'array', items: { type: 'string' } },
			records: { type: 'array', items: { type: 'string' } },
			risks: { type: 'array', items: { type: 'string' } },
			answer: { type: 'string' }
		}
	};
	// Cosine-similarity floor for a semantic cache hit (Cohere embed-english
	// v3 vectors, via llm.embed - see findSemanticCachedAnswer).
	//
	// MEASURED ON THIS ACCOUNT (2026-09-12, via the "Embed similarity vs
	// prior question" diagnostic, which is the exact same cosineSimilarity
	// call the cache itself uses): "What does this script do?" vs "What is
	// the purpose of this script?" - an unambiguous same-intent paraphrase -
	// scored 0.791. A third rewording ("Can u explain what this script
	// does?") scored 0.692 against the immediately preceding question. Both
	// 0.90 and a subsequent 0.86 attempt rejected the 0.791 pair outright,
	// which is why the cache was still missing on clear paraphrases.
	//
	// Set to 0.69 at explicit user request, to also catch the loosest
	// rewording measured in that same session ("Can u explain what this
	// script does?" vs the immediately preceding question, 0.692) - short
	// generic questions on this embedding model apparently do NOT cluster as
	// tightly as intuition suggests (no `inputType`/document-vs-query hint is
	// available on N/llm's embed() signature to improve this - every
	// llm.embed call in this project, including the proven
	// llm_embeddings_test.js, only ever passes embedModelFamily+inputs).
	//
	// WORTH WATCHING: 0.69 is below the 0.78 this project's own measured data
	// would otherwise have supported (see the two scores above), so the
	// margin against two genuinely DIFFERENT questions about the same script
	// colliding is now unverified, not just tighter - this project's own
	// earlier guidance was explicitly against a low threshold for exactly
	// this reason (a debugging copilot serving a wrong cached answer is
	// worse than a cache miss). findSemanticCachedAnswer logs the best score
	// on EVERY lookup, hit or miss ("Debug Copilot - semantic cache lookup")
	// - watch it for a different question scoring uncomfortably close to
	// 0.69, and raise this back up from that real data if so.
	const SIMILARITY_THRESHOLD = 0.69;
	const MAX_CACHE_ROWS_SCANNED = 200;
	const MAX_LOG_ROWS_DEFAULT = 20;
	const MAX_LOG_ROWS_CAP = 100;
	const MAX_MESSAGE_LENGTH = 4000;
	const MAX_TURNS_KEPT = 12;
	// TEXTAREA (customrecord_dcs_answer's field type - LONGTEXT was rejected
	// by SDF validation for customrecordcustomfield in this account) has a
	// hard, non-configurable 4000-character NetSuite platform cap. maxTokens
	// 500 keeps real answers well under this in practice, but this is a safety
	// net, not a guess: it is exactly the failure customrecord_dcs_embedding
	// hit (see EMBEDDINGS_FOLDER below) if a future answer ever runs long.
	const MAX_STORED_ANSWER_LENGTH = 3900;
	const EMBEDDINGS_FOLDER_ANCHOR_FILE = 'SuiteScripts/debug_copilot_suitelet.js';
	const EMBEDDINGS_FILE_PREFIX = 'debug_copilot_embeddings_';
	// Primary script file + up to this many same-folder relative dependencies
	// pulled in from its define([...]) array (e.g. customscript_ai_mapping_assistant's
	// scriptfile ai_mapping_assistant_suitelet.js imports './ai_mapping_assistant_engine'
	// and two more sibling modules - all real source, not guessed).
	const MAX_SOURCE_FILES = 6;
	const MAX_SOURCE_CHARS_PER_FILE = 20000;
	const MAX_TOTAL_SOURCE_CHARS = 60000;
	const MAX_STREAM_TOKENS = 4000;
	const MAX_IMAGE_BASE64_LENGTH = 3000000; // ~2.2MB decoded; keeps hidden LONGTEXT field and payload bounded
	const MIN_GOVERNANCE_UNITS_REQUIRED = 100;
	const RATE_LIMIT_PER_HOUR = 30;

	const ACTION_FIELD_ID = 'custpage_action';
	const STATE_FIELD_ID = 'custpage_state';
	const MESSAGE_FIELD_ID = 'custpage_message_input';
	const IMAGE_DATA_FIELD_ID = 'custpage_image_data';
	const IMAGE_TYPE_FIELD_ID = 'custpage_image_type';
	const LAB_POSTED_FIELD_ID = 'custpage_lab_posted';
	const SELECTED_SCRIPT_FIELD_ID = 'custpage_selected_script';
	const KB_UPLOAD_NAME_FIELD_ID = 'custpage_kb_upload_name';
	const KB_UPLOAD_CONTENT_FIELD_ID = 'custpage_kb_upload_content';
	const KB_UPLOAD_SIZE_FIELD_ID = 'custpage_kb_upload_size';
	const KB_REMOVE_DOC_ID_FIELD_ID = 'custpage_kb_remove_id';
	const CLIENT_SCRIPT_PATH = './debug_copilot_client.js';

	// ---------------------------------------------------------------------
	// Small utilities
	// ---------------------------------------------------------------------

	const isBlank = (value) => value === null || value === undefined || String(value).trim() === '';

	const escapeHtml = (text) => String(text === null || text === undefined ? '' : text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

	// Strips newlines/control chars before writing user text into logs - see
	// OWASP quick-reference "Log Injection Prevention".
	const safeLogValue = (value) => String(value === null || value === undefined ? '' : value)
		.replace(/[\r\n]/g, ' ')
		.replace(/[\x00-\x1F]/g, '')
		.substring(0, 500);

	// Diagnostic log.* calls must never themselves throw on a circular or
	// exotic (native/Java-bridged) object - fall back to String() instead.
	const safeStringify = (value) => {
		try {
			return JSON.stringify(value);
		} catch (e) {
			return String(value);
		}
	};

	// ---------------------------------------------------------------------
	// Markdown -> HTML rendering for LLM answers.
	//
	// Previously turn text went through escapeHtml() + newline-to-<br/> only,
	// so literal "**bold**" (and even "\*\*bold\*\*", when the model
	// self-escaped its own markdown) reached the page as-is instead of
	// rendering. Security: escapeHtml() runs FIRST on the raw text, and every
	// transform below only ever emits a fixed set of wrapper tags (<strong>,
	// <h3-6>, <ul>/<ol>/<li>, <code>, <pre>, <p>, <br/>) around
	// already-escaped text - none of the model's own text can ever become a
	// live tag, so this is safe against LLM-originated HTML/script injection
	// by construction, not by trying to detect/strip dangerous patterns.
	// ---------------------------------------------------------------------

	// Cohere sometimes backslash-escapes markdown punctuation (e.g. "\*\*bold\*\*").
	// Collapsed AFTER escapeHtml (backslash/asterisk are untouched by it), so
	// this only ever removes a literal backslash before markdown punctuation -
	// it cannot introduce a new HTML-significant character.
	const unescapeMarkdownEscapes = (text) => text.replace(/\\([*_`#-])/g, '$1');

	const renderInlineMarkdown = (text) => text
		.replace(/`([^`\n]+)`/g, (whole, code) => `<code>${code}</code>`)
		.replace(/\*\*([^*\n]+)\*\*/g, (whole, bold) => `<strong>${bold}</strong>`);

	const renderMarkdownToHtml = (rawText) => {
		const text = unescapeMarkdownEscapes(escapeHtml(rawText));
		const lines = text.split('\n');
		const htmlParts = [];
		let listType = null;
		let paragraphBuffer = [];
		let codeBlockBuffer = null;

		const flushParagraph = () => {
			if (paragraphBuffer.length) {
				htmlParts.push(`<p>${paragraphBuffer.map(renderInlineMarkdown).join('<br/>')}</p>`);
				paragraphBuffer = [];
			}
		};
		const closeList = () => {
			if (listType) {
				htmlParts.push(`</${listType}>`);
				listType = null;
			}
		};

		lines.forEach((line) => {
			const trimmed = line.trim();

			if (/^```/.test(trimmed)) {
				if (codeBlockBuffer === null) {
					flushParagraph();
					closeList();
					codeBlockBuffer = [];
				} else {
					htmlParts.push(`<pre><code>${codeBlockBuffer.join('\n')}</code></pre>`);
					codeBlockBuffer = null;
				}
				return;
			}
			if (codeBlockBuffer !== null) {
				codeBlockBuffer.push(line);
				return;
			}

			const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
			if (headingMatch) {
				flushParagraph();
				closeList();
				const level = Math.min(headingMatch[1].length + 2, 6);
				htmlParts.push(`<h${level} class="dcs-answer-heading">${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
				return;
			}

			const bulletMatch = /^[-*]\s+(.*)$/.exec(trimmed);
			if (bulletMatch) {
				flushParagraph();
				if (listType !== 'ul') {
					closeList();
					htmlParts.push('<ul>');
					listType = 'ul';
				}
				htmlParts.push(`<li>${renderInlineMarkdown(bulletMatch[1])}</li>`);
				return;
			}

			const numberedMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
			if (numberedMatch) {
				flushParagraph();
				if (listType !== 'ol') {
					closeList();
					htmlParts.push('<ol>');
					listType = 'ol';
				}
				htmlParts.push(`<li>${renderInlineMarkdown(numberedMatch[1])}</li>`);
				return;
			}

			if (trimmed === '') {
				flushParagraph();
				closeList();
				return;
			}

			closeList();
			paragraphBuffer.push(line);
		});

		flushParagraph();
		closeList();
		if (codeBlockBuffer !== null && codeBlockBuffer.length) {
			htmlParts.push(`<pre><code>${codeBlockBuffer.join('\n')}</code></pre>`);
		}

		return htmlParts.join('\n') || '<p></p>';
	};

	const safeParseJson = (text, fallback) => {
		try {
			return JSON.parse(text);
		} catch (e) {
			return fallback;
		}
	};

	const cosineSimilarity = (a, b) => {
		if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) {
			return 0;
		}
		let dot = 0;
		let magA = 0;
		let magB = 0;
		for (let i = 0; i < a.length; i += 1) {
			const valA = Number(a[i]);
			const valB = Number(b[i]);
			if (!Number.isFinite(valA) || !Number.isFinite(valB)) {
				return 0;
			}
			dot += valA * valB;
			magA += valA * valA;
			magB += valB * valB;
		}
		if (!magA || !magB) {
			return 0;
		}
		return dot / (Math.sqrt(magA) * Math.sqrt(magB));
	};

	const mergeLab = (value) => Object.assign({}, DEFAULT_LAB, value || {});

	const readLabFromParams = (params, previous) => {
		if (!params || params[LAB_POSTED_FIELD_ID] !== 'T') {
			return mergeLab(previous);
		}
		return {
			useRag: params.custpage_lab_rag === 'T',
			// No longer a checkbox (see buildLabPanelHtml's comment) - the
			// keyword-gated live-data lookups underneath this flag are plain
			// SuiteScript/SuiteQL, not an N/llm feature, so there was nothing
			// to demo by letting a user turn them off. Always on; the "AI
			// Features" list now only lists things that actually exercise
			// N/llm. Native tool-calling (a real N/llm feature) still has its
			// own toggle and still depends on this being true.
			useTools: true,
			useCache: params.custpage_lab_cache === 'T',
			useSafety: params.custpage_lab_safety === 'T',
			useJson: params.custpage_lab_json === 'T',
			usePromptStudio: params.custpage_lab_promptstudio === 'T',
			useNativeTools: params.custpage_lab_nativetools === 'T',
			modelKey: params.custpage_lab_model === 'GPT_OSS' ? 'GPT_OSS' : 'COHERE'
		};
	};

	const getPromptStudioId = () => {
		const raw = runtime.getCurrentScript().getParameter({
			name: PROMPT_STUDIO_PARAM
		});
		return isBlank(raw) ? '' : String(raw).trim();
	};

	const resolveGptOssFamily = () => {
		const keys = ['GPT_OSS', 'OPENAI_GPT_OSS', 'GPT_OSS_120B'];
		for (let i = 0; i < keys.length; i += 1) {
			if (llm.ModelFamily && llm.ModelFamily[keys[i]]) {
				return llm.ModelFamily[keys[i]];
			}
		}
		return null;
	};

	const resolveSafetyMode = () => {
		if (llm.SafetyMode && llm.SafetyMode.CONTEXTUAL) {
			return llm.SafetyMode.CONTEXTUAL;
		}
		return 'CONTEXTUAL';
	};

	const summarizeCitations = (citations) => {
		if (!Array.isArray(citations) || !citations.length) {
			return [];
		}
		return citations.slice(0, 8).map((citation) => ({
			documentIds: citation.documentIds || [],
			text: citation.text || '',
			start: citation.start,
			end: citation.end
		}));
	};

	const summarizeUsage = (usage) => {
		if (!usage || typeof usage !== 'object') {
			return null;
		}
		return {
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
			totalTokens: usage.totalTokens
		};
	};

	const formatStructuredAnswer = (text) => {
		const parsed = safeParseJson(text, null);
		if (!parsed || typeof parsed !== 'object') {
			return text || '';
		}
		return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
	};

	// ---------------------------------------------------------------------
	// Rate limiting (OWASP quick-reference section 8) - protects AI Unit
	// spend from a runaway client loop or accidental double-submit, not from
	// a hostile caller (this Suitelet already requires login + role audience).
	// ---------------------------------------------------------------------

	const checkRateLimit = () => {
		const rateLimitCache = cache.getCache({ name: 'debug_copilot_rate_limit', scope: cache.Scope.PUBLIC });
		const userId = String(runtime.getCurrentUser().id);
		const count = parseInt(rateLimitCache.get({ key: userId }) || '0', 10);
		if (count >= RATE_LIMIT_PER_HOUR) {
			return false;
		}
		rateLimitCache.put({ key: userId, value: String(count + 1), ttl: 3600 });
		return true;
	};

	// ---------------------------------------------------------------------
	// Knowledge documents (RAG)
	// ---------------------------------------------------------------------

	// Lists user-uploaded KB rows (customrecord_dcs_document), newest first.
	// Never throws - a query/permission failure degrades to "no uploads",
	// same as a missing built-in file degrading to "skip that one doc".
	const listUploadedKbDocuments = () => {
		try {
			return query.runSuiteQL({
				query: `SELECT * FROM (
					SELECT id, custrecord_dcsdoc_name AS name, custrecord_dcsdoc_file AS fileid,
						custrecord_dcsdoc_extension AS extension, custrecord_dcsdoc_size AS filesize,
						custrecord_dcsdoc_active AS active
					FROM ${KB_DOCUMENT_RECORD_TYPE}
					ORDER BY id DESC
				) WHERE ROWNUM <= ?`,
				params: [MAX_KB_DOCUMENTS * 2] // *2 headroom for inactive rows kept around after a toggle-off, still bounded
			}).asMappedResults();
		} catch (e) {
			log.error({ title: 'Debug Copilot - listing KB documents failed', details: `${e.name || 'ERROR'} - ${e.message || ''}` });
			return [];
		}
	};

	// One list combining the 4 always-on built-ins with active uploads, for
	// both the right-panel display and computeContextHash() - the exact set
	// a cached answer was generated against.
	const buildKnowledgeBaseListing = () => {
		const uploaded = listUploadedKbDocuments();
		const active = uploaded.filter((row) => row.active === 'T');
		return {
			builtin: KNOWLEDGE_FILES.map((entry) => ({ id: entry.id, name: entry.file, builtin: true, active: true })),
			uploaded: uploaded.map((row) => ({
				id: String(row.id),
				name: row.name,
				extension: row.extension,
				size: row.filesize,
				builtin: false,
				active: row.active === 'T'
			})),
			activeUploadedIds: active.map((row) => String(row.id))
		};
	};

	// Built-ins are always sent; active uploads are appended up to
	// MAX_RAG_DOCUMENTS_PER_TURN combined, so one heavy upload session can't
	// blow out prompt size/governance for every future turn.
	const loadKnowledgeDocuments = (kbListing) => {
		const builtinDocs = KNOWLEDGE_FILES.map((entry) => {
			try {
				const loadedFile = file.load({ id: KNOWLEDGE_FOLDER + entry.file });
				return llm.createDocument({ id: entry.id, data: loadedFile.getContents() });
			} catch (e) {
				log.error({ title: 'Debug Copilot - knowledge doc load failed', details: `${entry.file}: ${e.name || 'ERROR'} - ${e.message || ''}` });
				return null;
			}
		}).filter(Boolean);

		const remainingSlots = Math.max(MAX_RAG_DOCUMENTS_PER_TURN - builtinDocs.length, 0);
		const uploadedDocs = (kbListing.uploaded || [])
			.filter((row) => row.active)
			.slice(0, remainingSlots)
			.map((row) => {
				// Re-validate extension at load time too, not just at upload
				// time - a document uploaded before ALLOWED_KB_EXTENSIONS was
				// tightened, or edited directly in the UI, should not be
				// silently trusted.
				if (ALLOWED_KB_EXTENSIONS.indexOf(String(row.extension || '').toLowerCase()) === -1) {
					log.audit({ title: 'Debug Copilot - skipped KB upload with unsupported extension', details: JSON.stringify({ id: row.id, name: row.name, extension: row.extension }) });
					return null;
				}
				try {
					const loadedFile = file.load({ id: `${KNOWLEDGE_UPLOAD_FOLDER}${row.name}` });
					return llm.createDocument({ id: `upload_${row.id}`, data: loadedFile.getContents() });
				} catch (e) {
					log.error({ title: 'Debug Copilot - uploaded KB doc load failed', details: `${row.name}: ${e.name || 'ERROR'} - ${e.message || ''}` });
					return null;
				}
			})
			.filter(Boolean);

		return builtinDocs.concat(uploadedDocs);
	};

	// File-extension + size + non-empty validation for an uploaded KB
	// document. Returns { ok: true } or { ok: false, message } - message is
	// always safe to show the user directly (never a raw platform error).
	const validateKbUpload = (uploadedFile, existingListing) => {
		if (!uploadedFile) {
			return { ok: false, message: 'Please choose a file to upload.' };
		}
		const name = String(uploadedFile.name || '');
		const hasExtension = name.indexOf('.') > 0 && name.indexOf('.') < name.length - 1;
		if (!hasExtension) {
			return { ok: false, message: 'That file has no extension. Supported formats: TXT, MD.' };
		}
		const extension = (name.split('.').pop() || '').toLowerCase();
		if (ALLOWED_KB_EXTENSIONS.indexOf(extension) === -1) {
			return { ok: false, message: `Unsupported file type ".${extension}". Supported formats: TXT, MD. (PDF/DOC/DOCX/images cannot currently be turned into text this account can pass to the model, so they are not accepted rather than silently mishandled.)` };
		}
		const size = uploadedFile.size || 0;
		if (size <= 0) {
			return { ok: false, message: 'That file appears to be empty.' };
		}
		if (size > MAX_KB_DOCUMENT_BYTES) {
			return { ok: false, message: `File is too large (max ${Math.round(MAX_KB_DOCUMENT_BYTES / 1000)}KB for a knowledge document).` };
		}
		const totalActive = existingListing.builtin.length + existingListing.activeUploadedIds.length;
		if (totalActive >= KNOWLEDGE_FILES.length + MAX_KB_DOCUMENTS) {
			return { ok: false, message: `Knowledge Base is full (max ${MAX_KB_DOCUMENTS} uploaded documents). Remove one before adding another.` };
		}
		const lowerName = name.toLowerCase();
		// Uploads are saved into the SAME File Cabinet folder as the 4
		// built-ins (see KNOWLEDGE_UPLOAD_FOLDER's comment) - a same-named
		// upload would silently overwrite a built-in knowledge file on disk,
		// not just look like a duplicate in the list, so this check must
		// also cover KNOWLEDGE_FILES, not only prior uploads.
		const collidesWithBuiltin = KNOWLEDGE_FILES.some((entry) => entry.file.toLowerCase() === lowerName);
		if (collidesWithBuiltin) {
			return { ok: false, message: `"${name}" is a reserved name used by a built-in knowledge document. Please rename the file and try again.` };
		}
		const isDuplicate = existingListing.uploaded.some((row) => row.active && row.name.toLowerCase() === lowerName);
		if (isDuplicate) {
			return { ok: false, message: `A document named "${name}" is already in the knowledge base.` };
		}
		return { ok: true };
	};

	// Resolves the Knowledge Base folder's internal id via one of the
	// built-in files that is guaranteed to already exist there - see
	// KNOWLEDGE_UPLOAD_FOLDER's comment on why uploads share this folder
	// rather than a new subfolder. Falls back to the SuiteScripts root only
	// if every built-in file is somehow missing (a broken deployment state
	// this Suitelet already degrades gracefully for elsewhere).
	const resolveKnowledgeUploadFolderId = () => {
		try {
			return file.load({ id: KNOWLEDGE_FOLDER + KNOWLEDGE_FILES[0].file }).folder;
		} catch (e) {
			return resolveSuiteScriptsFolderId();
		}
	};

	// uploadedFile here is a plain { name, size, contents } object built from
	// the hidden fields the client script fills in after reading the file
	// as text in the browser (readAndAttachKbFile) - not an N/file File or a
	// context.request.files entry. See buildKbPanelHtml's comment on why a
	// native FILE field was dropped in favor of this in-page pattern.
	const handleUploadKbDocument = (state, uploadedFile) => {
		const listing = buildKnowledgeBaseListing();
		const validation = validateKbUpload(uploadedFile, listing);
		if (!validation.ok) {
			state.notice = validation.message;
			return state;
		}
		try {
			const extension = String(uploadedFile.name).split('.').pop().toLowerCase();
			const savedFile = file.create({
				name: uploadedFile.name,
				fileType: file.Type.PLAINTEXT,
				contents: uploadedFile.contents,
				folder: resolveKnowledgeUploadFolderId(),
				encoding: file.Encoding.UTF8,
				isOnline: false
			});
			const fileId = savedFile.save();

			const rec = record.create({ type: KB_DOCUMENT_RECORD_TYPE, isDynamic: false });
			rec.setValue({ fieldId: 'custrecord_dcsdoc_name', value: uploadedFile.name });
			rec.setValue({ fieldId: 'custrecord_dcsdoc_file', value: fileId });
			rec.setValue({ fieldId: 'custrecord_dcsdoc_extension', value: extension });
			rec.setValue({ fieldId: 'custrecord_dcsdoc_size', value: uploadedFile.size || 0 });
			rec.setValue({ fieldId: 'custrecord_dcsdoc_active', value: true });
			rec.setValue({ fieldId: 'custrecord_dcsdoc_uploadedby', value: runtime.getCurrentUser().id });
			rec.save();

			state.notice = `"${uploadedFile.name}" was added to the Knowledge Base.`;
			state.noticeType = 'success';
			log.audit({ title: 'Debug Copilot - KB document uploaded', details: JSON.stringify({ name: uploadedFile.name, size: uploadedFile.size, user: runtime.getCurrentUser().id }) });
		} catch (e) {
			log.error({ title: 'Debug Copilot - KB document upload failed', details: `${e.name || 'ERROR'} - ${e.message || ''}` });
			state.notice = 'Could not upload that document. Please try again.';
		}
		return state;
	};

	const handleRemoveKbDocument = (state, docId) => {
		if (isBlank(docId)) {
			state.notice = 'No document was specified to remove.';
			return state;
		}
		try {
			const rec = record.load({ type: KB_DOCUMENT_RECORD_TYPE, id: docId });
			const fileId = rec.getValue({ fieldId: 'custrecord_dcsdoc_file' });
			const name = rec.getValue({ fieldId: 'custrecord_dcsdoc_name' });
			record.delete({ type: KB_DOCUMENT_RECORD_TYPE, id: docId });
			if (!isBlank(fileId)) {
				try {
					file.delete({ id: fileId });
				} catch (fileErr) {
					// Record row is already gone (the part that matters for
					// RAG/listing) - an orphaned File Cabinet file is a minor
					// cleanup issue, not worth failing the whole action over.
					log.error({ title: 'Debug Copilot - KB document file cleanup failed', details: `${fileErr.name || 'ERROR'} - ${fileErr.message || ''}` });
				}
			}
			state.notice = `"${name}" was removed from the Knowledge Base.`;
			state.noticeType = 'success';
			log.audit({ title: 'Debug Copilot - KB document removed', details: JSON.stringify({ docId, name }) });
		} catch (e) {
			log.error({ title: 'Debug Copilot - KB document removal failed', details: `${e.name || 'ERROR'} - ${e.message || ''}` });
			state.notice = 'Could not remove that document. It may have already been deleted.';
		}
		return state;
	};

	// ---------------------------------------------------------------------
	// "Tools" - SuiteScript-side prefetch, not N/llm native tool-calling.
	//
	// This project used to also define llm.createTool/createToolParameter
	// schemas here and pass them as generateText's `tools` option, with a
	// response.toolCalls loop in runConversationTurn to execute them. That
	// path was never actually reachable: `tools` was always sent as `[]` in
	// handleAsk (generateText({tools}) throws a generic UNEXPECTED_ERROR on
	// this account once the prompt is long or the model actually emits a
	// call - see the KNOWN PLATFORM ISSUE note in the file header), so
	// response.toolCalls could never be populated and that loop could never
	// run. It has been removed rather than kept as a switch to flip if the
	// platform bug is ever fixed - re-add llm.createTool/createToolParameter
	// here and the toolCalls loop in runConversationTurn if that is ever
	// verified fixed on this account.
	//
	// What actually works, and is unchanged, is this: SuiteScript decides
	// (via LIVE_DATA_KEYWORDS below) whether a question needs live account
	// data, calls the executor function directly, and injects the JSON
	// result as plain text into the prompt (buildToolResultsBlock). The
	// model never "chooses" to call a tool - the keyword gate chooses for
	// it, before generation starts.
	// ---------------------------------------------------------------------

	// Isolates the one combination never independently proven anywhere in
	// this project: `tools` + `documents` + `modelParameters` together in a
	// single generateText call. Every proven-working example either has
	// tools with no documents/modelParameters (llm_tool_call_test.js) or
	// documents/modelParameters with no tools (llm_rag_test.js) - never all
	// three. This was also explicitly requested independently: basic source
	// questions ("what does this do", "what modules does it use") should be
	// answered directly from the supplied source, not via a tool call, and
	// should not need tools offered at all. Keyword-gated rather than
	// removing tools outright, so getExecutionLogForScript/
	// lookupRecordFieldSchema remain available for the live-data questions
	// they exist for.
	const LIVE_DATA_KEYWORDS = [
		'error', 'errors', 'exception', 'failure', 'failed', 'fail',
		'log', 'logs', 'execution log', 'executed', 'ran', 'run',
		'deploy', 'deployment', 'recent', 'latest', 'last run', 'happened',
		'field', 'fields', 'schema', 'record type', 'record metadata',
		'field metadata', 'lookuprecordfieldschema', 'sublist'
	];
	const questionNeedsLiveTools = (question) => {
		const lower = String(question || '').toLowerCase();
		return LIVE_DATA_KEYWORDS.some((keyword) => lower.indexOf(keyword) !== -1);
	};

	const inferRecordTypeForSchema = (question) => {
		const lower = String(question || '').toLowerCase();
		if (lower.indexOf('sales order') !== -1 || lower.indexOf('salesorder') !== -1) {
			return 'salesorder';
		}
		if (lower.indexOf('customer') !== -1) {
			return 'customer';
		}
		if (lower.indexOf('vendor') !== -1) {
			return 'vendor';
		}
		if (lower.indexOf('invoice') !== -1) {
			return 'invoice';
		}
		return 'salesorder';
	};

	// N/llm generateText({ tools }) works on a short first turn (this account)
	// and throws a generic Unexpected Error once the prompt grows (~12k) or
	// the model actually has to emit a tool call. Prefetch in SuiteScript and
	// inject the JSON so generateText stays text-only.
	const prefetchLiveToolResults = (question, state) => {
		const lower = String(question || '').toLowerCase();
		const trace = [];
		if (/error|exception|log|latest|last run|happened/.test(lower)) {
			const parameters = {
				scriptId: state.targetScriptId || '',
				deploymentId: state.targetDeploymentId || '',
				limit: '20'
			};
			const outputs = executeGetExecutionLogForScript(parameters);
			trace.push({ name: 'getExecutionLogForScript', parameters, outputs });
		}
		if (/field|schema|lookuprecordfieldschema|sublist/.test(lower)) {
			const parameters = { recordType: inferRecordTypeForSchema(question) };
			const outputs = executeLookupRecordFieldSchema(parameters);
			const first = outputs[0];
			if (first && first.fields && first.fields.length > 40) {
				outputs[0] = {
					recordType: first.recordType,
					fieldCount: first.fieldCount,
					fields: first.fields.slice(0, 40),
					sublists: (first.sublists || []).slice(0, 8),
					note: 'Truncated to 40 fields for the prompt.'
				};
			}
			trace.push({ name: 'lookupRecordFieldSchema', parameters, outputs });
		}
		return trace;
	};

	// ---------------------------------------------------------------------
	// Native N/llm tool-calling (EXPERIMENTAL, opt-in via lab.useNativeTools)
	//
	// This is the real thing the "Tools" section comment above says was
	// removed: the model itself decides whether to call a tool, via
	// response.toolCalls, rather than a SuiteScript keyword regex deciding
	// for it before generation starts. The exact llm.createTool/
	// createToolParameter/createToolResult shape below is proven working on
	// this account by llm_tool_call_test.js - for a SHORT, document-free,
	// single-tool prompt. This Suitelet's prompts are not short (full script
	// source is inlined, up to MAX_TOTAL_SOURCE_CHARS), which is exactly the
	// condition the file header's "KNOWN PLATFORM ISSUE" note says previously
	// broke generateText({tools}) on this account. So this is deliberately:
	//   - opt-in only (DEFAULT_LAB.useNativeTools is false)
	//   - isolated from `documents`/RAG in the same call, per the file header's
	//     "Isolates the one combination never independently proven" note -
	//     native tools are attempted tools-only, not tools+documents+source
	//     together, so a failure here says something specific about tools
	//     alone, not a confound with RAG
	//   - wrapped by the caller in try/catch with a full fallback to the
	//     existing prefetchLiveToolResults path on ANY failure, so turning
	//     this on can never make a turn fail outright - only fall back
	// Turn this on in the lab panel and watch the execution log for
	// "Debug Copilot - native tool-calling succeeded" vs "...failed" to
	// re-verify, on this specific account, whether the platform bug is still
	// present. Do not flip DEFAULT_LAB.useNativeTools to true until that has
	// been confirmed clean across several real questions/scripts.
	// ---------------------------------------------------------------------

	const buildLiveDataTools = () => [
		llm.createTool({
			name: 'getExecutionLogForScript',
			description: 'Retrieves recent execution log entries (scriptnote) for the currently selected script, across all its deployments - use this for questions about errors, exceptions, or what happened on a recent run that are not answerable from the source code alone.',
			parameters: [
				llm.createToolParameter({ name: 'limit', description: 'Max number of log entries to return (1-100, default 20)', type: 'STRING' })
			]
		}),
		llm.createTool({
			name: 'lookupRecordFieldSchema',
			description: 'Retrieves the live field and sublist schema (ids, labels, types, mandatory flags) for a NetSuite record type such as salesorder, customer, invoice, or vendor - use this for questions about field IDs or record structure that are not defined in the script source itself.',
			parameters: [
				llm.createToolParameter({ name: 'recordType', description: 'NetSuite record type internal id, e.g. "salesorder"', type: 'STRING' }),
				llm.createToolParameter({ name: 'fieldId', description: 'Optional: a single field id to look up instead of the full schema', type: 'STRING' })
			]
		})
	];

	const executeNamedTool = (name, parameters, state) => {
		if (name === 'getExecutionLogForScript') {
			return executeGetExecutionLogForScript(Object.assign(
				{ scriptId: state.targetScriptId, deploymentId: state.targetDeploymentId },
				parameters
			));
		}
		if (name === 'lookupRecordFieldSchema') {
			return executeLookupRecordFieldSchema(parameters || {});
		}
		return [{ error: `Unknown tool "${name}"` }];
	};

	// Throws on any failure (construction, first call, or mid-loop) - the
	// caller (handleAsk) is responsible for catching this and falling back to
	// prefetchLiveToolResults. Never partially applied: either this returns a
	// complete { text, toolTrace, response } from the model having genuinely
	// finished its tool-calling turn, or it throws and nothing from here is
	// used.
	const attemptNativeToolCalling = ({ promptText, preamble, modelFamily, state }) => {
		const tools = buildLiveDataTools();
		const toolTrace = [];

		const firstOptions = {
			prompt: promptText,
			modelFamily,
			tools,
			modelParameters: { maxTokens: 1200, temperature: 0.2 }
		};
		if (preamble) {
			firstOptions.preamble = preamble;
		}

		let response = llm.generateText(firstOptions);
		let iterations = 0;
		while (response.toolCalls && response.toolCalls.length && iterations < MAX_NATIVE_TOOL_ITERATIONS) {
			iterations += 1;
			const toolResults = response.toolCalls.map((call) => {
				const outputs = executeNamedTool(call.name, call.parameters || {}, state);
				toolTrace.push({ name: call.name, parameters: call.parameters || {}, outputs });
				return llm.createToolResult({ call, outputs });
			});
			response = llm.generateText({ modelFamily, tools, toolResults, chatHistory: response.chatHistory });
		}

		return { response, text: response.text || '', toolTrace, iterations };
	};

	const buildToolResultsBlock = (toolTrace) => {
		if (!toolTrace.length) {
			return '';
		}
		return [
			'Live account data fetched by SuiteScript (not via N/llm tool-calling):',
			JSON.stringify(toolTrace.map((row) => ({
				name: row.name,
				parameters: row.parameters,
				outputs: row.outputs
			}))).substring(0, 12000)
		].join('\n');
	};

	const resolveScriptRow = (scriptId) => {
		const rows = query.runSuiteQL({
			query: 'SELECT id, name, scriptfile FROM script WHERE scriptid = ?',
			params: [scriptId]
		}).asMappedResults();
		return rows[0] || null;
	};

	// scriptnote has no per-deployment column (confirmed against the SAFE
	// Guide's documented system-table schema) - log entries are scoped to the
	// script as a whole, across all of its deployments.
	const executeGetExecutionLogForScript = (params) => {
		try {
			const scriptId = params.scriptId;
			if (isBlank(scriptId)) {
				return [{ error: 'scriptId is required' }];
			}
			const limit = Math.min(Math.max(parseInt(params.limit, 10) || MAX_LOG_ROWS_DEFAULT, 1), MAX_LOG_ROWS_CAP);
			const scriptRow = resolveScriptRow(scriptId);
			if (!scriptRow) {
				return [{ error: `No script found with scriptid ${scriptId}` }];
			}

			let deploymentNote = null;
			if (!isBlank(params.deploymentId)) {
				const deploymentRows = query.runSuiteQL({
					query: 'SELECT sd.scriptid, sd.title, sd.isdeployed, sd.status FROM scriptdeployment sd WHERE sd.scriptid = ? AND sd.script = ?',
					params: [params.deploymentId, scriptRow.id]
				}).asMappedResults();
				deploymentNote = deploymentRows[0] || { warning: `Deployment ${params.deploymentId} was not found for script ${scriptId}.` };
			}

			const logRows = query.runSuiteQL({
				query: `SELECT * FROM (
					SELECT sn.date, sn.type, sn.title, sn.detail
					FROM scriptnote sn
					WHERE sn.scripttype = ?
					ORDER BY sn.date DESC
				) WHERE ROWNUM <= ?`,
				params: [scriptRow.id, limit]
			}).asMappedResults();

			return [{
				scriptId,
				scriptName: scriptRow.name,
				deployment: deploymentNote,
				note: 'Log entries are scoped to the script across all of its deployments.',
				entryCount: logRows.length,
				entries: logRows
			}];
		} catch (e) {
			return [{ error: `getExecutionLogForScript failed: ${e.name || 'ERROR'} - ${e.message || ''}` }];
		}
	};

	const buildFieldSummary = (rec, fieldId) => {
		const field = rec.getField({ fieldId });
		if (!field) {
			return null;
		}
		return { id: fieldId, label: field.label, type: field.type, isMandatory: field.isMandatory };
	};

	const executeLookupRecordFieldSchema = (params) => {
		try {
			const recordType = params.recordType;
			if (isBlank(recordType)) {
				return [{ error: 'recordType is required' }];
			}

			let rec;
			try {
				rec = record.create({ type: recordType, isDynamic: true });
			} catch (e) {
				return [{ error: `Could not open record type "${recordType}": ${e.name || 'ERROR'} - it may not exist, or this role may lack view permission on it.` }];
			}

			if (!isBlank(params.fieldId)) {
				const summary = buildFieldSummary(rec, params.fieldId);
				return summary
					? [{ recordType, field: summary }]
					: [{ error: `Field "${params.fieldId}" was not found on record type "${recordType}"` }];
			}

			const fields = (rec.getFields() || []).map((id) => buildFieldSummary(rec, id)).filter(Boolean);
			const sublists = (rec.getSublists() || []).map((sublistId) => ({
				id: sublistId,
				fields: rec.getSublistFields({ sublistId }) || []
			}));

			return [{ recordType, fieldCount: fields.length, fields, sublists }];
		} catch (e) {
			return [{ error: `lookupRecordFieldSchema failed: ${e.name || 'ERROR'} - ${e.message || ''}` }];
		}
	};

	// ---------------------------------------------------------------------
	// Selected-script source pipeline
	//
	// This is the piece that was previously entirely missing: the Suitelet
	// never loaded the selected script's actual source anywhere, so every
	// question that wasn't literally about "debugging" hit the old prompt's
	// generic "politely decline" instruction with nothing to ground an answer
	// in. Flow: scriptId -> script.scriptfile (real File Cabinet id from the
	// script record, not guessed) -> file.load() for the real source ->
	// follow same-folder relative define([...]) dependencies (e.g.
	// './ai_mapping_assistant_engine') -> assemble a capped, labeled source
	// context block -> inlined directly into the prompt text in
	// buildInstructionPrompt (not just added as a `documents` RAG entry) so
	// the model is guaranteed the full text rather than a retrieval excerpt,
	// matching what deep "walk me through function by function" style
	// questions need.
	// ---------------------------------------------------------------------

	// Only follows same-folder './x' relative deps, matching every real
	// example in this project (ai_mapping_assistant_*, shopify_onboarding_*).
	// '../' deps are skipped rather than guessed at, since resolving a parent
	// directory correctly needs real path-segment handling this project has
	// never needed - a skipped dependency degrades to "not included" (logged),
	// not a wrong file silently loaded.
	const extractLocalDependencies = (sourceText) => {
		const defineMatch = /define\s*\(\s*\[([^\]]*)\]/.exec(sourceText || '');
		if (!defineMatch) {
			return [];
		}
		const deps = [];
		const stringPattern = /['"]([^'"]+)['"]/g;
		let match = stringPattern.exec(defineMatch[1]);
		while (match !== null) {
			if (match[1].indexOf('./') === 0) {
				deps.push(match[1].substring(2));
			}
			match = stringPattern.exec(defineMatch[1]);
		}
		return deps;
	};

	const truncateSource = (text, maxChars) => {
		const safeText = text || '';
		if (safeText.length <= maxChars) {
			return { text: safeText, truncated: false };
		}
		return {
			text: `${safeText.substring(0, maxChars)}\n/* ...[truncated: showing ${maxChars} of ${safeText.length} characters]... */`,
			truncated: true
		};
	};

	// Returns { files: [{path,name,text,truncated,note}], scriptName,
	// primaryFilePath, sourceMissing, sourceTruncated, error }. Never throws -
	// a missing/unreadable source degrades to sourceMissing:true with a
	// human-readable reason, so generation can still proceed (tools/reference
	// docs only) instead of failing the whole turn.
	const loadScriptSourceContext = (scriptId) => {
		const empty = (scriptName, error) => ({ files: [], scriptName: scriptName || '', primaryFilePath: '', sourceMissing: true, sourceTruncated: false, error });

		if (isBlank(scriptId)) {
			return empty('', 'No script is selected.');
		}

		let scriptRow;
		try {
			scriptRow = resolveScriptRow(scriptId);
		} catch (e) {
			return empty('', `Could not look up script "${scriptId}": ${e.name || 'ERROR'} - ${e.message || ''}`);
		}
		if (!scriptRow) {
			return empty('', `No script found with scriptid ${scriptId}.`);
		}
		if (isBlank(scriptRow.scriptfile)) {
			return empty(scriptRow.name, 'This script record has no source file on file.');
		}

		let mainFile;
		try {
			mainFile = file.load({ id: scriptRow.scriptfile });
		} catch (e) {
			return empty(scriptRow.name, `Could not load the script's source file: ${e.name || 'ERROR'} - ${e.message || ''}`);
		}

		const files = [];
		let totalChars = 0;
		let skippedForSpace = false;

		const addFile = (loadedFile, note) => {
			if (files.length >= MAX_SOURCE_FILES || totalChars >= MAX_TOTAL_SOURCE_CHARS) {
				skippedForSpace = true;
				return;
			}
			const remaining = Math.max(MAX_TOTAL_SOURCE_CHARS - totalChars, 0);
			const perFileCap = Math.min(MAX_SOURCE_CHARS_PER_FILE, remaining);
			const result = truncateSource(loadedFile.getContents(), perFileCap);
			totalChars += result.text.length;
			if (result.truncated) {
				skippedForSpace = true;
			}
			files.push({ path: loadedFile.path, name: loadedFile.name, text: result.text, truncated: result.truncated, note: note || null });
		};

		addFile(mainFile, 'primary script file, from the script record');

		const dirPath = mainFile.path.substring(0, mainFile.path.lastIndexOf('/') + 1);
		const dependencies = extractLocalDependencies(mainFile.getContents());
		let dependenciesLoaded = 0;
		dependencies.forEach((dep) => {
			if (files.length >= MAX_SOURCE_FILES) {
				skippedForSpace = true;
				return;
			}
			try {
				const depFile = file.load({ id: `${dirPath}${dep}.js` });
				addFile(depFile, 'imported by the primary script file');
				dependenciesLoaded += 1;
			} catch (e) {
				skippedForSpace = true;
				log.debug({ title: 'Debug Copilot - could not load dependency source file', details: safeStringify({ scriptId, dep, errorMessage: e && e.message }) });
			}
		});

		return {
			files,
			scriptName: scriptRow.name,
			primaryFilePath: mainFile.path,
			sourceMissing: false,
			sourceTruncated: skippedForSpace || dependenciesLoaded < dependencies.length,
			error: null
		};
	};

	const summarizeSourceContext = (sourceContext) => ({
		primaryFilePath: sourceContext.primaryFilePath || '',
		fileNames: sourceContext.files.map((f) => f.name),
		sourceMissing: sourceContext.sourceMissing,
		sourceTruncated: !!sourceContext.sourceTruncated,
		error: sourceContext.error || null
	});

	const buildScriptContextBlock = (sourceContext) => {
		if (sourceContext.sourceMissing) {
			return `No source code could be loaded for this script (${sourceContext.error || 'unknown reason'}). Do not claim to have read the source - answer only from tools/reference docs, or say plainly that source-level questions can't be answered right now.`;
		}
		const fileBlocks = sourceContext.files
			.map((f) => `--- ${f.name}${f.note ? ` (${f.note})` : ''} ---\n${f.text}`)
			.join('\n\n');
		return [
			`Primary source file: ${sourceContext.primaryFilePath}`,
			sourceContext.sourceTruncated ? 'Note: not all related files, or not the full contents of every file, could be included below due to size limits.' : '',
			'',
			fileBlocks
		].filter(Boolean).join('\n');
	};

	// ---------------------------------------------------------------------
	// Embeddings cache (customrecord_debug_session + one File Cabinet JSON
	// index per script)
	//
	// A JSON-stringified Cohere embedding vector runs many thousands of
	// characters - far past the 4000-char hard cap on the TEXTAREA field
	// custrecord_dcs_embedding used to be (INVALID_FLD_VALUE in production).
	// LONGTEXT was tried first and rejected by this account's SDF validator
	// for customrecordcustomfield, so the field was dropped entirely and
	// embeddings now live in a File Cabinet JSON file - the same pattern
	// llm_salesorder_rag_assistant.js already uses successfully in this
	// project for its own knowledge-base embeddings (load-or-create JSON,
	// keyed content, no field-length limit). One file per scriptId, keyed by
	// the customrecord_debug_session record's internal id, so a single
	// file.load() per cache lookup covers every cached session for that
	// script instead of loading per-row.
	// ---------------------------------------------------------------------

	const sanitizeForFilename = (value) => String(value || 'unknown')
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_')
		.substring(0, 80);

	const embeddingsFileName = (scriptId) => `${EMBEDDINGS_FILE_PREFIX}${sanitizeForFilename(scriptId)}.json`;

	const resolveSuiteScriptsFolderId = () => file.load({ id: EMBEDDINGS_FOLDER_ANCHOR_FILE }).folder;

	// Returns { [recordId]: number[] }. Missing/corrupt file -> {} (empty
	// cache for this script, not an error - every script starts with none).
	const loadEmbeddingsIndex = (scriptId) => {
		try {
			const loadedFile = file.load({ id: `SuiteScripts/${embeddingsFileName(scriptId)}` });
			const parsed = safeParseJson(loadedFile.getContents(), null);
			return parsed && typeof parsed === 'object' ? parsed : {};
		} catch (e) {
			return {};
		}
	};

	const saveEmbeddingsIndex = (scriptId, index) => {
		const fileName = embeddingsFileName(scriptId);
		const contents = JSON.stringify(index);
		try {
			const existing = file.load({ id: `SuiteScripts/${fileName}` });
			existing.contents = contents;
			return existing.save();
		} catch (e) {
			const created = file.create({
				name: fileName,
				fileType: file.Type.JSON,
				contents,
				folder: resolveSuiteScriptsFolderId(),
				encoding: file.Encoding.UTF8
			});
			return created.save();
		}
	};

	// Matches both the current "can't determine" fallback and the older
	// pre-source-pipeline "I can only answer debugging questions" refusal, so
	// a bad answer cached during EITHER earlier broken state is recognized.
	// A cache built from generated answers has no natural way to tell "this
	// was a good answer" from "this was a refusal we should never have kept"
	// - this is that check, applied both when reading the cache (so an
	// already-poisoned entry stops being served immediately, no manual
	// cleanup needed) and when writing it (so it can't happen again).
	// Broadened after a real miss: a cached answer worded "I can only answer
	// questions about debugging..." (model's own phrasing, word order
	// different from the instructed fallback text) slipped past the
	// original 3 patterns and got served back as a "good" cache hit at
	// ~1.0 similarity. This is inherently a best-effort blocklist, not a
	// guarantee - it cannot catch every way the model might phrase a
	// refusal, which is why cache writes skip refusal-shaped answers
	// rather than relying on this list alone to keep the cache clean.
	const REFUSAL_PATTERNS = [
		"can't determine that from the selected script",
		'only able to answer questions about debugging',
		'can only answer questions about debugging',
		"i'm sorry, i can't answer that question",
		"don't have enough information to answer",
		'not enough information to answer'
	];
	const isRefusalAnswer = (text) => {
		const lower = String(text || '').toLowerCase();
		return REFUSAL_PATTERNS.some((pattern) => lower.indexOf(pattern) !== -1);
	};

	// Small deterministic string hash (FNV-1a, hex) - not cryptographic, just
	// needs to be stable and short enough for a TEXT field. Used to fingerprint
	// "what context was this answer generated under" so a cache lookup can
	// require the SAME context, not just the same script - see
	// computeContextHash below.
	const hashString = (value) => {
		let hash = 0x811c9dc5;
		const str = String(value || '');
		for (let i = 0; i < str.length; i += 1) {
			hash ^= str.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(16);
	};

	// Context-aware cache key ingredient: which knowledge documents were
	// actually active (built-ins are constant, but uploads can be added/
	// removed/toggled) plus which model family answered. Two questions about
	// the SAME script can still land in different cache buckets if the
	// Knowledge Base changed between them - an answer generated before a
	// document existed is never served as if that document had been
	// considered. Deliberately excludes useTools/useSafety/useJson: those
	// change HOW an answer is produced but a plain-language answer to "what
	// does this script do" is still valid whether or not the safety toggle
	// happened to be on, and JSON-formatted answers are never cached in the
	// first place in practice since useJson routes through a different
	// prompt shape - if that ever changes, add useJson here too.
	const computeContextHash = (useRag, kbListing, modelLabel) => {
		const activeDocIds = useRag
			? kbListing.builtin.map((d) => d.id).concat(kbListing.activeUploadedIds).sort()
			: ['rag_off'];
		return hashString(`${modelLabel}|${activeDocIds.join(',')}`);
	};

	// Collapses whitespace/case only - NOT a semantic normalization. This is
	// intentionally a strict, cheap check for the "literally the same
	// question again" case, so it never needs an llm.embed call. A
	// differently-worded question that means the same thing falls through to
	// the semantic tier below.
	const normalizeQuestionForExactMatch = (question) => String(question || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/[?.!]+$/g, '');

	const loadRecentCacheRows = (scriptId) => query.runSuiteQL({
		query: `SELECT * FROM (
			SELECT id, custrecord_dcs_question AS question, custrecord_dcs_answer AS answer,
				custrecord_dcs_context_hash AS contexthash
			FROM customrecord_debug_session
			WHERE custrecord_dcs_scriptid = ?
			ORDER BY id DESC
		) WHERE ROWNUM <= ?`,
		params: [scriptId || '', MAX_CACHE_ROWS_SCANNED]
	}).asMappedResults();

	// Tier 1: exact (normalized) string match, scoped to the same script AND
	// context hash. No llm.embed call - this is the fast path for "the exact
	// same question again", which previously paid for a full embed call like
	// every other question.
	const findExactCachedAnswer = (question, scriptId, contextHash) => {
		const normalized = normalizeQuestionForExactMatch(question);
		const rows = loadRecentCacheRows(scriptId);
		const match = rows.find((row) => (
			row.contexthash === contextHash
			&& normalizeQuestionForExactMatch(row.question) === normalized
			&& !isRefusalAnswer(row.answer)
		));
		return match ? { answer: match.answer, similarity: 1, matchType: 'exact' } : null;
	};

	// Tier 2: cosine-similarity match on the question's embedding, scoped to
	// the same script AND context hash (see computeContextHash). Renamed
	// from the original findCachedAnswer to make the two-tier design explicit
	// at call sites.
	const findSemanticCachedAnswer = (questionEmbedding, scriptId, contextHash) => {
		const rows = loadRecentCacheRows(scriptId);
		if (!rows.length) {
			return null;
		}

		const embeddingsIndex = loadEmbeddingsIndex(scriptId);
		let best = null;
		let bestScore = 0;
		let skippedRefusals = 0;
		rows.forEach((row) => {
			if (row.contexthash !== contextHash) {
				return;
			}
			if (isRefusalAnswer(row.answer)) {
				skippedRefusals += 1;
				return;
			}
			const embedding = embeddingsIndex[String(row.id)];
			if (!Array.isArray(embedding)) {
				return;
			}
			const score = cosineSimilarity(questionEmbedding, embedding);
			if (score > bestScore) {
				bestScore = score;
				best = row;
			}
		});

		if (skippedRefusals) {
			log.debug({ title: 'Debug Copilot - skipped refusal-shaped cache rows', details: JSON.stringify({ scriptId, skippedRefusals, rowsScanned: rows.length }) });
		}

		const hit = !!best && bestScore >= SIMILARITY_THRESHOLD;
		// Always logged, hit or miss - previously only a hit's similarity was
		// ever visible (in the UI badge), so a near-miss (e.g. 0.87 against a
		// 0.90 threshold) was invisible and looked identical in the logs to
		// "no candidate rows at all". This is the number to watch when tuning
		// SIMILARITY_THRESHOLD against this account's real embedding model.
		log.audit({
			title: 'Debug Copilot - semantic cache lookup',
			details: JSON.stringify({
				scriptId,
				contextHash,
				rowsScanned: rows.length,
				bestScore: Number(bestScore.toFixed(4)),
				bestRowId: best ? best.id : null,
				threshold: SIMILARITY_THRESHOLD,
				hit
			})
		});

		return hit ? { answer: best.answer, similarity: bestScore, matchType: 'semantic' } : null;
	};

	// Embeds the QUESTION, not the answer, so future matches are on intent.
	// answer is defensively capped at MAX_STORED_ANSWER_LENGTH before it hits
	// the TEXTAREA field - see the constant's comment for why.
	const saveSession = ({ question, answer, embedding, scriptId, deploymentId, contextHash }) => {
		const safeAnswer = String(answer || '');
		const storedAnswer = safeAnswer.length > MAX_STORED_ANSWER_LENGTH
			? `${safeAnswer.substring(0, MAX_STORED_ANSWER_LENGTH)}... [truncated for storage]`
			: safeAnswer;
		if (storedAnswer !== safeAnswer) {
			log.audit({ title: 'Debug Copilot - answer truncated for cache storage', details: JSON.stringify({ scriptId, originalLength: safeAnswer.length, storedLength: storedAnswer.length }) });
		}

		const rec = record.create({ type: CACHE_RECORD_TYPE, isDynamic: false });
		rec.setValue({ fieldId: 'custrecord_dcs_question', value: question || '' });
		rec.setValue({ fieldId: 'custrecord_dcs_answer', value: storedAnswer });
		rec.setValue({ fieldId: 'custrecord_dcs_scriptid', value: scriptId || '' });
		rec.setValue({ fieldId: 'custrecord_dcs_deploymentid', value: deploymentId || '' });
		rec.setValue({ fieldId: 'custrecord_dcs_created', value: new Date() });
		rec.setValue({ fieldId: 'custrecord_dcs_context_hash', value: contextHash || '' });
		const recordId = rec.save();

		const embeddingsIndex = loadEmbeddingsIndex(scriptId);
		embeddingsIndex[String(recordId)] = embedding || [];
		saveEmbeddingsIndex(scriptId, embeddingsIndex);

		return recordId;
	};

	// ---------------------------------------------------------------------
	// Generation
	// ---------------------------------------------------------------------

	// Script-aware, not "debugging-only": the earlier instruction set told the
	// model to decline anything not literally about debugging, while never
	// supplying any source code to reason about - so a question like "tell me
	// about script logic and used modules" hit the decline branch with
	// nothing to ground an answer in. The selected script's source is now the
	// primary subject; debugging, code understanding, and NetSuite/SDF
	// development questions about it are all in scope.
	// Root cause of intermittent "Response has timed out" failures on some
	// scripts/conversations but not others (2026-09-12): this history was
	// only ever capped by TURN COUNT (MAX_TURNS_KEPT*2 = 24 turns), never by
	// size. Every assistant answer can be up to MAX_STORED_ANSWER_LENGTH
	// (3900) characters, so a long-running conversation could add tens of
	// thousands of characters of history on TOP of the selected script's
	// source (up to MAX_TOTAL_SOURCE_CHARS = 60000) and any tool-results
	// block, every single turn. A bigger script needs more turns to explore
	// -> a longer conversation -> a bigger prompt -> more generation time,
	// which is exactly the "works fine on small scripts, times out on big
	// ones deep into a conversation" pattern this was reported as. Capped
	// here by an actual character budget, trimming the OLDEST turns first
	// (most recent context matters most for "what did we just discuss"),
	// independent of the existing turn-count cap.
	const MAX_TRANSCRIPT_CHARS = 6000;
	const buildConversationTranscript = (state) => {
		const recentTurns = (state.turns || []).slice(-MAX_TURNS_KEPT * 2);
		const lines = recentTurns.map((turn) => {
			if (turn.role === 'assistant' && isRefusalAnswer(turn.text)) {
				return 'Assistant: [A previous answer here incorrectly claimed the source was unavailable - ignore that; the source has always been available and is shown above.]';
			}
			return `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`;
		});

		let totalChars = 0;
		const kept = [];
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			totalChars += lines[i].length + 1;
			if (totalChars > MAX_TRANSCRIPT_CHARS && kept.length > 0) {
				kept.unshift('[Earlier turns omitted to keep this turn\'s prompt a reasonable size.]');
				break;
			}
			kept.unshift(lines[i]);
		}
		return kept.join('\n');
	};

	// Official generateText preamble = stable role/rules. User prompt holds
	// the selected source and the new question so N/llm preamble is exercised.
	const buildPreamble = (state, useJson) => [
		'You are the SuiteScript Debug Copilot. The selected script is the primary subject - treat it as "this script"/"it" when the user does not name a different script.',
		`Script ID: ${state.targetScriptId || 'unknown'}`,
		`Script Name: ${state.targetScriptName || 'unknown'}`,
		`Deployment ID: ${state.targetDeploymentId || 'unknown'}`,
		'The source in the user prompt is real File Cabinet content loaded for this script. Use it. Do not claim it is missing when it is present.',
		'Answer from that source: purpose, flow, N/* modules, functions, records/fields, searches, errors, governance, improvements.',
		'Use getExecutionLogForScript and lookupRecordFieldSchema only for LIVE account data not visible in the source. Do not call a tool for "what does this script do" or "what modules does it use".',
		'Reference documents (if supplied via documents) are secondary SDF/OWASP/records/permissions guidance - not the selected script source.',
		'Do not invent field IDs, permission keys, log entries, functions, or modules that are not in the source.',
		'If the detail is genuinely not in the source, tools, or reference documents, say exactly: "I can\'t determine that from the selected script\'s source code. I can inspect the deployment, execution logs, or NetSuite metadata if you\'d like."',
		useJson
			? 'Respond with ONLY valid JSON matching the requested schema. No markdown fences.'
			: 'Format substantial answers in Markdown with headings, lists, and inline `code` for identifiers.'
	].join('\n');

	const buildUserPrompt = (state, question, scriptContextBlock, toolResultsBlock) => {
		const transcript = buildConversationTranscript(state);
		return [
			'Selected script source (actual File Cabinet content, not a placeholder):',
			scriptContextBlock,
			toolResultsBlock || '',
			transcript ? `\nConversation so far:\n${transcript}` : '',
			`\nThe selected script's source is provided in full above - use it. New user message: ${question}`
		].filter(Boolean).join('\n');
	};

	const buildInstructionPrompt = (state, question, scriptContextBlock) => (
		`${buildPreamble(state, false)}\n\n${buildUserPrompt(state, question, scriptContextBlock)}`
	);

	// REMOVED safetyMode: 'CONTEXTUAL' (2026-08-26) - root cause of a
	// regression where every question returned the literal "I can't
	// determine that from the selected script's source code" fallback even
	// with real, proven-present source content. Diagnostic logging (see
	// handleAsk) confirmed 21,767 real source characters across all 4 files,
	// 0 empty, in a 26,945-character prompt reaching both the streamed and
	// non-streamed generateText calls - ruling out every plumbing
	// explanation (missing/empty/truncated/mis-escaped source, tool-loop
	// context loss, stale cache) with hard evidence. safetyMode was the one
	// remaining unverified ingredient: used nowhere else in this project,
	// never independently tested, and Cohere's documented SAFETY_MODE
	// parameter (which N/llm's Cohere-backed implementation mirrors) is
	// specifically designed to make the model hedge/refuse when it is not
	// confident a claim is well-grounded - exactly the observed failure
	// shape. Every other proven-working script here (llm_streaming_test.js,
	// llm_rag_test.js, llm_tool_call_test.js) omits it entirely. Scope
	// control (staying on-topic for this script/NetSuite) is still enforced
	// via the prompt instructions themselves, the same technique
	// llm_salesorder_rag_assistant.js already uses successfully without
	// safetyMode - re-verify off-topic refusal behavior (original Test
	// Checklist item 6) now that it relies solely on that, not a platform
	// safety parameter.
	const buildTextOnlyOptions = ({
		promptText,
		preamble,
		documents,
		modelFamily,
		safetyMode,
		responseFormat
	}) => {
		const options = {
			prompt: promptText,
			modelFamily: modelFamily || llm.ModelFamily.COHERE_COMMAND,
			modelParameters: { maxTokens: 1200, temperature: 0.2 }
		};
		if (preamble) {
			options.preamble = preamble;
		}
		if (documents && documents.length) {
			options.documents = documents;
		}
		if (safetyMode) {
			options.safetyMode = safetyMode;
		}
		if (responseFormat) {
			options.responseFormat = responseFormat;
		}
		return options;
	};

	// Vision content-block shape is unverified against this account's live
	// N/llm module (see file header) - this throws on any construction
	// problem so the caller can fall back, rather than silently swallowing it.
	const resolveVisionModelFamily = () => {
		const keys = ['COHERE_COMMAND_A_VISION', 'COHERE_COMMAND_VISION'];
		for (let i = 0; i < keys.length; i += 1) {
			if (llm.ModelFamily && llm.ModelFamily[keys[i]]) {
				return llm.ModelFamily[keys[i]];
			}
		}
		return null;
	};

	const saveVisionImageFile = (imageData, imageType) => {
		const lower = String(imageType || 'image/png').toLowerCase();
		const isJpeg = lower.indexOf('jpeg') !== -1 || lower.indexOf('jpg') !== -1;
		const fileName = isJpeg
			? 'debug_copilot_vision_upload.jpg'
			: 'debug_copilot_vision_upload.png';
		const types = file.Type || {};
		const fileType = isJpeg
			? (types.JPGIMAGE || 'JPGIMAGE')
			: (types.PNGIMAGE || types.PNG || 'PNGIMAGE');
		const folderId = resolveSuiteScriptsFolderId();
		try {
			const existing = file.load({ id: `SuiteScripts/${fileName}` });
			existing.contents = imageData;
			existing.save();
			return file.load({ id: existing.id });
		} catch (e) {
			const created = file.create({
				name: fileName,
				fileType,
				contents: imageData,
				folder: folderId,
				isOnline: false
			});
			const id = created.save();
			return file.load({ id });
		}
	};

	// Structural-only inspection of whatever llm.generateTextStreamed()
	// returned - lengths/booleans/keys, never prompt/response content, so
	// this is safe to log at DEBUG in production.
	const describeStreamedResponse = (response) => {
		try {
			if (!response) {
				return { present: false };
			}
			return {
				present: true,
				jsType: typeof response,
				hasIteratorMethod: typeof response.iterator === 'function',
				hasTextProperty: typeof response.text === 'string',
				textLength: typeof response.text === 'string' ? response.text.length : null,
				hasToolCalls: Array.isArray(response.toolCalls),
				toolCallCount: Array.isArray(response.toolCalls) ? response.toolCalls.length : 0,
				hasChatHistory: Array.isArray(response.chatHistory),
				model: response.model || null,
				ownKeys: (() => {
					try {
						return Object.keys(response);
					} catch (e2) {
						return null;
					}
				})()
			};
		} catch (e) {
			return { present: true, describeError: e && e.message };
		}
	};

	// Reads a llm.generateTextStreamed() response via its iterator, tagging
	// any failure with a `stage` so callers/logs can tell stream_initialization
	// (no usable iterator on the response at all) apart from stream_iteration
	// (the iterator exists but throws while being consumed) apart from
	// response_assembly (drained fine, but building the final string failed).
	// Never JSON.parses a chunk - each token is a plain { value: string }
	// object per the one proven-working streaming example in this project
	// (llm_streaming_test.js), so there is no "chunk_parsing" stage here.
	const drainStreamed = (response) => {
		log.debug({ title: 'Debug Copilot - stream response shape', details: safeStringify(describeStreamedResponse(response)) });

		if (!response || typeof response.iterator !== 'function') {
			throw Object.assign(
				new Error('Streamed response has no iterator() method - not a streamable response object.'),
				{ stage: 'stream_initialization' }
			);
		}

		const tokens = [];
		let chunkCount = 0;
		try {
			response.iterator().each((token) => {
				chunkCount += 1;
				if (token && typeof token.value === 'string') {
					tokens.push(token.value);
				} else if (chunkCount <= 3) {
					// Only the shape of the first few off-spec chunks, never their content.
					log.debug({
						title: 'Debug Copilot - unexpected stream chunk shape',
						details: safeStringify({
							chunkIndex: chunkCount,
							chunkType: typeof token,
							chunkIsNull: token === null,
							chunkKeys: token && typeof token === 'object' ? Object.keys(token) : null
						})
					});
				}
				return tokens.length < MAX_STREAM_TOKENS;
			});
		} catch (e) {
			throw Object.assign(
				new Error(`Stream iteration failed after ${chunkCount} chunk(s): ${(e && (e.message || e.name)) || 'unknown error'}`),
				{ stage: 'stream_iteration', chunkCount }
			);
		}

		try {
			const finalText = response.text || tokens.join('');
			log.debug({ title: 'Debug Copilot - stream drained', details: safeStringify({ chunkCount, finalTextLength: finalText.length }) });
			return finalText;
		} catch (e) {
			throw Object.assign(
				new Error(`Failed to assemble final response text from ${chunkCount} chunk(s): ${(e && (e.message || e.name)) || 'unknown error'}`),
				{ stage: 'response_assembly', chunkCount }
			);
		}
	};

	// generateTextStreamed()+drainStreamed() is only proven in this project
	// for a bare prompt with no `documents`/`tools` (llm_streaming_test.js).
	// The Debug Copilot always passes both, a combination no script here had
	// ever exercised - and it is exactly this combination that throws
	// UNEXPECTED_ERROR out of the iterator in practice. generateText() (no
	// streaming) IS separately proven with documents (llm_rag_test.js) and
	// with tools (llm_tool_call_test.js), so it is the safe fallback rather
	// than a guess. Streaming is still attempted first every turn - this
	// only steps down to generateText() when the stream itself is unusable,
	// it does not disable streaming outright.
	const generateOnce = (options, skipStreaming) => {
		if (!skipStreaming) {
			try {
				const response = llm.generateTextStreamed(options);
				const text = drainStreamed(response);
				return { response, text, usedStreaming: true };
			} catch (e) {
				log.error({
					title: 'Debug Copilot - streaming generation failed, falling back to non-streaming generateText',
					details: safeStringify({
						stage: (e && e.stage) || 'stream_initialization',
						errorName: e && e.name,
						errorMessage: e && e.message,
						chunkCount: e && e.chunkCount
					})
				});
			}
		}

		try {
			const response = llm.generateText(options);
			return { response, text: response.text || '', usedStreaming: false };
		} catch (e) {
			// "Response has timed out" (seen on larger prompts - see
			// buildConversationTranscript's comment on the actual size fix)
			// looks like transient model/network load, not a structural
			// problem with the request - a single immediate retry costs one
			// extra AI Unit call but has been observed to succeed where the
			// first attempt didn't. Only retried for this specific
			// timeout-shaped message, once, so a genuinely broken request
			// (bad parameters, invalid model) still fails fast instead of
			// silently doubling every error's latency.
			const isTimeout = /timed out/i.test((e && e.message) || '');
			if (isTimeout) {
				log.audit({ title: 'Debug Copilot - generateText timed out, retrying once', details: safeStringify({ errorMessage: e && e.message }) });
				try {
					const retryResponse = llm.generateText(options);
					return { response: retryResponse, text: retryResponse.text || '', usedStreaming: false };
				} catch (retryErr) {
					throw Object.assign(
						new Error(`Non-streaming fallback also failed after one retry: ${(retryErr && (retryErr.message || retryErr.name)) || 'unknown error'}`),
						{ stage: 'non_streaming_fallback' }
					);
				}
			}
			throw Object.assign(
				new Error(`Non-streaming fallback also failed: ${(e && (e.message || e.name)) || 'unknown error'}`),
				{ stage: 'non_streaming_fallback' }
			);
		}
	};

	// No tool-call loop here - see the "Tools" section comment above: `tools`
	// is never sent to generateText on this account, so response.toolCalls
	// is never populated and a loop waiting for it would never run. Live
	// data (if any) is already injected as text into baseOptions.prompt
	// before this is called (buildToolResultsBlock), so a single
	// generateOnce call is the whole turn.
	const runConversationTurn = (baseOptions, skipStreaming) => {
		const result = generateOnce(baseOptions, !!skipStreaming);
		return { response: result.response, text: result.text, usedStreaming: result.usedStreaming };
	};

	// Covers BOTH observed failure shapes for the unverified vision surface:
	// (1) llm.createChatMessage/the images param throws immediately while
	// building options, or (2) construction succeeds but llm.generateTextStreamed
	// itself rejects the request once called (invalid modelFamily, unsupported
	// content, etc). Either way this retries once as text-only and returns a
	// user-visible imageWarning instead of failing the whole turn or silently
	// dropping the screenshot.
	const runTurnWithVisionFallback = ({
		promptText,
		preamble,
		documents,
		imageData,
		imageType,
		modelFamily,
		safetyMode,
		responseFormat,
		skipStreaming,
		question
	}) => {
		const textOptions = buildTextOnlyOptions({
			promptText,
			preamble,
			documents,
			modelFamily,
			safetyMode,
			responseFormat
		});
		if (!imageData) {
			return Object.assign(
				{ imageWarning: null },
				runConversationTurn(textOptions, skipStreaming)
			);
		}

		try {
			const visionFamily = resolveVisionModelFamily();
			if (!visionFamily) {
				throw new Error(
					'llm.ModelFamily has no Command A Vision value in this account.'
				);
			}
			const imageFile = saveVisionImageFile(imageData, imageType);
			const visionPrompt = [
				'Look at the attached screenshot.',
				`The user asked: ${question || 'What does this screenshot show?'}`,
				'Describe what is on screen. If it is a NetSuite error, quote the error text exactly.',
				'Do not claim the screenshot is missing.'
			].join('\n');
			const response = llm.generateText({
				prompt: visionPrompt,
				image: imageFile,
				modelFamily: visionFamily,
				modelParameters: { maxTokens: 800, temperature: 0.2 }
			});
			return {
				response,
				text: (response && response.text) || '',
				toolTrace: [],
				usedStreaming: false,
				imageWarning: null
			};
		} catch (e) {
			log.error({
				title: 'Debug Copilot - vision attempt failed, retrying text-only',
				details: `${e.name || 'ERROR'} - ${e.message || ''}`
			});
			const textOnlyResult = runConversationTurn(textOptions, skipStreaming);
			return Object.assign({
				imageWarning: `The attached screenshot could not be processed (${e.name || 'ERROR'}${e.message ? `: ${e.message}` : ''}). Continuing with text only — the model did not see the image.`
			}, textOnlyResult);
		}
	};

	// ---------------------------------------------------------------------
	// Turn handling
	// ---------------------------------------------------------------------

	const handleAsk = (state, message, imageData, imageType, sourceContext) => {
		if (isBlank(message)) {
			state.notice = 'Please enter a question.';
			return state;
		}
		if (message.length > MAX_MESSAGE_LENGTH) {
			state.notice = `Question is too long (max ${MAX_MESSAGE_LENGTH} characters).`;
			return state;
		}
		if (runtime.getCurrentScript().getRemainingUsage() < MIN_GOVERNANCE_UNITS_REQUIRED) {
			state.notice = 'This session is low on script governance units. Please reload the page and try again.';
			return state;
		}
		if (!checkRateLimit()) {
			state.notice = `Rate limit reached (${RATE_LIMIT_PER_HOUR} questions/hour per user). Please try again later.`;
			return state;
		}

		const question = message.trim();
		const lab = mergeLab(state.lab);
		const featureNotes = [];
		log.audit({
			title: 'Debug Copilot - question received',
			details: JSON.stringify({
				scriptId: state.targetScriptId,
				question: safeLogValue(question),
				lab
			})
		});

		state.turns = state.turns || [];
		state.turns.push({ role: 'user', text: question });
		if (state.turns.length > MAX_STORED_TURNS) {
			const dropped = state.turns.length - MAX_STORED_TURNS;
			state.turns = [{
				role: 'assistant',
				text: `— ${dropped} earlier message(s) were trimmed from this view to keep the session responsive. The most recent messages are shown below. —`,
				cached: false,
				isTrimNotice: true
			}].concat(state.turns.slice(-MAX_STORED_TURNS));
		}

		const gptOssFamily = lab.modelKey === 'GPT_OSS' ? resolveGptOssFamily() : null;
		if (lab.modelKey === 'GPT_OSS' && !gptOssFamily) {
			featureNotes.push(
				'GPT-OSS is not on llm.ModelFamily in this account; using Cohere Command.'
			);
		}
		const modelFamily = gptOssFamily || llm.ModelFamily.COHERE_COMMAND;
		const modelLabel = gptOssFamily ? 'GPT_OSS' : 'COHERE_COMMAND';

		if (lab.useRag && gptOssFamily) {
			featureNotes.push('Native documents/RAG skipped: GPT-OSS does not support RAG.');
		}
		if (lab.useJson && gptOssFamily) {
			featureNotes.push('responseFormat skipped: not supported on GPT-OSS.');
		}

		const usePromptStudio = !!lab.usePromptStudio;
		const promptStudioId = usePromptStudio ? getPromptStudioId() : '';
		if (usePromptStudio && !promptStudioId) {
			featureNotes.push(
				'Prompt Studio skipped: set deployment parameter custscript_dcs_prompt_id.'
			);
		}

		const useRag = !!lab.useRag && !gptOssFamily;
		const useJson = !!lab.useJson && !gptOssFamily && !usePromptStudio;
		const useTools = !!lab.useTools && !usePromptStudio && !useJson;
		const useSafety = !!lab.useSafety && !usePromptStudio;
		const useCache = !!lab.useCache && !usePromptStudio;
		if (lab.useTools && useJson) {
			featureNotes.push(
				'Tools skipped this turn: responseFormat and tools are not combined.'
			);
		}

		const kbListing = buildKnowledgeBaseListing();
		const contextHash = computeContextHash(useRag, kbListing, modelLabel);

		// The embed call (question embedding + the informational
		// previous-question similarity) is now only made when the cache lab
		// toggle is actually on - previously this ran unconditionally every
		// turn regardless of that toggle, spending an embed call even when
		// its only consumer (the cache lookup) was disabled.
		let questionEmbedding = [];
		let embedSimilarity = null;
		let cached = null;
		if (useCache) {
			cached = findExactCachedAnswer(question, state.targetScriptId, contextHash);

			if (!cached) {
				const priorUserTurns = state.turns.filter((turn) => turn.role === 'user');
				const previousQuestion = priorUserTurns.length >= 2
					? priorUserTurns[priorUserTurns.length - 2].text
					: null;
				const embedInputs = previousQuestion ? [previousQuestion, question] : [question];
				const embedOptions = {
					embedModelFamily: llm.EmbedModelFamily.COHERE_EMBED,
					inputs: embedInputs
				};
				if (llm.Truncate && llm.Truncate.END) {
					embedOptions.truncate = llm.Truncate.END;
				}
				const embeddingResult = llm.embed(embedOptions);
				const embeddings = embeddingResult.embeddings || [];
				questionEmbedding = embeddings[previousQuestion ? 1 : 0] || [];
				embedSimilarity = previousQuestion
					? cosineSimilarity(embeddings[0], embeddings[1])
					: null;

				cached = findSemanticCachedAnswer(questionEmbedding, state.targetScriptId, contextHash);
			}
		}

		if (cached) {
			log.audit({
				title: 'Debug Copilot - response path',
				details: JSON.stringify({
					cacheHit: true,
					matchType: cached.matchType,
					similarity: cached.similarity,
					contextHash,
					finalAnswerSource: 'cache'
				})
			});
			state.turns.push({
				role: 'assistant',
				text: cached.answer,
				cached: true,
				cacheMatchType: cached.matchType,
				similarity: cached.similarity,
				sourceFileNames: sourceContext.sourceMissing
					? []
					: sourceContext.files.map((f) => f.name),
				llmMeta: {
					api: cached.matchType === 'exact' ? 'cache-exact' : 'cache-semantic',
					model: modelLabel,
					embedSimilarity,
					cacheSimilarity: cached.similarity,
					featureNotes
				}
			});
			state.notice = '';
			state.usage = llm.getRemainingUsage();
			return state;
		}

		try {
			const wantsLiveData = questionNeedsLiveTools(question);

			// EXPERIMENTAL native tool-calling attempt - see attemptNativeToolCalling's
			// comment. Tried first, before the SuiteScript keyword-prefetch path, so
			// the model itself decides whether a tool is needed. Any failure here
			// (including the account's known generateText({tools}) platform bug)
			// falls all the way back to the proven prefetch approach below - this
			// can only ever add a chance of a better path, never break the turn.
			const canAttemptNativeTools = useTools && lab.useNativeTools && !usePromptStudio && !useJson && !imageData;
			let nativeAttempt = null;
			if (canAttemptNativeTools) {
				try {
					const nativeScriptContextBlock = buildScriptContextBlock(sourceContext);
					const nativePromptText = buildUserPrompt(state, question, nativeScriptContextBlock, '');
					const nativePreamble = buildPreamble(state, false);
					nativeAttempt = attemptNativeToolCalling({
						promptText: nativePromptText,
						preamble: nativePreamble,
						modelFamily,
						state
					});
					log.audit({
						title: 'Debug Copilot - native tool-calling succeeded',
						details: safeStringify({ scriptId: state.targetScriptId, iterations: nativeAttempt.iterations, toolCallCount: nativeAttempt.toolTrace.length })
					});
					featureNotes.push(
						`Native N/llm tool-calling succeeded this turn (${nativeAttempt.toolTrace.length} call(s)) - the model decided for itself whether to call a tool, instead of a SuiteScript keyword match.`
					);
				} catch (nativeErr) {
					log.error({
						title: 'Debug Copilot - native tool-calling failed, falling back to SuiteScript keyword prefetch',
						details: safeStringify({ errorName: nativeErr && nativeErr.name, errorMessage: nativeErr && nativeErr.message })
					});
					featureNotes.push(
						`Native N/llm tool-calling attempt failed (${nativeErr && nativeErr.name ? nativeErr.name : 'ERROR'}${nativeErr && nativeErr.message ? `: ${nativeErr.message}` : ''}) - fell back to SuiteScript keyword prefetch. Expected if this account's known generateText({tools}) platform bug is still present with a long prompt.`
					);
					nativeAttempt = null;
				}
			}

			const usePrefetch = !nativeAttempt && useTools && wantsLiveData;
			const toolTracePrefetch = usePrefetch
				? prefetchLiveToolResults(question, state)
				: [];
			if (usePrefetch) {
				featureNotes.push(
					'Live data was fetched in SuiteScript and injected into the prompt. N/llm tools were not sent: generateText({ tools }) throws Unexpected Error on this account once the prompt is long or the model emits a tool call.'
				);
			}
			// No note for "this question didn't need live data" - live-data
			// lookup is always-available infrastructure now (see readLabFromParams),
			// not a toggle, so its absence on a given turn isn't a noteworthy
			// N/llm-feature decision the way an actual lab toggle's effect is.

			const documents = useRag && !nativeAttempt && !(useTools && wantsLiveData)
				? loadKnowledgeDocuments(kbListing)
				: [];
			if (useRag && !nativeAttempt && useTools && wantsLiveData) {
				featureNotes.push(
					'documents[] skipped this turn so the live-data prompt stays smaller.'
				);
			}

			const scriptContextBlock = buildScriptContextBlock(sourceContext);
			const toolResultsBlock = buildToolResultsBlock(toolTracePrefetch);
			const preamble = buildPreamble(state, useJson);
			const promptText = buildUserPrompt(
				state,
				question,
				scriptContextBlock,
				toolResultsBlock
			);
			// Stream fails on this account with preamble + source even when
			// tools/documents are off (stream_iteration, 0 chunks).
			const skipStreaming = true;
			const streamSkipReason = 'Streaming skipped: generateTextStreamed fails on this account with preamble + script source (stream_iteration, 0 chunks). generateText is used instead.';

			log.audit({
				title: 'Debug Copilot - source content diagnostic',
				details: JSON.stringify({
					scriptId: state.targetScriptId,
					sourceMissing: sourceContext.sourceMissing,
					filesWithContent: sourceContext.files.filter((f) => f.text && f.text.length > 0).length,
					totalSourceCharacters: sourceContext.files.reduce((sum, f) => sum + (f.text ? f.text.length : 0), 0),
					preambleLength: preamble.length,
					promptLength: promptText.length,
					toolsOffered: useTools,
					documentsOffered: useRag,
					documentCount: documents.length,
					useJson,
					useSafety,
					usePromptStudio: usePromptStudio && !!promptStudioId,
					modelLabel,
					contextHash,
					skipStreaming
				})
			});

			let text = '';
			let toolTrace = [];
			let imageWarning = null;
			let usedStreaming = false;
			let response = null;
			let apiUsed = 'generateText';

			if (nativeAttempt) {
				text = nativeAttempt.text;
				toolTrace = nativeAttempt.toolTrace;
				response = nativeAttempt.response;
				usedStreaming = false;
				apiUsed = 'generateText (native tools)';
			} else if (usePromptStudio && promptStudioId) {
				try {
					response = llm.evaluatePrompt({
						id: promptStudioId,
						variables: {
							scriptSource: scriptContextBlock,
							question,
							scriptId: state.targetScriptId || '',
							scriptName: state.targetScriptName || ''
						}
					});
					text = (response && response.text) || '';
					apiUsed = 'evaluatePrompt';
					usedStreaming = false;
				} catch (promptErr) {
					featureNotes.push(
						`evaluatePrompt failed (${promptErr.name || 'ERROR'}: ${promptErr.message || ''}). Falling back to generateText.`
					);
				}
			}

			if (!nativeAttempt && (apiUsed !== 'evaluatePrompt' || !text)) {
				const generated = runTurnWithVisionFallback({
					promptText,
					preamble,
					documents,
					imageData,
					imageType,
					modelFamily,
					safetyMode: useSafety ? resolveSafetyMode() : null,
					responseFormat: useJson ? STRUCTURED_RESPONSE_FORMAT : null,
					skipStreaming,
					question
				});
				text = generated.text;
				toolTrace = toolTracePrefetch.length
					? toolTracePrefetch
					: (generated.toolTrace || []);
				imageWarning = generated.imageWarning;
				usedStreaming = generated.usedStreaming;
				response = generated.response;
				apiUsed = usedStreaming ? 'generateTextStreamed' : 'generateText';
			}

			const displayText = useJson ? formatStructuredAnswer(text) : text;
			const citations = summarizeCitations(response && response.citations);
			const tokenUsage = summarizeUsage(response && response.usage);

			log.audit({
				title: 'Debug Copilot - response path',
				details: JSON.stringify({
					cacheHit: false,
					apiUsed,
					usedStreaming,
					skipStreaming,
					citationCount: citations.length,
					toolCallCount: toolTrace.length,
					finalAnswerIsRefusal: isRefusalAnswer(text),
					finalAnswerLength: (text || '').length
				})
			});

			const sourceWarning = sourceContext.sourceMissing
				? `Could not load this script's source (${sourceContext.error || 'unknown reason'}). Answered from tools/reference docs only.`
				: (sourceContext.sourceTruncated ? 'Only part of this script\'s related files (or full file contents) could be included due to size limits.' : null);

			state.turns.push({
				role: 'assistant',
				text: displayText || '(No response text was returned.)',
				cached: false,
				sourceFileNames: sourceContext.sourceMissing
					? []
					: sourceContext.files.map((f) => f.name),
				toolTrace,
				imageWarning,
				sourceWarning,
				llmMeta: {
					api: apiUsed,
					model: (response && response.model) || modelLabel,
					usedStreaming,
					streamSkipReason: apiUsed === 'evaluatePrompt'
						? 'evaluatePrompt is a single non-streamed call.'
						: streamSkipReason,
					embedSimilarity,
					citations,
					tokenUsage,
					documentCount: documents.length,
					toolsOffered: useTools
						? ['getExecutionLogForScript', 'lookupRecordFieldSchema']
						: [],
					safetyMode: useSafety ? 'CONTEXTUAL' : 'off',
					responseFormat: useJson,
					preambleUsed: true,
					featureNotes
				}
			});

			if (!useCache) {
				log.debug({
					title: 'Debug Copilot - cache write skipped',
					details: JSON.stringify({ scriptId: state.targetScriptId })
				});
			} else if (isRefusalAnswer(text)) {
				log.audit({
					title: 'Debug Copilot - refusal answer not cached',
					details: JSON.stringify({
						scriptId: state.targetScriptId,
						question: safeLogValue(question)
					})
				});
			} else {
				saveSession({
					question,
					answer: text,
					embedding: questionEmbedding,
					scriptId: state.targetScriptId,
					deploymentId: state.targetDeploymentId,
					contextHash
				});
			}

			state.notice = '';
			state.usage = llm.getRemainingUsage();
		} catch (e) {
			// Full technical detail (stage/name/message/stack) goes to the
			// execution log only - the chat transcript gets a clean, generic
			// message. Raw SuiteScript error names/stack traces in the UI
			// (UNEXPECTED_ERROR, INVALID_TOOL_PARAMETER_TYPE, stream_iteration,
			// ...) are exactly the kind of leak a polished chatbot shouldn't have.
			log.error({ title: 'Debug Copilot - generation failed', details: safeStringify({ stage: e && e.stage ? e.stage : 'unknown', errorName: e && e.name, errorMessage: e && e.message, chunkCount: e && e.chunkCount, stack: e && e.stack }) });
			const stage = (e && e.stage) || 'unknown';
			state.turns.push({
				role: 'assistant',
				text: `I couldn't generate an answer this time (${stage}). If this was a tools or screenshot question, retry once - live data is now fetched in SuiteScript instead of N/llm tool-calling.`,
				cached: false,
				isError: true,
				llmMeta: {
					api: 'failed',
					model: modelLabel,
					featureNotes: featureNotes.concat([
						`generateText failed: ${e && e.message ? e.message : 'Unexpected Error'}`
					])
				}
			});
			state.notice = '';
		}

		return state;
	};

	// ---------------------------------------------------------------------
	// Script/deployment selector (self-service entry point - see file header)
	//
	// Previously this rendered a completely separate, unstyled HTML page
	// (buildPickerPage) that the user had to leave the chat to reach, with a
	// plain <a href> "Debug this script" link back into the chat form for
	// each row. It is now a searchable field (native <input>+<datalist>, no
	// external JS library) inside the SAME chat form's header - see
	// buildScriptSelectorHtml - so selecting a script re-renders this page in
	// place (action=switchscript) instead of navigating to a different page.
	// buildScriptOptions still does the same SuiteQL lookup; only the
	// rendering changed.
	// ---------------------------------------------------------------------

	const MAX_PICKER_ROWS = 200;

	const buildScriptOptions = () => query.runSuiteQL({
		query: `SELECT * FROM (
			SELECT s.scriptid AS scriptid, s.name AS scriptname, sd.scriptid AS deploymentid, sd.title AS deploymenttitle
			FROM scriptdeployment sd
			INNER JOIN script s ON s.id = sd.script
			WHERE sd.isdeployed = 'T' AND s.isinactive = 'F'
			ORDER BY s.name, sd.title
		) WHERE ROWNUM <= ?`,
		params: [MAX_PICKER_ROWS]
	}).asMappedResults();

	// value format "scriptid::deploymentid::Script Name" - "::" cannot
	// appear in an SDF script/deployment id, so splitting is unambiguous
	// (unlike the earlier em-dash-separated <input>+<datalist> attempt,
	// which depended on fragile exact-text matching and did not reliably
	// fire onchange). A plain native <select> is used instead of a
	// searchable text input: with the row counts this Suitelet expects
	// (MAX_PICKER_ROWS = 200), a standard dropdown is simpler and more
	// reliable than a custom-filtered one, and it is a control every
	// NetSuite user already knows how to use.
	const scriptOptionValue = (row) => `${row.scriptid}::${row.deploymentid}::${row.scriptname}`;

	const buildScriptSelectorHtml = (state, scriptRows) => {
		const options = scriptRows.map((row) => {
			const isSelected = row.scriptid === state.targetScriptId && row.deploymentid === state.targetDeploymentId;
			return `<option value="${escapeHtml(scriptOptionValue(row))}"${isSelected ? ' selected="selected"' : ''}>${escapeHtml(row.scriptname)} — ${escapeHtml(row.scriptid)}</option>`;
		}).join('');
		const placeholder = state.targetScriptId ? '' : '<option value="" selected="selected" disabled="disabled">Select a script...</option>';
		return `<div class="dcs-script-selector">
			<label for="dcs_script_search" class="dcs-selector-label">Script</label>
			<select id="dcs_script_search" name="${SELECTED_SCRIPT_FIELD_ID}" class="dcs-selector-input" onchange="switchScript()">
				${placeholder}${options}
			</select>
			${scriptRows.length ? '' : '<span class="dcs-muted dcs-selector-empty">No active deployments were found, or this role lacks permission to view them.</span>'}
		</div>`;
	};

	// ---------------------------------------------------------------------
	// Page rendering
	// ---------------------------------------------------------------------

	const parseState = (raw) => safeParseJson(raw, null) || {};

	// Static, script-agnostic - these are UI copy suggestions, not derived
	// content, so they stay valid for any script type (UE/CS/SL/MR/SS/RL/MU/
	// WA/custom module) without ever being hardcoded to one script's answer.
	const SUGGESTED_QUESTIONS = [
		'What does this script do?',
		'Explain the execution flow.',
		'What modules does it use?',
		'What records does it interact with?',
		'Where could it fail?',
		'Are there governance concerns?',
		'How could this script be improved?'
	];

	// Welcome screen (shown when a script is selected but the conversation is
	// still empty) - this is now the ONLY place suggested questions appear
	// (previously also duplicated as a permanent left-sidebar list). Chips are
	// plain onclick -> askSuggested(text), the exact same entry point Send/Enter
	// use (see submitQuestion in the client script), so a chip click behaves
	// identically to typing the question by hand.
	const buildEmptyStateHtml = (state) => {
		const scriptName = escapeHtml(state.targetScriptName || 'this script');
		const chips = SUGGESTED_QUESTIONS.map((q) => (
			`<button type="button" class="dcs-chip" onclick="askSuggested(${JSON.stringify(q)})">${escapeHtml(q)}</button>`
		)).join('');
		return `<div class="dcs-welcome">
			<p class="dcs-welcome-kicker">SuiteScript Debug Copilot</p>
			<h1 class="dcs-welcome-title">Analyze, debug, and understand your NetSuite SuiteScript.</h1>
			<p class="dcs-welcome-script">Current script: <strong>${scriptName}</strong></p>
			<div class="dcs-chip-row">${chips}</div>
		</div>`;
	};

	const buildNoScriptSelectedHtml = () => `<div class="dcs-welcome">
		<p class="dcs-welcome-kicker">SuiteScript Debug Copilot</p>
		<h1 class="dcs-welcome-title">Select a script above to start a debugging conversation scoped to it.</h1>
	</div>`;

	// Sources shown per-turn come from sourceContext.files (the files actually
	// loaded into that turn's prompt), never from response.citations - those
	// only ever reference the 4 static knowledge docs, since script source is
	// inlined into the prompt rather than passed as a `documents` RAG entry.
	// That mismatch is what produced "Source: unknown" before this fix; this
	// only ever lists real, loaded file names, never a guessed/invented one.
	const buildSourcesHtml = (turn) => {
		if (!turn.sourceFileNames || !turn.sourceFileNames.length) {
			return '';
		}
		const label = turn.sourceFileNames.length === 1 ? 'Source' : 'Sources';
		const chips = turn.sourceFileNames.map((name) => `<span class="dcs-source-chip">${escapeHtml(name)}</span>`).join('');
		return `<div class="dcs-sources"><span class="dcs-sources-label">${label}:</span> ${chips}</div>`;
	};

	const buildLlmMetaHtml = (turn) => {
		const meta = turn.llmMeta;
		if (!meta) {
			return '';
		}
		const rows = [];
		rows.push(`API: <code>${escapeHtml(meta.api || 'n/a')}</code>`);
		rows.push(`Model: <code>${escapeHtml(meta.model || 'n/a')}</code>`);
		if (meta.usedStreaming) {
			rows.push('Streaming: used');
		} else if (meta.streamSkipReason) {
			rows.push(escapeHtml(meta.streamSkipReason));
		} else {
			rows.push('Streaming: not used');
		}
		if (meta.tokenUsage) {
			rows.push(
				`Tokens: prompt ${escapeHtml(String(meta.tokenUsage.promptTokens == null ? 'n/a' : meta.tokenUsage.promptTokens))}, completion ${escapeHtml(String(meta.tokenUsage.completionTokens == null ? 'n/a' : meta.tokenUsage.completionTokens))}, total ${escapeHtml(String(meta.tokenUsage.totalTokens == null ? 'n/a' : meta.tokenUsage.totalTokens))}`
			);
		}
		if (meta.embedSimilarity != null) {
			rows.push(`Embed similarity vs prior question: <code>${meta.embedSimilarity.toFixed(3)}</code>`);
		}
		if (meta.cacheSimilarity != null) {
			rows.push(`Cache cosine: <code>${Number(meta.cacheSimilarity).toFixed(3)}</code>`);
		}
		rows.push(`safetyMode: <code>${escapeHtml(meta.safetyMode || 'off')}</code>`);
		rows.push(`responseFormat: <code>${meta.responseFormat ? 'on' : 'off'}</code>`);
		rows.push(`preamble: <code>${meta.preambleUsed ? 'on' : 'off'}</code>`);
		if (meta.documentCount != null) {
			rows.push(`documents[]: <code>${escapeHtml(String(meta.documentCount))}</code>`);
		}
		if (meta.toolsOffered && meta.toolsOffered.length) {
			rows.push(`Tools offered: <code>${escapeHtml(meta.toolsOffered.join(', '))}</code>`);
		}
		const citationHtml = (meta.citations || []).map((citation) => {
			const ids = (citation.documentIds || []).join(', ') || 'unknown';
			const excerpt = citation.text ? ` — ${escapeHtml(citation.text.substring(0, 160))}` : '';
			return `<li><code>${escapeHtml(ids)}</code>${excerpt}</li>`;
		}).join('');
		const notesHtml = (meta.featureNotes || []).map((note) => (
			`<li>${escapeHtml(note)}</li>`
		)).join('');
		return `<details class="dcs-llm-meta">
			<summary>N/llm this turn</summary>
			<ul class="dcs-llm-meta-list"><li>${rows.join('</li><li>')}</li></ul>
			${citationHtml ? `<p class="dcs-sources-label">Native citations</p><ul>${citationHtml}</ul>` : '<p class="dcs-muted">No response.citations (expected when documents[] is empty or the model did not cite).</p>'}
			${notesHtml ? `<p class="dcs-sources-label">Lab notes</p><ul>${notesHtml}</ul>` : ''}
		</details>`;
	};

	// Advanced/experimental controls, previously a permanent right-panel card
	// competing with the chat for attention - now the body of a slide-in drawer
	// (see .dcs-drawer/openDrawer in the client script), opened from the header's
	// "AI Lab" button. The drawer only changes WHERE this markup is visually
	// shown (display, via a CSS transform + aria-hidden) - it stays in the DOM
	// and inside the same <form> at all times, so these checkboxes/select still
	// post normally with every action regardless of whether the drawer happens
	// to be open when the user clicks Send. Grouped into AI Features / Advanced
	// / Model per the requested information architecture, instead of one flat
	// wrapped grid of checkboxes.
	//
	// data-gptoss-disable marks the two checkboxes GPT-OSS cannot use (RAG,
	// JSON) so the client script (onModelChange) can visibly disable them the
	// moment GPT-OSS is picked, instead of only rejecting the invalid
	// combination after a round trip to the server (handleAsk already silently
	// drops them for GPT-OSS via featureNotes - this adds the same restriction
	// as an immediate, visible UI state). disableFlags: 'gptoss' and/or
	// 'promptstudio' (forced off whenever evaluatePrompt is on) - a checkbox
	// that LOOKS checked while its effect is silently overridden off
	// server-side is exactly the confusing state this fixes.
	const buildLabPanelHtml = (lab, promptStudioId, usage) => {
		const box = (id, checked, label, title, disableFlags, onchange) => {
			const flags = disableFlags || [];
			const dataAttrs = flags.map((flag) => ` data-${flag}-disable="1"`).join('');
			return `<label class="dcs-lab-item" title="${escapeHtml(title)}"><input type="checkbox" name="${id}" value="T"${checked ? ' checked="checked"' : ''}${dataAttrs}${onchange ? ` onchange="${onchange}"` : ''} /> ${escapeHtml(label)}</label>`;
		};
		const current = mergeLab(lab);
		return `<aside id="dcs_lab_drawer" class="dcs-drawer" aria-hidden="true" aria-label="AI Lab settings">
			<div class="dcs-drawer-header">
				<h2>AI Lab</h2>
				<button type="button" class="dcs-drawer-close" onclick="closeDrawer()" aria-label="Close AI Lab">&times;</button>
			</div>
			<div class="dcs-drawer-body">
				<input type="hidden" name="${LAB_POSTED_FIELD_ID}" value="T" />
				<section class="dcs-lab-group">
					<h3>AI Features</h3>
					${box('custpage_lab_rag', current.useRag, 'Knowledge Base / RAG', 'Pass knowledge/ files as llm.createDocument and show response.citations. Not supported on GPT-OSS or with evaluatePrompt on.', ['gptoss', 'promptstudio'])}
					${box('custpage_lab_cache', current.useCache, 'Semantic cache', 'Exact + semantic (llm.embed cosine) lookup of prior answers, scoped to this script and the current Knowledge Base/model. Not used with evaluatePrompt on.', ['promptstudio'])}
				</section>
				<section class="dcs-lab-group">
					<h3>Advanced</h3>
					${box('custpage_lab_safety', current.useSafety, 'Contextual safety', 'safetyMode CONTEXTUAL - can over-refuse even when source is present. Off by default. Not used with evaluatePrompt on.', ['promptstudio'])}
					${box('custpage_lab_json', current.useJson, 'JSON response', 'responseFormat JSON. Cohere only. Skips tools this turn. Not supported on GPT-OSS or with evaluatePrompt on.', ['gptoss', 'promptstudio'])}
					${box('custpage_lab_nativetools', current.useNativeTools, 'Native tool-calling (experimental)', 'The model decides itself whether to call getExecutionLogForScript/lookupRecordFieldSchema, via generateText({tools}), instead of a SuiteScript keyword match. This previously threw UNEXPECTED_ERROR on this account with a long prompt - any failure falls back automatically to the keyword-prefetch approach. Off by default; turn on to re-verify. Not used with evaluatePrompt, JSON response, or a screenshot attached.', ['promptstudio'])}
					${box('custpage_lab_promptstudio', current.usePromptStudio, 'evaluatePrompt', promptStudioId ? `Uses Prompt Studio id ${promptStudioId}. Bypasses RAG/tools/cache/safety above entirely.` : 'Set custscript_dcs_prompt_id on the deployment first. Bypasses RAG/tools/cache/safety above entirely.', [], 'onPromptStudioChange()')}
				</section>
				<section class="dcs-lab-group">
					<h3>Model</h3>
					<label class="dcs-lab-item dcs-lab-select">
						<select name="custpage_lab_model" id="dcs_model_select" onchange="onModelChange()">
							<option value="COHERE"${current.modelKey !== 'GPT_OSS' ? ' selected="selected"' : ''}>Cohere Command</option>
							<option value="GPT_OSS"${current.modelKey === 'GPT_OSS' ? ' selected="selected"' : ''}>GPT-OSS (no RAG / no JSON schema)</option>
						</select>
					</label>
				</section>
				<p class="dcs-muted dcs-lab-footnote" id="dcs_promptstudio_note"${current.usePromptStudio ? '' : ' hidden'}>evaluatePrompt is on: RAG, tools, embed cache, and safetyMode are all bypassed for this turn, regardless of their checkboxes above.</p>
				<p class="dcs-muted dcs-lab-footnote">Streaming is currently always skipped in favor of generateText - see streamSkipReason in a turn's "N/llm this turn" details.</p>
				<p class="dcs-muted dcs-lab-footnote">AI Units remaining: <code>${escapeHtml(JSON.stringify(usage))}</code></p>
			</div>
		</aside>`;
	};

	// Knowledge Base, previously a permanent right-panel card - now the body of
	// a slide-in drawer opened from the header's "Knowledge Base" button (see
	// buildLabPanelHtml's comment: same "stays in the DOM, only visibility
	// changes" reasoning applies here). Built-ins (always active, no remove
	// control - they ship with the Suitelet) are listed separately from user
	// uploads (each with a Remove button posting action=removedoc). The file is
	// read as TEXT in the browser (readAsText, not base64 - see
	// readAndAttachKbFile in the client script) and submitted through hidden
	// fields, the same in-page pattern the screenshot attach button already
	// uses, rather than a native serverWidget FILE field - NetSuite renders
	// native fields in its own layout slot regardless of where in the page they
	// were added, which is what put the upload control in a disconnected spot
	// the first time this was tried.
	const buildKbPanelHtml = (kbListing) => {
		const builtinRows = kbListing.builtin.map((doc) => (
			`<li class="dcs-kb-row"><span class="dcs-kb-name">${escapeHtml(doc.name)}</span><span class="dcs-kb-tag">built-in</span></li>`
		)).join('');
		const uploadedRows = kbListing.uploaded.map((doc) => (
			`<li class="dcs-kb-row">
				<span class="dcs-kb-name">${escapeHtml(doc.name)}</span>
				${doc.active ? '' : '<span class="dcs-kb-tag dcs-kb-tag-inactive">inactive</span>'}
				<button type="button" class="dcs-kb-remove" title="Remove from Knowledge Base" onclick="removeKbDocument('${escapeHtml(doc.id)}')">&times;</button>
			</li>`
		)).join('');
		const count = kbListing.uploaded.length;
		return `<aside id="dcs_kb_drawer" class="dcs-drawer" aria-hidden="true" aria-label="Knowledge Base">
			<div class="dcs-drawer-header">
				<h2>Knowledge Base <span class="dcs-drawer-count">${KNOWLEDGE_FILES.length + count}</span></h2>
				<button type="button" class="dcs-drawer-close" onclick="closeDrawer()" aria-label="Close Knowledge Base">&times;</button>
			</div>
			<div class="dcs-drawer-body">
				<p class="dcs-kb-group-label">Built-in documents</p>
				<ul class="dcs-kb-list">${builtinRows}</ul>
				<p class="dcs-kb-group-label">Uploaded documents</p>
				<ul class="dcs-kb-list">${uploadedRows || '<li class="dcs-muted dcs-kb-empty">No uploaded documents yet.</li>'}</ul>
				<div class="dcs-kb-upload-row">
					<label for="dcs_kb_file_input" class="dcs-kb-add-btn">+ Add document</label>
					<input type="file" id="dcs_kb_file_input" class="dcs-attach-input" accept=".txt,.md,text/plain,text/markdown" onchange="onKbFileChosen()" />
					<span class="dcs-muted dcs-kb-filename" id="dcs_kb_filename"></span>
				</div>
				<p class="dcs-muted dcs-kb-hint">Supported formats: TXT, MD. Max ${Math.round(MAX_KB_DOCUMENT_BYTES / 1000)}KB, ${MAX_KB_DOCUMENTS} documents.</p>
			</div>
		</aside>`;
	};

	// Prominent, always-visible activity summary shown just above the answer
	// text - previously the only signal of what happened this turn (which
	// tools ran, whether RAG contributed) was either a single tiny muted
	// "Checked live: ..." line or buried inside the collapsed "N/llm this
	// turn" <details>. This surfaces the same underlying data (turn.toolTrace,
	// turn.llmMeta) as small chips so a user can tell at a glance what the
	// Copilot actually did, without reading the technical details panel -
	// which stays available (buildLlmMetaHtml) for anyone who wants the raw
	// JSON/token counts/citation excerpts.
	const buildActivityStripHtml = (turn) => {
		if (turn.role === 'user' || !turn.llmMeta) {
			return '';
		}
		const meta = turn.llmMeta;
		const chips = [];
		if (meta.documentCount) {
			chips.push(`<span class="dcs-activity-chip dcs-activity-rag" title="Knowledge Base documents passed to the model as retrieval context this turn.">&#128218; Knowledge Base &middot; ${meta.documentCount} doc${meta.documentCount === 1 ? '' : 's'}</span>`);
		}
		const toolNames = (turn.toolTrace || []).map((t) => t.name);
		const uniqueToolNames = toolNames.filter((name, i) => toolNames.indexOf(name) === i);
		if (uniqueToolNames.length) {
			const isNative = meta.api === 'generateText (native tools)';
			const label = isNative ? 'Tool call (model-decided)' : 'Live data lookup';
			chips.push(`<span class="dcs-activity-chip dcs-activity-tool" title="${escapeHtml(label)}: ${escapeHtml(uniqueToolNames.join(', '))}">${isNative ? '&#129504;' : '&#128295;'} ${escapeHtml(uniqueToolNames.join(', '))}</span>`);
		}
		if (meta.citations && meta.citations.length) {
			chips.push(`<span class="dcs-activity-chip dcs-activity-cite" title="Native N/llm citations linking the answer back to specific Knowledge Base documents.">&#128204; ${meta.citations.length} citation${meta.citations.length === 1 ? '' : 's'}</span>`);
		}
		return chips.length ? `<div class="dcs-activity-strip">${chips.join('')}</div>` : '';
	};

	const buildTranscriptHtml = (state) => {
		if (!state.turns || !state.turns.length) {
			return buildEmptyStateHtml(state);
		}
		const turns = state.turns;
		// Anchors the most recent USER turn (when the last turn is the
		// assistant's reply to it) so pageInit's restoreScrollPosition() can
		// scroll the new exchange to the TOP of the viewport on the reload that
		// follows Send - matching "assistant response starts at the top of the
		// new response" instead of always jumping to the absolute bottom past
		// the start of a long answer. See the client script's SCROLL_PENDING_KEY.
		let anchorIndex = -1;
		if (turns.length >= 2 && turns[turns.length - 1].role === 'assistant' && turns[turns.length - 2].role === 'user') {
			anchorIndex = turns.length - 2;
		}
		return turns.map((turn, index) => {
			const isUser = turn.role === 'user';
			const roleClass = isUser ? 'dcs-user' : 'dcs-assistant';
			// Distinguishes the two real cache tiers from a fresh generation -
			// see findExactCachedAnswer/findSemanticCachedAnswer. Only ever
			// shown when a tier actually matched; there is no badge for
			// "fresh" answers (that is simply the absence of a badge), same
			// as before this change.
			const badge = turn.cacheMatchType === 'exact'
				? '<span class="dcs-badge" title="Same question, same script, same active Knowledge Base/model - no embed call needed.">Exact Cache Hit</span>'
				: (turn.cacheMatchType === 'semantic'
					? `<span class="dcs-badge" title="Different wording, same intent (cosine similarity ${turn.similarity != null ? Number(turn.similarity).toFixed(2) : 'n/a'} ≥ ${SIMILARITY_THRESHOLD}), same script/Knowledge Base/model.">Semantic Cache Hit</span>`
					: '');
			const errorClass = turn.isError ? ' dcs-error' : '';
			const activityStrip = isUser ? '' : buildActivityStripHtml(turn);
			const imageWarning = turn.imageWarning
				? `<div class="dcs-warning-banner">&#9888; ${escapeHtml(turn.imageWarning)}</div>`
				: '';
			const sourceWarning = turn.sourceWarning
				? `<div class="dcs-warning-banner">&#9888; ${escapeHtml(turn.sourceWarning)}</div>`
				: '';
			const sources = isUser ? '' : buildSourcesHtml(turn);
			const llmMeta = isUser ? '' : buildLlmMetaHtml(turn);
			const anchorAttr = index === anchorIndex ? ' id="dcs_scroll_anchor"' : '';
			return `<div class="dcs-row ${roleClass}${errorClass}"${anchorAttr}>
				<div class="dcs-turn-header">${isUser ? 'You' : '&#10022; Copilot'} ${badge}</div>
				<div class="dcs-turn">
					${sourceWarning}
					${imageWarning}
					${activityStrip}
					<div class="dcs-turn-body">${renderMarkdownToHtml(turn.text)}</div>
					${sources}
					${llmMeta}
				</div>
			</div>`;
		}).join('');
	};

	// Compact, collapsed-by-default script-identity strip - replaces the old
	// permanent left sidebar card. Reuses the native <details>/<summary>
	// pattern already used for the Knowledge Base/lab panels elsewhere in this
	// file, so expanding it needs no client-script JS at all.
	const buildContextBarHtml = (state) => {
		if (isBlank(state.targetScriptId)) {
			return '';
		}
		const sourceInfo = state.sourceInfo || {};
		const fileNames = sourceInfo.fileNames || [];
		const statusHtml = sourceInfo.sourceMissing
			? '<span class="dcs-badge-warn">source not available</span>'
			: (sourceInfo.sourceTruncated
				? '<span class="dcs-badge-warn">partial source</span>'
				: `<span class="dcs-muted">${fileNames.length} source file${fileNames.length === 1 ? '' : 's'}</span>`);
		const fileList = fileNames.length
			? `<ul class="dcs-context-files">${fileNames.map((n) => `<li><code>${escapeHtml(n)}</code></li>`).join('')}</ul>`
			: '';
		return `<details class="dcs-context-bar">
			<summary>
				<span class="dcs-context-name"><strong>${escapeHtml(state.targetScriptName || 'Unknown Script')}</strong> <span class="dcs-muted">${escapeHtml(state.targetScriptId || 'n/a')} &middot; ${escapeHtml(state.targetDeploymentId || 'n/a')}</span></span>
				${statusHtml}
			</summary>
			${fileList}
		</details>`;
	};

	const buildForm = (state) => {
		const form = serverWidget.createForm({ title: 'SuiteScript Debug Copilot' });
		form.clientScriptModulePath = CLIENT_SCRIPT_PATH;

		const scriptRows = buildScriptOptions();
		const kbListing = state.kbListing || buildKnowledgeBaseListing();

		// Everything visual (styles, top bar, sidebar, transcript, composer,
		// right panel) is ONE INLINEHTML field's defaultValue, fully
		// self-contained (every div it opens, it also closes). Earlier drafts
		// of this layout tried to open the grid/sidebar/main containers in
		// one field and close them in a later one, relying on NetSuite
		// concatenating field HTML into one seamless DOM - but each
		// serverWidget field most likely renders inside its own row/cell
		// container, which would auto-close any unclosed <div> at that
		// field's boundary and silently break the grid. Keeping the whole
		// shell in a single field sidesteps that risk entirely. Only the
		// hidden state fields, the native KB upload FILE field, and the
		// footer are separate fields.
		const appField = form.addField({ id: 'custpage_app', label: 'App', type: serverWidget.FieldType.INLINEHTML });
		const hasScript = !isBlank(state.targetScriptId);
		// Was always rendered with the same red "error" styling regardless of
		// whether the message was a genuine problem (rate limit, validation
		// failure) or just a confirmation (KB document uploaded/removed) -
		// a successful upload looked identical to a hard failure. Now uses a
		// neutral amber tone by default (validation/rate-limit messages
		// aren't emergencies) and a distinct success tone only for the two
		// confirmation messages (see handleUploadKbDocument/
		// handleRemoveKbDocument's noticeType='success'). True generation
		// failures still render red, but via the turn-level .dcs-error class
		// in buildTranscriptHtml, not this shared notice banner.
		const noticeHtml = state.notice
			? `<div class="dcs-notice dcs-notice-${state.noticeType === 'success' ? 'success' : 'warn'}">${escapeHtml(state.notice)}</div>`
			: '';
		appField.defaultValue = `<style>
			/* ---------------------------------------------------------------
			   Theme tokens. Defined on .dcs-shell (not :root) so this never
			   leaks into NetSuite's own page chrome outside the shell.
			   client script's initTheme()/toggleTheme() set
			   .dcs-shell[data-theme] on load (localStorage, falling back to
			   the OS's prefers-color-scheme) - the [data-theme="dark"] block
			   below overrides every token, so component rules only ever
			   reference var(--dcs-*), never a literal color. This is the ONE
			   source of color for the whole app - no component below this
			   point should ever hardcode a hex value.
			--------------------------------------------------------------- */
			.dcs-shell {
				--dcs-bg: #fafafa; --dcs-bg-elevated: #ffffff; --dcs-bg-subtle: #f4f5f7;
				--dcs-border: #e5e7eb; --dcs-border-soft: #eef0f3;
				--dcs-text: #1f2937; --dcs-text-strong: #111827; --dcs-text-muted: #6b7280; --dcs-text-faint: #9ca3af;
				--dcs-accent: #4f46e5; --dcs-accent-strong: #4338ca; --dcs-accent-soft: #eef2ff; --dcs-accent-soft-border: #c7d2fe;
				--dcs-user-bg: #4f46e5; --dcs-user-text: #ffffff;
				--dcs-success-bg: #d1fae5; --dcs-success-text: #065f46;
				--dcs-warn-bg: #fef3c7; --dcs-warn-text: #92400e; --dcs-warn-border: #fcd34d; --dcs-warn-banner-bg: #fffbeb;
				--dcs-error-bg: #fef2f2; --dcs-error-border: #fca5a5; --dcs-error-text: #b91c1c;
				--dcs-code-bg: #111827; --dcs-code-text: #e5e7eb;
				--dcs-shadow: 0 1px 2px rgba(15,23,42,0.04); --dcs-shadow-lg: 0 12px 32px rgba(15,23,42,0.16);
				--dcs-font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif;
				--dcs-font-mono: Consolas, Monaco, 'SFMono-Regular', monospace;
			}
			.dcs-shell[data-theme="dark"] {
				--dcs-bg: #0f1117; --dcs-bg-elevated: #171a23; --dcs-bg-subtle: #1b1e28;
				--dcs-border: #2a2e3a; --dcs-border-soft: #22252f;
				--dcs-text: #e5e7eb; --dcs-text-strong: #f9fafb; --dcs-text-muted: #9299ab; --dcs-text-faint: #6b7280;
				--dcs-accent: #818cf8; --dcs-accent-strong: #a5b4fc; --dcs-accent-soft: #1e2140; --dcs-accent-soft-border: #363b6b;
				--dcs-user-bg: #4f46e5; --dcs-user-text: #ffffff;
				--dcs-success-bg: #0f3d2e; --dcs-success-text: #6ee7b7;
				--dcs-warn-bg: #3a2f0f; --dcs-warn-text: #fcd34d; --dcs-warn-border: #78350f; --dcs-warn-banner-bg: #2a2107;
				--dcs-error-bg: #3a1414; --dcs-error-border: #7f1d1d; --dcs-error-text: #fca5a5;
				--dcs-code-bg: #05070c; --dcs-code-text: #e5e7eb;
				--dcs-shadow: 0 1px 2px rgba(0,0,0,0.3); --dcs-shadow-lg: 0 16px 40px rgba(0,0,0,0.5);
			}
			.dcs-shell, .dcs-shell * { box-sizing: border-box; }
			/* NetSuite's own classic-UI page chrome wraps every Suitelet form
			   in a centered container with its own max-width (independent of
			   anything this field's CSS can otherwise reach, since it lives
			   outside .dcs-shell in the DOM) - a <style> tag still applies
			   document-wide regardless of where it's physically written, so
			   these overrides are what actually let .dcs-shell reach full
			   viewport width instead of being capped by that outer wrapper. */
			body, html, #div__body, #bodytag, .uir-page-title-secondline,
			table.uir-outside-box, table.uir-outside-box > tbody > tr > td,
			.uir-record-body, #maincontainer, #ubertitle_div {
				max-width: none !important;
				width: 100% !important;
			}
			/* Fills the full width NetSuite gives this field - no card
			   rounding/clipping around the whole app. Previously this looked
			   like a rounded panel floating inside the page's own margins
			   instead of the primary surface of the page. */
			.dcs-shell { font-family: var(--dcs-font); color: var(--dcs-text); background: var(--dcs-bg); width: 100%; }
			@media (prefers-reduced-motion: reduce) {
				.dcs-shell * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
			}
			@keyframes dcs-turn-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
			@keyframes dcs-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

			/* ----- Header ----- */
			.dcs-header { display: flex; align-items: center; gap: 14px; padding: 13px 18px; background: var(--dcs-bg-elevated); border-bottom: 1px solid var(--dcs-border); flex-wrap: wrap; }
			.dcs-header-brand { display: flex; align-items: center; gap: 7px; font-weight: 700; font-size: 15px; color: var(--dcs-text-strong); white-space: nowrap; }
			.dcs-header-brand .dcs-spark { color: var(--dcs-accent); font-size: 16px; }
			.dcs-header-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
			.dcs-header-btn { display: inline-flex; align-items: center; gap: 6px; background: var(--dcs-bg-subtle); border: 1px solid var(--dcs-border); color: var(--dcs-text); font-size: 12.5px; font-weight: 600; padding: 7px 12px; border-radius: 20px; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease; white-space: nowrap; }
			.dcs-header-btn:hover { background: var(--dcs-accent-soft); border-color: var(--dcs-accent-soft-border); color: var(--dcs-accent-strong); }
			.dcs-header-btn:focus-visible, .dcs-theme-toggle:focus-visible, .dcs-chip:focus-visible, .dcs-send-btn:focus-visible, .dcs-clear-link:focus-visible, .dcs-drawer-close:focus-visible, .dcs-kb-add-btn:focus-visible { outline: 2px solid var(--dcs-accent); outline-offset: 2px; }
			.dcs-header-btn-count { color: var(--dcs-text-faint); font-weight: 500; }
			.dcs-theme-toggle { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--dcs-border); background: var(--dcs-bg-subtle); color: var(--dcs-text-muted); cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: background 0.15s ease, color 0.15s ease; }
			.dcs-theme-toggle:hover { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); }
			.dcs-script-selector { display: flex; align-items: center; gap: 8px; flex: 1 1 280px; max-width: 420px; min-width: 0; }
			.dcs-selector-label { font-size: 11.5px; color: var(--dcs-text-faint); font-weight: 600; white-space: nowrap; }
			.dcs-selector-input { flex: 1 1 auto; min-width: 0; font-size: 13px; padding: 7px 10px; border: 1px solid var(--dcs-border); border-radius: 8px; background: var(--dcs-bg); color: var(--dcs-text); }
			.dcs-selector-empty { font-size: 11.5px; color: var(--dcs-text-muted); }

			/* ----- Compact script-context bar ----- */
			.dcs-context-bar { background: var(--dcs-bg-subtle); border-bottom: 1px solid var(--dcs-border); font-size: 12.5px; color: var(--dcs-text-muted); }
			.dcs-context-bar summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 18px; cursor: pointer; list-style: none; }
			.dcs-context-bar summary::-webkit-details-marker { display: none; }
			.dcs-context-bar summary::before { content: '\\203A'; display: inline-block; margin-right: 8px; color: var(--dcs-text-faint); transition: transform 0.15s ease; }
			.dcs-context-bar[open] summary::before { transform: rotate(90deg); }
			.dcs-context-name { display: flex; align-items: center; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dcs-text); }
			.dcs-context-files { margin: 0; padding: 0 18px 12px 34px; list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
			.dcs-context-files code { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); padding: 2px 6px; border-radius: 6px; font-family: var(--dcs-font-mono); font-size: 10.5px; }
			.dcs-badge-warn { background: var(--dcs-warn-bg); color: var(--dcs-warn-text); font-size: 11px; padding: 2px 8px; border-radius: 10px; }

			/* ----- Main chat column (chat-first: full width header/context bar, centered narrower reading column below) ----- */
			.dcs-main { width: 100%; margin: 0; padding: 0 28px 18px 28px; }

			/* ----- Welcome / empty state ----- */
			.dcs-welcome { max-width: 620px; margin: 0 auto; padding: 68px 12px 10px 12px; text-align: center; }
			.dcs-welcome-kicker { font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dcs-accent); margin: 0 0 10px 0; }
			.dcs-welcome-title { font-size: 22px; font-weight: 700; color: var(--dcs-text-strong); margin: 0 0 14px 0; line-height: 1.4; }
			.dcs-welcome-script { font-size: 13.5px; color: var(--dcs-text-muted); margin: 0 0 24px 0; }
			.dcs-welcome-script strong { color: var(--dcs-text); }
			.dcs-chip-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
			.dcs-chip { background: var(--dcs-bg-elevated); border: 1px solid var(--dcs-border); color: var(--dcs-text); font-size: 12.5px; padding: 8px 14px; border-radius: 20px; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.1s ease; }
			.dcs-chip:hover { background: var(--dcs-accent-soft); border-color: var(--dcs-accent-soft-border); color: var(--dcs-accent-strong); transform: translateY(-1px); }
			.dcs-chip:active { transform: translateY(0); }

			/* ----- Messages: conversational, not card-stacked. Only the user's
			   message gets a bubble; the assistant's answer sits directly on the
			   page background with just a small label, matching modern chat UIs
			   (ChatGPT/Claude) instead of boxing every single turn. A hairline
			   divider after each assistant answer replaces the old bordered card
			   as the only separator between exchanges. ----- */
			.dcs-row { margin-bottom: 20px; animation: dcs-turn-in 0.28s ease both; }
			.dcs-row.dcs-assistant:not(:last-child) { padding-bottom: 20px; border-bottom: 1px solid var(--dcs-border-soft); }
			.dcs-row.dcs-user { display: flex; flex-direction: column; align-items: flex-end; }
			.dcs-turn-header { font-weight: 600; font-size: 11.5px; color: var(--dcs-text-faint); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
			.dcs-user .dcs-turn-header { flex-direction: row-reverse; }
			.dcs-turn { line-height: 1.65; font-size: 14.5px; }
			.dcs-user .dcs-turn { background: var(--dcs-user-bg); color: var(--dcs-user-text); border-radius: 16px 16px 4px 16px; padding: 11px 16px; max-width: min(78%, 720px); }
			.dcs-user .dcs-turn .dcs-turn-body p { margin: 0; }
			/* The pane/composer fill the full width (see .dcs-main), but an
			   assistant answer's own text is capped so paragraph lines stay
			   readable on a wide monitor instead of stretching edge to edge -
			   code blocks/tables inside an answer are exempt (see below) since
			   those benefit from the extra width. */
			.dcs-assistant .dcs-turn { color: var(--dcs-text); }
			.dcs-assistant .dcs-turn-body { max-width: 900px; }
			.dcs-assistant .dcs-turn-body pre { max-width: none; }
			.dcs-error .dcs-turn { background: var(--dcs-error-bg); border: 1px solid var(--dcs-error-border); color: var(--dcs-error-text); border-radius: 12px; padding: 12px 14px; }
			.dcs-turn-body p { margin: 0 0 12px 0; }
			.dcs-turn-body p:last-child { margin-bottom: 0; }
			.dcs-turn-body ul, .dcs-turn-body ol { margin: 0 0 12px 24px; padding: 0; }
			.dcs-turn-body li { margin-bottom: 6px; }
			.dcs-turn-body .dcs-answer-heading { font-size: 15px; font-weight: 700; color: var(--dcs-text-strong); margin: 16px 0 8px 0; }
			.dcs-turn-body .dcs-answer-heading:first-child { margin-top: 0; }
			.dcs-turn-body code { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); padding: 2px 6px; border-radius: 4px; font-family: var(--dcs-font-mono); font-size: 13px; }
			.dcs-user .dcs-turn-body code { background: rgba(255,255,255,0.2); color: #ffffff; }
			.dcs-turn-body pre { background: var(--dcs-code-bg); color: var(--dcs-code-text); padding: 12px 14px; border-radius: 8px; overflow-x: auto; margin: 0 0 12px 0; }
			.dcs-turn-body pre code { background: none; color: inherit; padding: 0; font-size: 13px; }
			.dcs-badge { background: rgba(255,255,255,0.25); color: inherit; font-size: 10.5px; padding: 3px 8px; border-radius: 10px; margin-left: 6px; font-weight: 600; }
			.dcs-assistant .dcs-badge { background: var(--dcs-success-bg); color: var(--dcs-success-text); margin-left: 0; }
			.dcs-warning-banner { background: var(--dcs-warn-banner-bg); border: 1px solid var(--dcs-warn-border); color: var(--dcs-warn-text); font-size: 12.5px; padding: 8px 10px; border-radius: 6px; margin-bottom: 10px; }
			/* Page-level notice banner (validation messages, rate limit,
			   KB upload/remove confirmations) - neutral amber by default
			   (most of these aren't emergencies), a distinct green tone only
			   for the two real success confirmations. Never red: that's
			   reserved for genuine generation failures rendered inline as a
			   turn (.dcs-row.dcs-error in the transcript), not this banner. */
			.dcs-notice { font-size: 13px; padding: 10px 14px; border-radius: 10px; margin-bottom: 16px; }
			.dcs-notice-warn { background: var(--dcs-warn-banner-bg); border: 1px solid var(--dcs-warn-border); color: var(--dcs-warn-text); }
			.dcs-notice-success { background: var(--dcs-success-bg); border: 1px solid var(--dcs-success-text); color: var(--dcs-success-text); }
			.dcs-sources { font-size: 11.5px; color: var(--dcs-text-muted); margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--dcs-border-soft); }
			.dcs-sources-label { font-weight: 600; color: var(--dcs-text-muted); margin-right: 4px; }
			.dcs-source-chip { display: inline-block; background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); padding: 2px 8px; border-radius: 8px; margin: 2px 3px 0 0; font-family: var(--dcs-font-mono); font-size: 10.5px; }
			.dcs-activity-strip { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
			.dcs-activity-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 20px; }
			.dcs-activity-rag { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); }
			.dcs-activity-tool { background: var(--dcs-success-bg); color: var(--dcs-success-text); }
			.dcs-activity-cite { background: var(--dcs-bg-subtle); color: var(--dcs-text-muted); border: 1px solid var(--dcs-border); }
			.dcs-muted { color: var(--dcs-text-muted); }
			.dcs-llm-meta { margin-top: 10px; font-size: 11.5px; color: var(--dcs-text-muted); }
			.dcs-llm-meta summary { cursor: pointer; color: var(--dcs-accent); font-weight: 600; }
			.dcs-llm-meta-list { margin: 6px 0 0 16px; padding: 0; }

			/* ----- Thinking indicator ----- */
			.dcs-thinking { display: none; align-items: center; gap: 8px; font-size: 13px; color: var(--dcs-text-muted); margin: 14px 0 0 2px; }
			.dcs-thinking.dcs-active { display: flex; }
			.dcs-thinking .dcs-spark { animation: dcs-pulse 1.1s ease-in-out infinite; }
			.dcs-thinking-dots { display: inline-flex; gap: 3px; }
			.dcs-thinking-dots span { width: 5px; height: 5px; border-radius: 50%; background: var(--dcs-accent); animation: dcs-pulse 1.1s ease-in-out infinite; }
			.dcs-thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
			.dcs-thinking-dots span:nth-child(3) { animation-delay: 0.3s; }

			/* height: 55vh is the fallback; pageInit's JS sets an explicit px
			   height to actually fill the viewport below the header, so this
			   only matters before that runs (or if it somehow can't). No border/
			   card background here on purpose - this pane should read as "the
			   page", with the single browser-native scrollbar being the only
			   visual cue it scrolls, instead of looking like a separate boxed
			   widget with its own chrome nested inside the page. */
			.dcs-transcript-pane { height: 55vh; overflow-y: auto; overflow-x: hidden; padding: 20px 0 4px 0; }
			.dcs-composer-wrap { position: sticky; bottom: 12px; z-index: 5; }
			.dcs-composer { display: flex; align-items: flex-end; gap: 8px; background: var(--dcs-bg-elevated); border: 1px solid var(--dcs-border); border-radius: 16px; padding: 10px 10px 10px 12px; box-shadow: var(--dcs-shadow-lg); }
			.dcs-attach-btn { flex: 0 0 auto; cursor: pointer; user-select: none; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--dcs-bg-subtle); color: var(--dcs-text-muted); font-size: 16px; transition: background 0.15s ease, color 0.15s ease; }
			.dcs-attach-btn:hover { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); }
			.dcs-attach-input { display: none; }
			.dcs-composer-input { flex: 1 1 auto; resize: none; border: none; outline: none; font-family: inherit; color: var(--dcs-text); font-size: 14.5px; line-height: 1.5; padding: 8px 4px; max-height: 160px; min-height: 22px; overflow-y: auto; background: transparent; }
			.dcs-composer-input::placeholder { color: var(--dcs-text-faint); }
			.dcs-send-btn { flex: 0 0 auto; background: var(--dcs-accent); color: #ffffff; border: none; border-radius: 10px; padding: 9px 18px; font-size: 13.5px; font-weight: 600; cursor: pointer; transition: background 0.15s ease, transform 0.1s ease; }
			.dcs-send-btn:hover:not(:disabled) { background: var(--dcs-accent-strong); }
			.dcs-send-btn:active:not(:disabled) { transform: scale(0.97); }
			.dcs-send-btn:disabled { background: var(--dcs-border); color: var(--dcs-text-faint); cursor: not-allowed; }
			.dcs-composer-footer { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 0 6px; font-size: 11.5px; }
			.dcs-clear-link { background: none; border: none; color: var(--dcs-text-faint); font-size: 11.5px; cursor: pointer; text-decoration: underline; padding: 0; }
			.dcs-clear-link:hover { color: var(--dcs-error-border); }

			/* ----- Drawers (Knowledge Base / AI Lab) - slide in from the right
			   over a backdrop, opened/closed purely client-side (openDrawer/
			   closeDrawer in the client script). Their form fields stay in the
			   DOM and inside the same <form> at all times regardless of open
			   state, so they still post normally with every action. ----- */
			.dcs-backdrop { position: fixed; inset: 0; background: rgba(15,17,23,0.45); opacity: 0; pointer-events: none; transition: opacity 0.2s ease; z-index: 40; }
			.dcs-backdrop.dcs-open { opacity: 1; pointer-events: auto; }
			.dcs-drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(380px, 92vw); background: var(--dcs-bg-elevated); border-left: 1px solid var(--dcs-border); box-shadow: var(--dcs-shadow-lg); transform: translateX(100%); transition: transform 0.22s ease; z-index: 50; display: flex; flex-direction: column; color: var(--dcs-text); }
			.dcs-drawer.dcs-open { transform: translateX(0); }
			.dcs-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--dcs-border); flex: 0 0 auto; }
			.dcs-drawer-header h2 { margin: 0; font-size: 15px; font-weight: 700; color: var(--dcs-text-strong); display: flex; align-items: center; gap: 8px; }
			.dcs-drawer-count { font-size: 11px; font-weight: 700; color: var(--dcs-accent-strong); background: var(--dcs-accent-soft); padding: 2px 8px; border-radius: 10px; }
			.dcs-drawer-close { width: 28px; height: 28px; border-radius: 50%; border: none; background: var(--dcs-bg-subtle); color: var(--dcs-text-muted); font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s ease, color 0.15s ease; }
			.dcs-drawer-close:hover { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); }
			.dcs-drawer-body { flex: 1 1 auto; overflow-y: auto; padding: 16px 18px 24px 18px; font-size: 12.5px; color: var(--dcs-text-muted); }

			/* AI Lab drawer groups */
			.dcs-lab-group { margin-bottom: 22px; }
			.dcs-lab-group h3 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dcs-text-faint); margin: 0 0 8px 0; }
			.dcs-lab-item { display: flex; align-items: center; gap: 8px; padding: 7px 0; font-size: 12.5px; color: var(--dcs-text); cursor: pointer; }
			.dcs-lab-item input[disabled] { opacity: 0.5; }
			.dcs-lab-select { display: block; }
			.dcs-lab-select select { font-size: 12.5px; padding: 7px 9px; border: 1px solid var(--dcs-border); border-radius: 7px; background: var(--dcs-bg); color: var(--dcs-text); width: 100%; margin-top: 4px; }
			.dcs-lab-footnote { font-size: 11px; margin: 8px 0 0 0; line-height: 1.5; }

			/* Knowledge Base drawer */
			.dcs-kb-group-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dcs-text-faint); margin: 18px 0 8px 0; }
			.dcs-kb-group-label:first-child { margin-top: 0; }
			.dcs-kb-list { list-style: none; margin: 0; padding: 0; }
			.dcs-kb-row { display: flex; align-items: center; gap: 6px; padding: 7px 0; border-bottom: 1px solid var(--dcs-border-soft); }
			.dcs-kb-row:last-child { border-bottom: none; }
			.dcs-kb-name { flex: 1 1 auto; font-family: var(--dcs-font-mono); font-size: 11px; color: var(--dcs-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.dcs-kb-tag { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); font-size: 9.5px; padding: 1px 7px; border-radius: 8px; }
			.dcs-kb-tag-inactive { background: var(--dcs-warn-bg); color: var(--dcs-warn-text); }
			.dcs-kb-remove { background: none; border: none; color: var(--dcs-text-faint); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
			.dcs-kb-remove:hover { color: var(--dcs-error-border); }
			.dcs-kb-empty { padding: 4px 0; }
			.dcs-kb-hint { margin: 10px 0 0 0; }
			.dcs-kb-upload-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--dcs-border); }
			.dcs-kb-add-btn { background: var(--dcs-accent-soft); color: var(--dcs-accent-strong); border: 1px dashed var(--dcs-accent-soft-border); border-radius: 8px; padding: 6px 12px; font-size: 11.5px; font-weight: 600; cursor: pointer; transition: background 0.15s ease; }
			.dcs-kb-add-btn:hover { background: var(--dcs-accent-soft-border); }
			.dcs-kb-filename { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

			/* ----- Responsive ----- */
			@media (max-width: 640px) {
				.dcs-header { padding: 12px 14px; }
				.dcs-header-brand .dcs-app-name-text { display: none; }
				.dcs-script-selector { order: 3; flex-basis: 100%; max-width: none; }
				.dcs-main { padding: 0 12px 14px 12px; }
				.dcs-welcome { padding-top: 40px; }
				.dcs-welcome-title { font-size: 19px; }
				.dcs-user .dcs-turn { max-width: 92%; }
				.dcs-drawer { width: 100vw; border-left: none; }
			}
		</style>
		<div class="dcs-shell">
			<div class="dcs-backdrop" id="dcs_backdrop" onclick="closeDrawer()"></div>
			<div class="dcs-header">
				<div class="dcs-header-brand"><span class="dcs-spark">&#10022;</span> <span class="dcs-app-name-text">Debug Copilot</span></div>
				${buildScriptSelectorHtml(state, scriptRows)}
				<div class="dcs-header-actions">
					<button type="button" class="dcs-header-btn" onclick="openDrawer('kb')">&#128218; Knowledge Base <span class="dcs-header-btn-count">(${KNOWLEDGE_FILES.length + kbListing.uploaded.length})</span></button>
					<button type="button" class="dcs-header-btn" onclick="openDrawer('lab')">&#129514; AI Lab</button>
					<button type="button" id="dcs_theme_toggle" class="dcs-theme-toggle" title="Switch to dark theme" onclick="toggleTheme()">&#9789;</button>
				</div>
			</div>
			${buildContextBarHtml(state)}
			<div class="dcs-main">
				${noticeHtml}
				<div id="dcs_transcript_scroll" class="dcs-transcript-pane">${hasScript ? buildTranscriptHtml(state) : buildNoScriptSelectedHtml()}<div id="dcs_thinking" class="dcs-thinking"><span class="dcs-spark">&#10022;</span> <span class="dcs-thinking-label">Copilot is thinking...</span> <span class="dcs-thinking-dots"><span></span><span></span><span></span></span></div></div>
				<div class="dcs-composer-wrap">
					<div class="dcs-composer">
						<label for="dcs_image_input" class="dcs-attach-btn" title="Only needed for something NOT visible in the script's source, like an on-screen error dialog - the source already loads automatically.">&#128206;</label>
						<input type="file" id="dcs_image_input" class="dcs-attach-input" accept="image/png,image/jpeg" />
						<textarea id="${MESSAGE_FIELD_ID}" name="${MESSAGE_FIELD_ID}" class="dcs-composer-input" rows="1" placeholder="${hasScript ? 'Ask anything about this script...' : 'Select a script above first...'}"${hasScript ? '' : ' disabled="disabled"'}></textarea>
						<button type="button" id="custpage_btn_send" class="dcs-send-btn" onclick="sendMessage()"${hasScript ? '' : ' disabled="disabled"'}>Send</button>
					</div>
					<div class="dcs-composer-footer">
						<span class="dcs-muted" id="dcs_image_status"></span>
						<button type="button" class="dcs-clear-link" onclick="clearConversation()">Clear conversation</button>
					</div>
				</div>
			</div>
			${buildKbPanelHtml(kbListing)}
			${buildLabPanelHtml(state.lab, getPromptStudioId(), state.usage || llm.getRemainingUsage())}
		</div>`;

		[
			{ id: ACTION_FIELD_ID, type: serverWidget.FieldType.TEXT },
			{ id: STATE_FIELD_ID, type: serverWidget.FieldType.LONGTEXT },
			{ id: IMAGE_DATA_FIELD_ID, type: serverWidget.FieldType.LONGTEXT },
			{ id: IMAGE_TYPE_FIELD_ID, type: serverWidget.FieldType.TEXT },
			{ id: KB_REMOVE_DOC_ID_FIELD_ID, type: serverWidget.FieldType.TEXT },
			{ id: KB_UPLOAD_NAME_FIELD_ID, type: serverWidget.FieldType.TEXT },
			{ id: KB_UPLOAD_CONTENT_FIELD_ID, type: serverWidget.FieldType.LONGTEXT },
			{ id: KB_UPLOAD_SIZE_FIELD_ID, type: serverWidget.FieldType.TEXT }
		].forEach((def) => {
			const field = form.addField({ id: def.id, label: def.id, type: def.type });
			field.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
		});
		form.getField({ id: STATE_FIELD_ID }).defaultValue = JSON.stringify({
			targetScriptId: state.targetScriptId,
			targetDeploymentId: state.targetDeploymentId,
			targetScriptName: state.targetScriptName,
			turns: state.turns || [],
			lab: mergeLab(state.lab)
		});

		return form;
	};

	const setSecurityHeaders = (response) => {
		response.setHeader({ name: 'X-Content-Type-Options', value: 'nosniff' });
		response.setHeader({ name: 'X-Frame-Options', value: 'SAMEORIGIN' });
		response.setHeader({ name: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' });
	};

	// Splits the datalist selector's "Name — scriptid — deploymentid" value
	// back into parts - see scriptOptionValue's comment on why em-dash is a
	// safe separator (script/deployment ids can't contain it).
	const parseScriptSelectorValue = (value) => {
		const parts = String(value || '').split('::');
		if (parts.length < 3 || isBlank(parts[0])) {
			return null;
		}
		const [scriptid, deploymentid, ...nameParts] = parts;
		return { scriptid, deploymentid, scriptname: nameParts.join('::') };
	};

	const onRequest = (context) => {
		setSecurityHeaders(context.response);

		if (context.request.method === 'GET') {
			const params = context.request.parameters;
			// No ?scriptid= is now a normal, first-class state of the SAME
			// page (a script-selection prompt inside the unified layout),
			// not a different page - see buildForm/buildNoScriptSelectedHtml.
			const state = {
				targetScriptId: params.scriptid || '',
				targetDeploymentId: params.deploymentid || '',
				targetScriptName: params.scriptname || '',
				turns: [],
				lab: mergeLab()
			};
			// Resolved on every render (GET here, POST below) rather than
			// cached across requests: cheap (one SuiteQL row lookup + a
			// handful of file.load calls), and always reflects the script's
			// current deployed source rather than a possibly-stale copy.
			state.sourceInfo = isBlank(state.targetScriptId)
				? { fileNames: [], sourceMissing: true, sourceTruncated: false, error: null }
				: summarizeSourceContext(loadScriptSourceContext(state.targetScriptId));
			context.response.writePage(buildForm(state));
			return;
		}

		// POST
		const params = context.request.parameters;
		let state = parseState(params[STATE_FIELD_ID]);
		state.lab = readLabFromParams(params, state.lab);
		const action = params[ACTION_FIELD_ID] || '';

		if (action === 'switchscript') {
			// Switching scripts starts a fresh conversation deliberately -
			// see file header note on TEST 2 (script switching must not leak
			// old-script context). The old script's cache/embeddings are
			// untouched on disk; this only resets what THIS page/session is
			// looking at.
			const selected = parseScriptSelectorValue(params[SELECTED_SCRIPT_FIELD_ID]);
			if (selected) {
				state.targetScriptId = selected.scriptid;
				state.targetDeploymentId = selected.deploymentid;
				state.targetScriptName = selected.scriptname;
				state.turns = [];
				state.notice = '';
			} else {
				state.notice = 'Could not match that selection to a deployed script. Please pick one from the list.';
			}
			state.sourceInfo = summarizeSourceContext(loadScriptSourceContext(state.targetScriptId));
		} else if (action === 'clear') {
			state.turns = [];
			state.notice = '';
			state.sourceInfo = summarizeSourceContext(loadScriptSourceContext(state.targetScriptId));
		} else if (action === 'ask') {
			const message = params[MESSAGE_FIELD_ID] || '';
			const imageData = (params[IMAGE_DATA_FIELD_ID] || '').substring(0, MAX_IMAGE_BASE64_LENGTH) || null;
			const imageType = params[IMAGE_TYPE_FIELD_ID] || null;
			const sourceContext = loadScriptSourceContext(state.targetScriptId);
			state.sourceInfo = summarizeSourceContext(sourceContext);
			state = handleAsk(state, message, imageData, imageType, sourceContext);
		} else if (action === 'uploaddoc') {
			const uploadName = params[KB_UPLOAD_NAME_FIELD_ID] || '';
			const uploadedFile = isBlank(uploadName) ? null : {
				name: uploadName,
				size: parseInt(params[KB_UPLOAD_SIZE_FIELD_ID], 10) || 0,
				contents: params[KB_UPLOAD_CONTENT_FIELD_ID] || ''
			};
			state = handleUploadKbDocument(state, uploadedFile);
			state.sourceInfo = summarizeSourceContext(loadScriptSourceContext(state.targetScriptId));
		} else if (action === 'removedoc') {
			state = handleRemoveKbDocument(state, params[KB_REMOVE_DOC_ID_FIELD_ID]);
			state.sourceInfo = summarizeSourceContext(loadScriptSourceContext(state.targetScriptId));
		}

		context.response.writePage(buildForm(state));
	};

	return { onRequest };
});
