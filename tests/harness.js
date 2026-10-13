// Loads the REAL debug_copilot_suitelet.js with mocked NetSuite modules.
const fs = require('fs');
const path = '' + require('path').join(__dirname, '../src/FileCabinet/SuiteScripts/debug_copilot_suitelet.js') + '';
let src = fs.readFileSync(path, 'utf8');
src = src.replace('return { onRequest };',
  'return { onRequest, handleAsk, cosineSimilarity, normalizeQuestionForExactMatch, isRefusalAnswer, questionNeedsLiveTools, prefetchLiveToolResults, inferRecordTypeForSchema, buildConversationTranscript, extractLocalDependencies, truncateSource, renderMarkdownToHtml, computeContextHash, hashString, buildLlmMetaHtml, buildActivityStripHtml, SIMILARITY_THRESHOLD, loadScriptSourceContext, drainStreamed, generateOnce };');
module.exports = function load(mocks) {
  let exported;
  const define = (deps, factory) => { exported = factory(mocks.llm, mocks.query, mocks.record, mocks.file, mocks.runtime, mocks.cache, mocks.log, mocks.serverWidget); };
  new Function('define', src)(define);
  return exported;
};
