'use strict';
// DOM handles looked up once, plus the in-memory caches shared across requests.

const guildInput  = document.getElementById('guildInput');
const runBtn      = document.getElementById('runBtn');
const impactOverlay = document.getElementById('impactOverlay');
const standingsGridNA   = document.getElementById('standingsGridNA');
const standingsGridEU   = document.getElementById('standingsGridEU');
// 'eu' when EU's column is on the left (js/region.js and the swap button).
const railFirst = () => (document.documentElement.dataset.railFirst === 'eu' ? 'eu' : 'na');
const standingsStatusNA = document.getElementById('standingsStatusNA');
const standingsStatusEU = document.getElementById('standingsStatusEU');
const relinkBanner = document.getElementById('relinkBanner');
const teamsNotice = document.getElementById('teamsNotice');

let wvwMapCache = null;              // { na: {guid: teamId}, eu: {guid: teamId} }
let wvwMapCachedAt = 0;
const guildNameCache = new Map();    // guildId -> { ok, data } | { ok: false, error }
const teamToMatchId = new Map();     // teamId -> matchId
const matchDataCache = new Map();    // matchId -> match object from the API
