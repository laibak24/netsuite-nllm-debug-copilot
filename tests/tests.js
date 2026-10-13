const load = require('./harness.js');
const fs = require('fs');
const KB = '' + require('path').join(__dirname, '../src/FileCabinet/SuiteScripts/debug-copilot/knowledge') + '/';
const results = [];
const out = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL'} | ${name}${detail !== undefined ? ' | ' + detail : ''}`); };

function makeEnv(opts = {}) {
  const calls = { generateText: [], streamed: 0, embed: [], evaluatePrompt: [], scriptnote: 0, fileCreates: [] };
  const rows = [];
  const files = {};
  const scriptSrc = opts.scriptSrc || "define(['N/record','./helper','../up'], (r)=>{ return {}; });";
  let nextId = 1;
  const mkFile = (name, contents, p) => ({ name, path: p, folder: 5, id: 900, getContents: () => contents, set contents(v) { files[p] = v; }, save() { return 900; } });
  const file = {
    Type: { PLAINTEXT: 'PLAINTEXT', JSON: 'JSON', PNGIMAGE: 'PNGIMAGE', JPGIMAGE: 'JPGIMAGE' }, Encoding: { UTF8: 'UTF8' },
    load({ id }) {
      if (id === 100) return mkFile('test.js', scriptSrc, '/SuiteScripts/test.js');
      if (String(id) === '/SuiteScripts/helper.js') return mkFile('helper.js', '// helper', '/SuiteScripts/helper.js');
      if (String(id).startsWith('SuiteScripts/debug-copilot/knowledge/')) {
        const n = String(id).split('/').pop();
        if (fs.existsSync(KB + n)) return mkFile(n, fs.readFileSync(KB + n, 'utf8'), id);
      }
      if (id === 'SuiteScripts/debug_copilot_suitelet.js') return mkFile('debug_copilot_suitelet.js', '', id);
      if (files[id] !== undefined) return { name: id, path: id, id: 901, folder: 5, getContents: () => files[id], set contents(v) { files[id] = v; }, save() { return 901; } };
      if (id === 901 || id === 902) return { name: 'img', path: 'img', id, getContents: () => '' };
      throw new Error('FILE_NOT_FOUND ' + id);
    },
    create(o) { calls.fileCreates.push({ name: o.name, len: String(o.contents || '').length, type: o.fileType }); return { id: 902, save() { files['SuiteScripts/' + o.name] = o.contents; return 902; } }; }
  };
  const record = {
    create({ type }) { const v = {}; return { setValue({ fieldId, value }) { v[fieldId] = value; }, save() { const id = nextId++; if (type === 'customrecord_debug_session') rows.unshift({ id, question: v.custrecord_dcs_question, answer: v.custrecord_dcs_answer, contexthash: v.custrecord_dcs_context_hash }); return id; } }; }
  };
  const query = {
    runSuiteQL({ query: q }) {
      let r = [];
      if (q.includes('customrecord_debug_session')) r = rows.slice();
      else if (q.includes('FROM script WHERE')) r = [{ id: 7, name: 'Test Script', scriptfile: 100 }];
      else if (q.includes('scriptnote')) { calls.scriptnote++; r = [{ title: 'ERR', detail: 'boom' }]; }
      return { asMappedResults: () => r };
    }
  };
  const embedFn = opts.embedFn || ((t) => { const v = new Array(8).fill(0); for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i); return v; });
  const llm = {
    ModelFamily: { COHERE_COMMAND: 'COHERE_COMMAND', COHERE_COMMAND_A_VISION: 'COHERE_COMMAND_A_VISION' }, EmbedModelFamily: { COHERE_EMBED: 'COHERE_EMBED' }, Truncate: { END: 'END' }, SafetyMode: { CONTEXTUAL: 'CONTEXTUAL' },
    createDocument: (o) => o, createTool: (o) => o, createToolParameter: (o) => o, createToolResult: (o) => o,
    generateText(o) { calls.generateText.push(o); return opts.generateText ? opts.generateText(o, calls.generateText.length) : { text: 'Answer for: ' + (o.prompt || '').slice(-40), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'm' }; },
    generateTextStreamed() { calls.streamed++; throw new Error('should not stream'); },
    embed(o) { calls.embed.push(o); if (opts.embedThrows) throw new Error('EMBED_QUOTA'); return { embeddings: o.inputs.map(embedFn) }; },
    evaluatePrompt(o) { calls.evaluatePrompt.push(o); return opts.evaluatePrompt ? opts.evaluatePrompt(o) : { text: 'PS answer' }; },
    getRemainingUsage: () => ({ remaining: 1 })
  };
  const store = {};
  const cache = { Scope: { PUBLIC: 'PUBLIC' }, getCache: () => ({ get: ({ key }) => store[key], put: ({ key, value }) => { store[key] = value; } }) };
  const runtime = { getCurrentScript: () => ({ getRemainingUsage: () => 1000, getParameter: () => 'custprompt_debug_copilot_qa' }), getCurrentUser: () => ({ id: 1 }) };
  const log = { audit() {}, error() {}, debug() {} };
  const field = () => ({ updateDisplayType() {}, defaultValue: '' });
  const serverWidget = { FieldType: {}, FieldDisplayType: { HIDDEN: 'H' }, createForm: () => ({ addField: field, getField: field }) };
  const ex = load({ llm, query, record, file, runtime, cache, log, serverWidget });
  return { ex, calls, rows, files, llm, store };
}
const newState = (lab) => ({ targetScriptId: 'customscript_x', targetDeploymentId: 'customdeploy_x', targetScriptName: 'Test Script', turns: [], lab });
const ask = (env, state, q, img, imgType) => env.ex.handleAsk(state, q, img || null, imgType || null, env.ex.loadScriptSourceContext(state.targetScriptId));
const last = (s) => s.turns[s.turns.length - 1];

// T1 pure functions
{
  const { ex } = makeEnv();
  out('T1a cosine identical=1, orthogonal=0', Math.abs(ex.cosineSimilarity([1, 2], [1, 2]) - 1) < 1e-9 && ex.cosineSimilarity([1, 0], [0, 1]) === 0);
  out('T1b exact-match normalization (case/space/trailing ?)', ex.normalizeQuestionForExactMatch('  What  Does THIS script do?? ') === 'what does this script do');
  const refusals = ["I can't determine that from the selected script's source code.", 'I can only answer questions about debugging', "i'm sorry, i can't answer that question", "I don't have enough information to answer", 'not enough information to answer', 'only able to answer questions about debugging'];
  out('T1c refusal blocklist catches all 6 patterns', refusals.every(ex.isRefusalAnswer));
  out('T1d refusal blocklist misses a reworded refusal', ex.isRefusalAnswer('Unfortunately I cannot help with that request.') === false, 'best-effort, as the code says');
  out('T1e threshold constant', ex.SIMILARITY_THRESHOLD === 0.69, String(ex.SIMILARITY_THRESHOLD));
  out('T1f markdown renderer escapes injected HTML', !ex.renderMarkdownToHtml('<script>alert(1)</script> **b**').includes('<script>') && ex.renderMarkdownToHtml('**b**').includes('<strong>b</strong>'));
  out('T1g extractLocalDependencies keeps ./ and skips ../ and N/', JSON.stringify(ex.extractLocalDependencies("define(['N/record','./a','../b','./c'], f)")) === '["a","c"]');
  const t = ex.truncateSource('x'.repeat(30000), 20000);
  out('T1h truncateSource caps at 20,000 + marker', t.truncated && t.text.length > 20000 && t.text.includes('[truncated: showing 20000 of 30000'));
}
// T2 keyword gate
{
  const { ex } = makeEnv();
  const suggested = ['What does this script do?', 'Explain the execution flow.', 'What modules does it use?', 'What records does it interact with?', 'Where could it fail?', 'Are there governance concerns?', 'How could this script be improved?'];
  console.log('INFO | T2 keyword gate on the 7 suggested chips: ' + suggested.map((q) => `${ex.questionNeedsLiveTools(q) ? 'LIVE' : 'no'} "${q}"`).join(' ; '));
  ['Explain the logic of this script', 'Is there a catalog lookup?', 'Does it truncate the result?', 'What does it do at runtime?'].forEach((q) => out(`T2 false-positive probe "${q}"`, null, `gate=${ex.questionNeedsLiveTools(q)}`));
  out('T2b "logic" triggers the live-data gate', ex.questionNeedsLiveTools('Explain the logic of this script') === true);
  const env = makeEnv(); const pf = env.ex.prefetchLiveToolResults('Explain the logic of this script', newState());
  out('T2c "logic" actually runs the execution-log query (prefetch regex)', pf.length === 1 && pf[0].name === 'getExecutionLogForScript' && env.calls.scriptnote === 1);
  out('T2d unknown record type defaults to salesorder', makeEnv().ex.inferRecordTypeForSchema('what fields does the thing have') === 'salesorder');
}
// T3 transcript budget
{
  const { ex } = makeEnv();
  const turns = []; for (let i = 0; i < 40; i++) turns.push({ role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(3900) });
  const tr = ex.buildConversationTranscript({ turns });
  out('T3a transcript budget ~6000 chars, oldest trimmed with marker', tr.includes('Earlier turns omitted'), `len=${tr.length} (budget 6000; the newest turn is always kept even if it alone is 3,900)`);
  const small = ex.buildConversationTranscript({ turns: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'hi' })) });
  out('T3b turn cap = last 24 turns', small.split('\n').length === 24, `lines=${small.split('\n').length}`);
}
// T4 default path
{
  const env = makeEnv(); const s = ask(env, newState(), 'What errors appeared in the latest execution log?');
  const opts = env.calls.generateText[0]; const meta = last(s).llmMeta;
  out('T4a default path calls generateText once', env.calls.generateText.length === 1);
  out('T4b default path sends NO tools to N/llm', opts.tools === undefined);
  out('T4c live-data turn skips documents[]', opts.documents === undefined && meta.documentCount === 0);
  out('T4d tool JSON injected into prompt as text', opts.prompt.includes('Live account data fetched by SuiteScript (not via N/llm tool-calling)'));
  out('T4e TELEMETRY QUIRK: panel still says "Tools offered" though none were sent to N/llm', meta.toolsOffered.length === 2 && opts.tools === undefined, JSON.stringify(meta.toolsOffered));
  out('T4f streaming never attempted (skipStreaming=true)', env.calls.streamed === 0);
  const e2 = makeEnv(); ask(e2, newState(), 'What does this script do?');
  const o2 = e2.calls.generateText[0];
  out('T4g plain question: 4 built-in documents + preamble + temp 0.2 / 1200 tokens', o2.documents.length === 4 && !!o2.preamble && o2.modelParameters.temperature === 0.2 && o2.modelParameters.maxTokens === 1200, `docs=${o2.documents.length}`);
}
// T4x gate/prefetch mismatch on the blog's example question
{
  const env = makeEnv(); const s = ask(env, newState(), 'Why did this script fail?');
  const o = env.calls.generateText[0];
  out('T4x "Why did this script fail?": gate fires, documents dropped, but NO live data fetched', o.documents === undefined && !o.prompt.includes('Live account data') && env.calls.scriptnote === 0, 'documentCount=' + last(s).llmMeta.documentCount + ' scriptnoteQueries=' + env.calls.scriptnote);
  const env2 = makeEnv(); const s2 = ask(env2, newState(), 'Where could it fail?');
  out('T4y suggested chip "Where could it fail?": KB documents silently dropped', env2.calls.generateText[0].documents === undefined && last(s2).llmMeta.documentCount === 0);
}
// T5 native tools
{
  const env = makeEnv({ generateText: (o, n) => n === 1 ? { text: '', toolCalls: [{ name: 'getExecutionLogForScript', parameters: { limit: '5' } }], chatHistory: ['h'] } : { text: 'final after tool', usage: {}, model: 'm' } });
  const s = ask(env, newState({ useNativeTools: true }), 'Why did this script fail?');
  out('T5a native success: 2 sequential generateText calls when a tool is called', env.calls.generateText.length === 2, `calls=${env.calls.generateText.length}`);
  out('T5b native path: tools sent, NO documents, 2nd call carries chatHistory+toolResults', env.calls.generateText[0].tools.length === 2 && env.calls.generateText[0].documents === undefined && env.calls.generateText[1].toolResults.length === 1 && env.calls.generateText[1].chatHistory[0] === 'h');
  out('T5c native api label + trace', last(s).llmMeta.api === 'generateText (native tools)' && last(s).toolTrace.length === 1);
  const env0 = makeEnv({ generateText: () => ({ text: 'no tool needed', toolCalls: [], usage: {}, model: 'm' }) });
  ask(env0, newState({ useNativeTools: true }), 'What does this script do?');
  out('T5d native with no tool call = only ONE model call', env0.calls.generateText.length === 1);
  const envF = makeEnv({ generateText: (o) => { if (o.tools) { const e = new Error('Unexpected Error'); e.name = 'UNEXPECTED_ERROR'; throw e; } return { text: 'fallback answer', usage: {}, model: 'm' }; } });
  const sF = ask(envF, newState({ useNativeTools: true }), 'What errors appeared in the latest execution log?');
  const notes = last(sF).llmMeta.featureNotes.join(' | ');
  out('T5e native failure falls back; turn still answers', last(sF).text === 'fallback answer' && !last(sF).isError);
  out('T5f failed native attempt COSTS an extra model call (fail + fallback = 2)', envF.calls.generateText.length === 2, `calls=${envF.calls.generateText.length}`);
  out('T5g fallback is visible in Lab notes (not silent)', /Native N\/llm tool-calling attempt failed/.test(notes) && /fell back/.test(notes));
  out('T5h fallback ran the keyword prefetch (execution-log query)', envF.calls.scriptnote === 1);
  const envL = makeEnv({ generateText: () => ({ text: '', toolCalls: [{ name: 'lookupRecordFieldSchema', parameters: { recordType: 'x' } }], chatHistory: [] }) });
  ask(envL, newState({ useNativeTools: true }), 'fields?');
  out('T5i tool loop capped at 4 iterations (1 + 4 = 5 calls)', envL.calls.generateText.length === 5, `calls=${envL.calls.generateText.length}`);
  const envI = makeEnv(); ask(envI, newState({ useNativeTools: true }), 'q', 'AAAA', 'image/png');
  out('T5j native tools disabled when an image is attached', envI.calls.generateText.every((c) => !c.tools));
  const envJ = makeEnv(); ask(envJ, newState({ useNativeTools: true, useJson: true }), 'q');
  out('T5k native tools disabled in JSON mode', envJ.calls.generateText.every((c) => !c.tools));
}
// T6 cache
{
  const env = makeEnv(); const st = newState();
  ask(env, st, 'What does this script do?');
  out('T6a first answer writes a cache row + embeddings JSON file', env.rows.length === 1 && Object.keys(env.files).some((k) => k.includes('debug_copilot_embeddings_customscript_x')));
  const n1 = env.calls.generateText.length, e1 = env.calls.embed.length;
  ask(env, st, 'what does this script do');
  out('T6b exact hit: zero embed calls, zero generateText calls', env.calls.generateText.length === n1 && env.calls.embed.length === e1 && last(st).cacheMatchType === 'exact');
  out('T6c cache-hit turn labelled cache-exact', last(st).llmMeta.api === 'cache-exact');
}
{
  const emb = { 'What does this script do?': [1, 0, 0], 'What is the purpose of this script?': [0.75, 0.66, 0], 'Totally different': [0, 0, 1] };
  const env = makeEnv({ embedFn: (t) => emb[t] || [0, 1, 0] }); const st = newState();
  ask(env, st, 'What does this script do?');
  ask(env, st, 'What is the purpose of this script?');
  out('T6d semantic hit at cosine ~0.75 (>= 0.69)', last(st).cacheMatchType === 'semantic' && last(st).similarity > 0.69, `sim=${last(st).similarity}`);
  ask(env, st, 'Totally different');
  out('T6e unrelated question misses semantic cache', last(st).cached === false);
  out('T6f embed calls: 1 input first, then 2 inputs (prior + current)', env.calls.embed[0].inputs.length === 1 && env.calls.embed[1].inputs.length === 2);
}
{
  const env = makeEnv({ generateText: () => ({ text: "I can't determine that from the selected script's source code.", usage: {}, model: 'm' }) });
  ask(env, newState(), 'q1');
  out('T6g refusal-shaped answer is not cached', env.rows.length === 0);
}
{
  const env = makeEnv({ generateText: (o) => ({ text: o.responseFormat ? '{"answer":"json body","risks":[]}' : 'plain text body', usage: {}, model: 'm' }) });
  const st = newState({ useJson: true }); ask(env, st, 'What does this script do?');
  const st2 = newState({ useJson: false }); ask(env, st2, 'What does this script do?');
  const t = last(st2);
  out('T6h JSON-mode answer IS cached (code comment claims it is not)', env.rows.length === 1 && env.rows[0].answer.startsWith('{"answer"'));
  out('T6i BUG CONFIRMED: later plain-text request gets the raw JSON string from cache', t.cached === true && t.text.startsWith('{"answer"'), `served="${t.text}"`);
}
{
  const env = makeEnv(); ask(env, newState({ useSafety: true }), 'q');
  out('T6j safetyMode CONTEXTUAL sent only when toggled', env.calls.generateText[0].safetyMode === 'CONTEXTUAL');
  const env2 = makeEnv(); ask(env2, newState(), 'q');
  out('T6k safetyMode absent by default', env2.calls.generateText[0].safetyMode === undefined);
}
// T7 vision
{
  const env = makeEnv(); const st = newState();
  ask(env, st, 'describe this image', 'QUJD', 'image/png');
  const c = env.calls.generateText[0];
  out('T7a vision call: image + vision model + 800 tokens', !!c.image && c.modelFamily === 'COHERE_COMMAND_A_VISION' && c.modelParameters.maxTokens === 800);
  out('T7b vision call carries NO preamble/documents/source/history', c.preamble === undefined && c.documents === undefined && !c.prompt.includes('Selected script source') && !c.prompt.includes('Conversation so far'));
  out('T7c TELEMETRY QUIRK: vision turn reports documents[] > 0 though none were sent', last(st).llmMeta.documentCount > 0 && c.documents === undefined, `documentCount=${last(st).llmMeta.documentCount}`);
  out('T7d image saved to File Cabinet under a fixed filename', env.calls.fileCreates.some((f) => f.name === 'debug_copilot_vision_upload.png'));
  out('T7e vision answer is written to the text cache', env.rows.length === 1);
  const env2 = makeEnv(); const st2 = newState();
  ask(env2, st2, 'What is on screen?');
  const before = env2.calls.generateText.length;
  ask(env2, st2, 'What is on screen?', 'QUJD', 'image/png');
  out('T7f BUG CONFIRMED: same question + screenshot served from cache, image never sent', env2.calls.generateText.length === before && last(st2).cached === true && !env2.calls.generateText.some((x) => x.image));
  const env3 = makeEnv({ generateText: (o) => { if (o.image) throw new Error('bad image block'); return { text: 'text only', usage: {}, model: 'm' }; } }); const st3 = newState();
  ask(env3, st3, 'describe', 'QUJD', 'image/png');
  out('T7g vision failure retries text-only with a visible banner', last(st3).text === 'text only' && /did not see the image/.test(last(st3).imageWarning));
  const env4 = makeEnv(); delete env4.llm.ModelFamily.COHERE_COMMAND_A_VISION; const st4 = newState();
  ask(env4, st4, 'describe', 'QUJD', 'image/png');
  out('T7h no vision model family -> banner + text-only', !!last(st4).imageWarning);
}
// T8 Prompt Studio
{
  const env = makeEnv(); const st = newState({ usePromptStudio: true });
  ask(env, st, 'What does this script do?');
  out('T8a evaluatePrompt used with the 4 variables + configured id', env.calls.evaluatePrompt.length === 1 && ['scriptSource', 'question', 'scriptId', 'scriptName'].every((k) => k in env.calls.evaluatePrompt[0].variables) && env.calls.evaluatePrompt[0].id === 'custprompt_debug_copilot_qa');
  out('T8b Prompt Studio bypasses generateText, cache, embed', env.calls.generateText.length === 0 && env.calls.embed.length === 0 && env.rows.length === 0);
  const envE = makeEnv({ evaluatePrompt: () => ({ text: '' }) }); ask(envE, newState({ usePromptStudio: true }), 'q');
  out('T8c empty evaluatePrompt text falls back to generateText', envE.calls.generateText.length === 1);
  const envT = makeEnv({ evaluatePrompt: () => { throw new Error('PROMPT_NOT_FOUND'); } }); const sT = newState({ usePromptStudio: true }); ask(envT, sT, 'q');
  out('T8d evaluatePrompt error falls back + note', envT.calls.generateText.length === 1 && /evaluatePrompt failed/.test(last(sT).llmMeta.featureNotes.join()));
}
// T9 guards
{
  const env = makeEnv(); const st = newState({ useCache: false }); let blocked = false;
  for (let i = 0; i < 31; i++) { ask(env, st, 'unique question ' + i + ' ' + 'z'.repeat(i)); if (/Rate limit/.test(st.notice || '')) blocked = true; }
  out('T9a rate limit blocks the 31st question in an hour', blocked && env.calls.generateText.length === 30, `generateText calls=${env.calls.generateText.length}`);
  const st2 = ask(makeEnv(), newState(), 'x'.repeat(4001));
  out('T9b 4,000-char message cap', /too long/.test(st2.notice));
  const envG = makeEnv({ embedThrows: true });
  let threw = false; try { ask(envG, newState(), 'new question'); } catch (e) { threw = true; }
  out('T9c embed failure is NOT caught inside handleAsk', threw);
  const envGPT = makeEnv(); envGPT.llm.ModelFamily.GPT_OSS = 'GPT_OSS'; const sG = newState({ modelKey: 'GPT_OSS', useJson: true });
  ask(envGPT, sG, 'q');
  out('T9d GPT-OSS: no documents, no responseFormat, notes shown', envGPT.calls.generateText[0].documents === undefined && envGPT.calls.generateText[0].responseFormat === undefined && last(sG).llmMeta.featureNotes.length >= 2);
  const envNo = makeEnv(); const sN = newState({ modelKey: 'GPT_OSS' }); ask(envNo, sN, 'q');
  out('T9e GPT-OSS missing on account -> Cohere fallback note', /GPT-OSS is not on llm.ModelFamily/.test(last(sN).llmMeta.featureNotes.join()));
}
// T10 source pipeline
{
  const env = makeEnv(); const sc = env.ex.loadScriptSourceContext('customscript_x');
  out('T10 source pipeline: primary file + same-folder dep loaded; ../ dep not loaded', sc.files.length === 2, `files=${sc.files.map((f) => f.name)} sourceTruncatedFlag=${sc.sourceTruncated}`);
}
// T11 oversize image
{
  const big = 'A'.repeat(3100000);
  const env = makeEnv();
  const params = { custpage_state: JSON.stringify(newState()), custpage_action: 'ask', custpage_message_input: 'describe', custpage_image_data: big, custpage_image_type: 'image/png' };
  env.ex.onRequest({ request: { method: 'POST', parameters: params }, response: { setHeader() {}, writePage() {} } });
  const created = env.calls.fileCreates.find((f) => f.name.startsWith('debug_copilot_vision_upload'));
  out('T11 oversize image silently truncated (not rejected) before saving', !!created && created.len === 3000000, `saved ${created && created.len} of ${big.length} chars`);
}
console.log(`\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => r.ok === false).length} failed, ${results.filter((r) => r.ok === null).length} info`);
