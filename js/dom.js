'use strict';
// ---------------------------------------------------------------------
// DOM handles and caches
// The elements the rest of the code talks to, looked up once, plus the
// in-memory caches shared across requests.
// ---------------------------------------------------------------------

const guildInput  = document.getElementById('guildInput');
const runBtn      = document.getElementById('runBtn');
const impactOverlay = document.getElementById('impactOverlay');
const pageEl      = document.getElementById('page');
const statusMsg   = document.getElementById('statusMsg');
const resultsPlaceholder = document.getElementById('resultsPlaceholder');
const resultCard  = document.getElementById('resultCard');
const resultBody  = document.getElementById('resultBody');
const matchPanelsContainer = document.getElementById('matchPanelsContainer');
const copyRow = document.getElementById('copyRow');
const copyChatBtn = document.getElementById('copyChatBtn');
const copyDiscordBtn = document.getElementById('copyDiscordBtn');
const copyFeedback = document.getElementById('copyFeedback');
const standingsGridNA   = document.getElementById('standingsGridNA');
const standingsGridEU   = document.getElementById('standingsGridEU');
const standingsStatusNA = document.getElementById('standingsStatusNA');
const standingsStatusEU = document.getElementById('standingsStatusEU');
const relinkBanner = document.getElementById('relinkBanner');

let wvwMapCache = null;              // { na: {guid: teamId}, eu: {guid: teamId} }
let wvwMapCachedAt = 0;
const guildNameCache = new Map();    // guildId -> { ok, data } | { ok: false, error }
const teamToMatchId = new Map();     // teamId -> matchId
const matchDataCache = new Map();    // matchId -> match object from the API
